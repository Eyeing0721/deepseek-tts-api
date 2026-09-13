/**
 * 帧格式测试：4 字节大端 seq + 负载，以及乱序/重复/缺帧。
 *
 * 官方那段就是 `{seq:new DataView(e).getUint32(0,!1), payload:new Uint8Array(e,4)}`，
 * `false` 就是大端，这个测试就是钉住这一点 —— 大小端搞反了 seq 会变成天文数字或者 0。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FrameAssembler,
  assembleFrames,
  buildTtsUrl,
  encodeAudioFrame,
  parseAudioFrame,
} from '../src/frames.mjs';

test('seq 是大端 uint32，不是小端', () => {
  // 0x01 02 03 04 大端读出来 = 16909060 = 0x01020304
  const frame = Buffer.from([0x01, 0x02, 0x03, 0x04, 0xaa, 0xbb]);
  const { seq, payload } = parseAudioFrame(frame);
  assert.equal(seq, 0x01020304);
  assert.equal(seq, 16909060);
  // 小端会读成 0x04030201，顺手证明一下两种确实不同
  assert.notEqual(seq, 0x04030201);
  assert.deepEqual([...payload], [0xaa, 0xbb]);
});

test('seq = 0 / 1 这两个边界值读得对（官方状态机 receivedSeq 初值 -1，按 0 起算）', () => {
  assert.equal(parseAudioFrame(Buffer.from([0, 0, 0, 0, 9])).seq, 0);
  assert.equal(parseAudioFrame(Buffer.from([0, 0, 0, 1, 9])).seq, 1);
  assert.equal(parseAudioFrame(Buffer.from([0, 0, 1, 0, 9])).seq, 256);
  assert.equal(parseAudioFrame(Buffer.from([0xff, 0xff, 0xff, 0xff, 9])).seq, 4294967295);
});

test('payload 是原 buffer 的视图，不是复制 —— 但长度只到帧尾', () => {
  const frame = Buffer.from([0, 0, 0, 7, 0x11, 0x22, 0x33]);
  const { payload } = parseAudioFrame(frame);
  assert.equal(payload.length, 3);
  assert.deepEqual([...payload], [0x11, 0x22, 0x33]);
});

test('带 offset 的 TypedArray 视图也能正确解析（别把整个底层 buffer 当帧）', () => {
  // 一个大 buffer，真正的帧从偏移 5 开始
  const big = new Uint8Array(20).fill(0xee);
  const frameBytes = encodeAudioFrame(42, new Uint8Array([1, 2, 3]));
  big.set(frameBytes, 5);
  const view = new Uint8Array(big.buffer, 5, frameBytes.length);

  const { seq, payload } = parseAudioFrame(view);
  assert.equal(seq, 42);
  assert.deepEqual([...payload], [1, 2, 3]);
});

test('ArrayBuffer 和 Uint8Array 两种入参结果一致', () => {
  const bytes = encodeAudioFrame(3, new Uint8Array([7, 8]));
  const fromView = parseAudioFrame(bytes);
  const fromAb = parseAudioFrame(bytes.buffer.slice(0));
  assert.equal(fromView.seq, fromAb.seq);
  assert.deepEqual([...fromView.payload], [...fromAb.payload]);
});

test('encodeAudioFrame / parseAudioFrame 来回一致', () => {
  const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const { seq, payload: back } = parseAudioFrame(encodeAudioFrame(123456, payload));
  assert.equal(seq, 123456);
  assert.deepEqual([...back], [...payload]);
});

test('不足 4 字节的帧要报错，不能硬读', () => {
  assert.throws(() => parseAudioFrame(Buffer.from([1, 2, 3])), (err) => {
    assert.equal(err.kind, 'transport');
    assert.match(err.message, /4 字节/);
    return true;
  });
});

test('只有 4 字节（空负载）是合法的，payload 长度 0', () => {
  const { seq, payload } = parseAudioFrame(Buffer.from([0, 0, 0, 5]));
  assert.equal(seq, 5);
  assert.equal(payload.length, 0);
});

test('入参不是二进制就报参数错', () => {
  assert.throws(() => parseAudioFrame('nope'), (err) => {
    assert.equal(err.kind, 'usage');
    return true;
  });
});

test('顺序到达：每帧立刻吐出来，最后没有 pending', () => {
  const asm = new FrameAssembler();
  const a = asm.push(0, Buffer.from([1]));
  const b = asm.push(1, Buffer.from([2]));
  const c = asm.push(2, Buffer.from([3]));
  assert.equal(a.emitted.length, 1);
  assert.equal(b.emitted.length, 1);
  assert.equal(c.emitted.length, 1);
  const audit = asm.audit();
  assert.equal(audit.contiguous, true);
  assert.equal(audit.fullyEmitted, true);
  assert.equal(audit.receivedCount, 3);
  assert.equal(audit.firstSeq, 0);
  assert.equal(audit.lastSeq, 2);
  assert.deepEqual([...audit.audio], [1, 2, 3]);
});

test('乱序到达：最终 buffer 还是按 seq 排好的，晚到的低 seq 会被记账', () => {
  const asm = new FrameAssembler();

  // WebSocket 跑在 TCP 上，正常就是按到达顺序来的，所以第一帧到了就直接吐出去。
  const r0 = asm.push(2, Buffer.from([0x22]));
  assert.deepEqual(r0.emitted.map((b) => b[0]), [0x22]);

  // 然后 0 / 1 才姗姗来迟。吐出去的收不回来，只能挂着并记账。
  const r1 = asm.push(0, Buffer.from([0x00]));
  const r2 = asm.push(1, Buffer.from([0x11]));
  assert.equal(r1.emitted.length, 0);
  assert.equal(r2.emitted.length, 0);

  const audit = asm.audit();
  // 关键性质：集合是 {0,1,2}，没有洞，所以按 seq 排序拼出来的音频是对的
  assert.equal(audit.contiguous, true);
  assert.deepEqual([...audit.audio], [0x00, 0x11, 0x22]);
  assert.equal(audit.outOfOrder, 2); // 0 和 1 都是迟到帧
  assert.equal(audit.fullyEmitted, false); // 但流式那路少吐了两帧，如实报告
  assert.deepEqual(audit.pendingSeqs, [0, 1]);
  assert.equal(audit.receivedCount, 3);
});

test('重复帧被丢掉，且不影响拼出来的音频', () => {
  const asm = new FrameAssembler();
  asm.push(0, Buffer.from([0xa0]));
  asm.push(1, Buffer.from([0xa1]));
  const dup0 = asm.push(0, Buffer.from([0xff]));
  const dup1 = asm.push(1, Buffer.from([0xff]));
  assert.equal(dup0.accepted, false);
  assert.equal(dup0.reason, 'duplicate');
  assert.equal(dup1.accepted, false);

  const audit = asm.audit();
  assert.equal(audit.duplicates, 2);
  assert.equal(audit.receivedCount, 2);
  assert.deepEqual([...audit.audio], [0xa0, 0xa1]);
});

test('缺帧：missing 里点名缺了谁，contiguous 为 false', () => {
  const asm = new FrameAssembler();
  asm.push(0, Buffer.from([0]));
  asm.push(1, Buffer.from([1]));
  asm.push(4, Buffer.from([4]));
  asm.push(5, Buffer.from([5]));
  asm.push(9, Buffer.from([9]));
  const audit = asm.audit();
  assert.deepEqual(audit.missing, [2, 3, 6, 7, 8]);
  assert.equal(audit.contiguous, false);
  // 就算有洞，拼出来的字节也还是按 seq 排的（调用方自己看 contiguous 决定要不要用）
  assert.deepEqual([...audit.audio], [0, 1, 4, 5, 9]);
});

test('起始 seq 不是 0 也能过：基准就是第一帧', () => {
  const asm = new FrameAssembler();
  asm.push(7, Buffer.from([7]));
  asm.push(8, Buffer.from([8]));
  const audit = asm.audit();
  assert.equal(audit.contiguous, true);
  assert.equal(audit.firstSeq, 7);
  assert.equal(audit.lastSeq, 8);
});

test('中间有洞时，后来补上的帧会跟着前一段一起吐出来', () => {
  const asm = new FrameAssembler();
  assert.equal(asm.push(0, Buffer.from([0x00])).emitted.length, 1);
  assert.equal(asm.push(2, Buffer.from([0x22])).emitted.length, 0); // 1 还没来，先压着
  const r = asm.push(1, Buffer.from([0x11])); // 洞一填上，1 和 2 一起出来
  assert.deepEqual(r.emitted.map((b) => b[0]), [0x11, 0x22]);
  const audit = asm.audit();
  assert.equal(audit.contiguous, true);
  assert.equal(audit.fullyEmitted, true);
  assert.equal(audit.outOfOrder, 1); // 只有 1 算迟到
});

test('assembleFrames 是个方便入口', () => {
  const audit = assembleFrames([
    { seq: 0, payload: Buffer.from([1, 1]) },
    { seq: 1, payload: Buffer.from([2, 2]) },
  ]);
  assert.equal(audit.receivedCount, 2);
  assert.equal(audit.audio.length, 4);
  assert.deepEqual([...audit.audio], [1, 1, 2, 2]);
});

test('空帧集合不炸', () => {
  const audit = assembleFrames([]);
  assert.equal(audit.audio.length, 0);
  assert.equal(audit.receivedCount, 0);
  assert.equal(audit.firstSeq, null);
  assert.equal(audit.contiguous, true);
});

test('非法 seq（负数/小数/字符串）直接抛', () => {
  const asm = new FrameAssembler();
  assert.throws(() => asm.push(-1, Buffer.from([0])), /非法 seq/);
  assert.throws(() => asm.push(1.5, Buffer.from([0])), /非法 seq/);
  assert.throws(() => asm.push('1', Buffer.from([0])), /非法 seq/);
});

test('buildTtsUrl 拼出来的 query 跟官方一致，且顺序稳定', () => {
  const url = buildTtsUrl({
    sessionId: 'sess-1',
    messageId: 'msg-2',
    ticket: 'TICKET',
    format: 'pcm',
  });
  assert.ok(url.startsWith('wss://chat.deepseek.com/api/v0/chat/tts/?'));
  const qs = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  assert.equal(qs.get('chat_session_id'), 'sess-1');
  assert.equal(qs.get('message_id'), 'msg-2');
  assert.equal(qs.get('ticket'), 'TICKET');
  assert.equal(qs.get('mode'), 'manual'); // 网页端恒定
  assert.equal(qs.get('format'), 'pcm');
  // 没续传参数时不该出现这三个
  assert.equal(qs.get('audio_id'), null);
  assert.equal(qs.get('received_seq'), null);
  assert.equal(qs.get('played_seq'), null);
});

test('buildTtsUrl 带续传参数时补上 audio_id / received_seq / played_seq', () => {
  const url = buildTtsUrl({
    sessionId: 's',
    messageId: 'm',
    ticket: 't',
    format: 'opus',
    resume: { audioId: 'aud-1', receivedSeq: 7, playedSeq: 3 },
  });
  const qs = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  assert.equal(qs.get('audio_id'), 'aud-1');
  assert.equal(qs.get('received_seq'), '7');
  assert.equal(qs.get('played_seq'), '3');
  assert.equal(qs.get('format'), 'opus');
});

test('buildTtsUrl 缺东西时给的是 usage 错误，不是 TypeError', () => {
  assert.throws(() => buildTtsUrl({ messageId: 'm', ticket: 't' }), (err) => {
    assert.equal(err.kind, 'usage');
    assert.match(err.message, /sessionId/);
    return true;
  });
  assert.throws(() => buildTtsUrl({ sessionId: 's', ticket: 't' }), /messageId/);
  assert.throws(() => buildTtsUrl({ sessionId: 's', messageId: 'm' }), /ticket/);
});
