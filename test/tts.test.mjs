/**
 * synthesize() 的离线端到端测试。
 *
 * 用一个假的 fetch 和一个假的 WebSocket 把服务端演一遍：
 * ready -> 若干二进制帧 -> finish。这样不用 token、不碰网络，也能把
 * 收帧 / 去重 / 连续性 / ack 口径 / 错误码这几条路径全跑一遍。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthesize } from '../src/tts.mjs';
import { encodeAudioFrame } from '../src/frames.mjs';

// 测试进程里别让环境变量把 token 塞进来
delete process.env.DS_TOKEN;

const TOKEN = 'a'.repeat(64);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假 WebSocket。script 拿到实例之后自己决定发什么。 */
function makeWs(script) {
  const instances = [];
  class FakeWS {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.readyState = 0;
      this.sent = [];
      this.binaryType = 'blob';
      instances.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen({});
        Promise.resolve()
          .then(() => script(this))
          .catch(() => {});
      });
    }

    send(data) {
      this.sent.push(data);
      return true;
    }

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => {
        if (this.onclose) this.onclose({ code: 1000, reason: '', wasClean: true });
      });
    }

    // --- 下面几个是「服务端」动作，测试脚本调 ---
    emitText(obj) {
      if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
    }

    emitRawText(text) {
      if (this.onmessage) this.onmessage({ data: text });
    }

    emitFrame(seq, payload) {
      const bytes = encodeAudioFrame(seq, payload);
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      if (this.onmessage) this.onmessage({ data: copy });
    }

    emitClose(code, reason = '') {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code, reason, wasClean: code === 1000 });
    }

    acks() {
      return this.sent.map((s) => JSON.parse(s)).filter((m) => m.event === 'ack');
    }
  }
  return { FakeWS, instances };
}

/** 假 fetch：只实现取票和切音色两个 POST。 */
function makeFetch({ ticket = 'TICKET-abc', expires = 600, envelopeCode = 0, bizCode = 0 } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });
    let body;
    if (envelopeCode !== 0) {
      body = { code: envelopeCode, msg: 'INVALID_TOKEN', data: null };
    } else if (url.endsWith('/api/v0/chat/tts/voice')) {
      body = { code: 0, msg: '', data: { biz_code: bizCode, biz_msg: bizCode === 0 ? '' : 'no' } };
    } else {
      body = {
        code: 0,
        msg: '',
        data:
          bizCode === 0
            ? { biz_code: 0, biz_msg: '', biz_data: { ticket, expires_in_secs: expires } }
            : { biz_code: bizCode, biz_msg: 'NOT_AVAILABLE', biz_data: null },
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(body),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return { impl, calls };
}

const READY = (over = {}) => ({
  event: 'ready',
  audio_id: 'aud-1',
  format: 'pcm',
  voice_id: 'mira',
  trace_id: 'trace-1',
  ...over,
});

const FINISH_OK = { event: 'finish', code: 0, msg: 'success' };

function pcmChunk(fill, len = 2400) {
  return new Uint8Array(len).fill(fill);
}

test('顺利跑完：收帧、拼装、时长、元数据都对', async () => {
  const a = pcmChunk(0x11);
  const b = pcmChunk(0x22);
  const c = pcmChunk(0x33);

  const { FakeWS, instances } = makeWs(async (ws) => {
    ws.emitText(READY());
    ws.emitFrame(0, a);
    ws.emitFrame(1, b);
    ws.emitFrame(2, c);
    ws.emitText(FINISH_OK);
  });
  const f = makeFetch();

  const res = await synthesize({
    sessionId: 'sess-1',
    messageId: 'msg-1',
    token: TOKEN,
    format: 'pcm',
    fetchImpl: f.impl,
    webSocketImpl: FakeWS,
  });

  assert.equal(res.frameCount, 3);
  assert.equal(res.bytes, 2400 * 3);
  assert.equal(res.firstSeq, 0);
  assert.equal(res.lastSeq, 2);
  assert.deepEqual(res.missingSeqs, []);
  assert.equal(res.contiguous, true);
  assert.equal(res.fullyEmitted, true);
  assert.equal(res.format, 'pcm');
  assert.equal(res.requestedFormat, 'pcm');
  assert.equal(res.voiceId, 'mira');
  assert.equal(res.audioId, 'aud-1');
  assert.equal(res.traceId, 'trace-1');
  assert.equal(res.finish.code, 0);

  // 时长：7200 字节 / 2 = 3600 采样 / 24000 = 0.15s
  assert.equal(res.sampleRate, 24000);
  assert.equal(res.channels, 1);
  assert.equal(res.bitsPerSample, 16);
  assert.equal(res.samples, 3600);
  assert.equal(res.durationSec, 0.15);

  // 内容按 seq 顺序拼，一段一段都对
  assert.equal(res.audio.length, 7200);
  assert.equal(res.audio[0], 0x11);
  assert.equal(res.audio[2400], 0x22);
  assert.equal(res.audio[4800], 0x33);
  assert.equal(res.audio[7199], 0x33);

  // URL 里的票被抹掉了，别漏出去
  assert.ok(res.url.includes('chat_session_id=sess-1'));
  assert.ok(res.url.includes('message_id=msg-1'));
  assert.ok(res.url.includes('mode=manual'));
  assert.ok(res.url.includes('format=pcm'));
  assert.ok(!res.url.includes('TICKET-abc'), 'URL 里不该出现明文 ticket');
  assert.ok(res.url.includes('redacted'));

  // 客户端确实回过 ack 和 finish
  const sent = instances[0].sent.map((s) => JSON.parse(s));
  assert.ok(sent.some((m) => m.event === 'ack'), '应该回过 ack');
  assert.ok(sent.some((m) => m.event === 'finish'), '收到 finish 后应该回一句 finish');
  assert.equal(res.events.length, 2); // ready + finish
});

test('onChunk 拿到的顺序就是 seq 顺序', async () => {
  const { FakeWS } = makeWs(async (ws) => {
    ws.emitText(READY());
    ws.emitFrame(0, new Uint8Array([0x00, 0x00]));
    ws.emitFrame(1, new Uint8Array([0x11, 0x11]));
    ws.emitFrame(2, new Uint8Array([0x22, 0x22]));
    ws.emitText(FINISH_OK);
  });

  const chunks = [];
  await synthesize({
    sessionId: 's',
    messageId: 'm',
    token: TOKEN,
    fetchImpl: makeFetch().impl,
    webSocketImpl: FakeWS,
    onChunk: (chunk) => chunks.push([...chunk]),
  });

  assert.deepEqual(chunks, [[0, 0], [0x11, 0x11], [0x22, 0x22]]);
});

test('重复帧丢掉，计数如实；音频不受影响', async () => {
  const { FakeWS } = makeWs(async (ws) => {
    ws.emitText(READY());
    ws.emitFrame(0, new Uint8Array([0xa0]));
    ws.emitFrame(1, new Uint8Array([0xa1]));
    ws.emitFrame(0, new Uint8Array([0xff])); // 重复
    ws.emitFrame(1, new Uint8Array([0xff])); // 重复
    ws.emitText(FINISH_OK);
  });

  const res = await synthesize({
    sessionId: 's',
    messageId: 'm',
    token: TOKEN,
    fetchImpl: makeFetch().impl,
    webSocketImpl: FakeWS,
  });
  assert.equal(res.frameCount, 2);
  assert.equal(res.duplicates, 2);
  assert.deepEqual([...res.audio], [0xa0, 0xa1]);
});

test('有洞就报错，不交一个错位的音频出去', async () => {
  const { FakeWS } = makeWs(async (ws) => {
    ws.emitText(READY());
    ws.emitFrame(0, new Uint8Array([0x00]));
    ws.emitFrame(2, new Uint8Array([0x22])); // 1 丢了
    ws.emitText(FINISH_OK);
  });

  await assert.rejects(
    synthesize({
      sessionId: 's',
      messageId: 'm',
      token: TOKEN,
      fetchImpl: makeFetch().impl,
      webSocketImpl: FakeWS,
    }),
    (err) => {
      assert.equal(err.kind, 'transport');
      assert.match(err.message, /帧不连续/);
      assert.deepEqual(err.details.result.missingSeqs, [1]);
      return true;
    },
  );
});

test('服务端 finish 带错误码 -> protocol 错误，码和名字都在', async () => {
  const { FakeWS } = makeWs(async (ws) => {
    ws.emitText(READY());
    ws.emitFrame(0, new Uint8Array([0x00]));
    ws.emitText({ event: 'finish', code: 11, msg: 'forbidden' });
  });

  await assert.rejects(
    synthesize({
      sessionId: 's',
      messageId: 'm',
      token: TOKEN,
      fetchImpl: makeFetch().impl,
      webSocketImpl: FakeWS,
    }),
    (err) => {
      assert.equal(err.kind, 'protocol');
      assert.equal(err.code, 11);
      assert.equal(err.codeName, 'FORBIDDEN');
      assert.match(err.message, /FORBIDDEN/);
      return true;
    },
  );
});

test('一帧都没收到就 finish -> 报错，不给空文件', async () => {
  const { FakeWS } = makeWs(async (ws) => {
    ws.emitText(READY());
    ws.emitText(FINISH_OK);
  });

  await assert.rejects(
    synthesize({
      sessionId: 's',
      messageId: 'm',
      token: TOKEN,
      fetchImpl: makeFetch().impl,
      webSocketImpl: FakeWS,
    }),
    (err) => {
      assert.equal(err.kind, 'protocol');
      assert.match(err.message, /一帧音频都没有/);
      return true;
    },
  );
});

test('连接 1006 断掉、零帧 -> 提示 ticket 可能已经用过', async () => {
  const { FakeWS } = makeWs(async (ws) => {
    ws.emitClose(1006, '');
  });

  await assert.rejects(
    synthesize({
      sessionId: 's',
      messageId: 'm',
      token: TOKEN,
      fetchImpl: makeFetch().impl,
      webSocketImpl: FakeWS,
    }),
    (err) => {
      assert.equal(err.kind, 'transport');
      assert.match(err.message, /1006/);
      assert.match(err.message, /一次性/);
      return true;
    },
  );
});

test('服务端把 format 改成别的 -> 听服务端的，并留一条 warning', async () => {
  const { FakeWS } = makeWs(async (ws) => {
    ws.emitText(READY({ format: 'pcm' }));
    ws.emitFrame(0, new Uint8Array([1, 2]));
    ws.emitText(FINISH_OK);
  });

  const res = await synthesize({
    sessionId: 's',
    messageId: 'm',
    token: TOKEN,
    format: 'opus', // 我请求 opus，服务端说给的是 pcm
    fetchImpl: makeFetch().impl,
    webSocketImpl: FakeWS,
  });
  assert.equal(res.requestedFormat, 'opus');
  assert.equal(res.format, 'pcm');
  assert.ok(res.warnings.some((w) => /format/.test(w)));
  // 按 pcm 算出来的时长也在
  assert.equal(res.durationSec, 1 / 24000);
});

test('ackMode=count 时 received_seq 发的是「帧数」（官方口径）', async () => {
  const { FakeWS, instances } = makeWs(async (ws) => {
    ws.emitText(READY());
    for (let i = 0; i < 3; i++) ws.emitFrame(i, pcmChunk(0x10 + i, 2400));
    await sleep(40); // 留点时间让 1s 那个定时器... 这里配了 ackIntervalMs=5
    ws.emitText(FINISH_OK);
  });

  await synthesize({
    sessionId: 's',
    messageId: 'm',
    token: TOKEN,
    fetchImpl: makeFetch().impl,
    webSocketImpl: FakeWS,
    ackMode: 'count',
    ackIntervalMs: 5,
  });

  const acks = instances[0].acks();
  assert.ok(acks.length >= 2, `应该发过多个 ack，实际 ${acks.length}`);
  // 收满 3 帧之后，received_seq 应该是 3（帧数），不是 2（最后一个 seq）
  assert.ok(acks.some((a) => a.received_seq === 3), `ack 里没出现 received_seq=3：${JSON.stringify(acks)}`);
  // played_seq 是 100ms 一格：7200 字节 = 3600 采样 = 1.5 格 -> 1
  assert.ok(acks.some((a) => a.played_seq === 1), `played_seq 应该是 1：${JSON.stringify(acks)}`);
});

test('ackMode=index 时 received_seq 发最后一个 seq（省事口径）', async () => {
  const { FakeWS, instances } = makeWs(async (ws) => {
    ws.emitText(READY());
    for (let i = 0; i < 3; i++) ws.emitFrame(i, pcmChunk(0x10 + i, 2400));
    await sleep(40);
    ws.emitText(FINISH_OK);
  });

  await synthesize({
    sessionId: 's',
    messageId: 'm',
    token: TOKEN,
    fetchImpl: makeFetch().impl,
    webSocketImpl: FakeWS,
    ackMode: 'index',
    ackIntervalMs: 5,
  });

  const acks = instances[0].acks();
  assert.ok(acks.some((a) => a.received_seq === 2), JSON.stringify(acks));
  assert.ok(!acks.some((a) => a.received_seq === 3), 'index 口径不该出现 3');
});

test('没有 token -> auth 错误，文案里说清楚缺什么', async () => {
  await assert.rejects(
    synthesize({ sessionId: 's', messageId: 'm', fetchImpl: makeFetch().impl }),
    (err) => {
      assert.equal(err.kind, 'auth');
      assert.match(err.message, /缺少登录态/);
      assert.match(err.message, /DS_TOKEN/);
      return true;
    },
  );
});

test('token 无效（40003）-> auth 错误，带上服务端原话', async () => {
  await assert.rejects(
    synthesize({
      sessionId: 's',
      messageId: 'm',
      token: TOKEN,
      fetchImpl: makeFetch({ envelopeCode: 40003 }).impl,
      webSocketImpl: makeWs(async () => {}).FakeWS,
    }),
    (err) => {
      assert.equal(err.kind, 'auth');
      assert.match(err.message, /40003|INVALID_TOKEN/);
      return true;
    },
  );
});

test('取票返回 biz_code 9（未放行）-> protocol 错误', async () => {
  await assert.rejects(
    synthesize({
      sessionId: 's',
      messageId: 'm',
      token: TOKEN,
      fetchImpl: makeFetch({ bizCode: 9 }).impl,
      webSocketImpl: makeWs(async () => {}).FakeWS,
    }),
    (err) => {
      assert.equal(err.kind, 'protocol');
      assert.equal(err.code, 9);
      assert.match(err.message, /NOT_AVAILABLE/);
      return true;
    },
  );
});

test('参数不全走 usage 错误，不是 TypeError', async () => {
  await assert.rejects(synthesize({ messageId: 'm', token: TOKEN }), (e) => e.kind === 'usage');
  await assert.rejects(synthesize({ sessionId: 's', token: TOKEN }), (e) => e.kind === 'usage');
  await assert.rejects(
    synthesize({ sessionId: 's', messageId: 'm', token: TOKEN, format: 'mp3' }),
    (e) => e.kind === 'usage' && /format/.test(e.message),
  );
});

test('传了 voice 就先切音色，而且切音色发生在取票之前', async () => {
  const f = makeFetch();
  const { FakeWS } = makeWs(async (ws) => {
    ws.emitText(READY({ voice_id: 'tide' }));
    ws.emitFrame(0, new Uint8Array([1, 2]));
    ws.emitText(FINISH_OK);
  });

  const res = await synthesize({
    sessionId: 's',
    messageId: 'm',
    token: TOKEN,
    voice: 'tide',
    fetchImpl: f.impl,
    webSocketImpl: FakeWS,
  });

  const urls = f.calls.map((c) => c.url);
  assert.equal(urls.length, 2);
  assert.ok(urls[0].endsWith('/api/v0/chat/tts/voice'), `第一次调用应该是切音色：${urls[0]}`);
  assert.ok(urls[1].endsWith('/api/v0/auth/ticket'), `第二次才是取票：${urls[1]}`);
  assert.deepEqual(JSON.parse(f.calls[0].body), { voice_id: 'tide' });
  assert.deepEqual(JSON.parse(f.calls[1].body), { scope: 'tts' });
  assert.equal(res.voiceId, 'tide');

  // Authorization 头得带上
  assert.equal(f.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(f.calls[1].headers.authorization, `Bearer ${TOKEN}`);
});

test('每次建连都重新取票（票是一次性的，两次连就是两张）', async () => {
  const first = makeFetch({ ticket: 'T1' });
  const second = makeFetch({ ticket: 'T2' });

  const script = async (ws) => {
    ws.emitText(READY());
    ws.emitFrame(0, new Uint8Array([1, 2]));
    ws.emitText(FINISH_OK);
  };
  const runOne = makeWs(script);
  const runTwo = makeWs(script);

  await synthesize({
    sessionId: 's',
    messageId: 'm',
    token: TOKEN,
    fetchImpl: first.impl,
    webSocketImpl: runOne.FakeWS,
  });
  await synthesize({
    sessionId: 's',
    messageId: 'm',
    token: TOKEN,
    fetchImpl: second.impl,
    webSocketImpl: runTwo.FakeWS,
  });

  // 两次各取一张票，而且用的是各自那张，没有复用
  assert.equal(first.calls.filter((c) => c.url.endsWith('/auth/ticket')).length, 1);
  assert.equal(second.calls.filter((c) => c.url.endsWith('/auth/ticket')).length, 1);
  assert.ok(runOne.instances[0].url.includes('ticket=T1'));
  assert.ok(runTwo.instances[0].url.includes('ticket=T2'));
  assert.ok(!runTwo.instances[0].url.includes('T1'));
});

test('AbortSignal 能中断，且走的是 abort 事件', async () => {
  const ac = new AbortController();
  const { FakeWS, instances } = makeWs(async (ws) => {
    ws.emitText(READY());
    ws.emitFrame(0, new Uint8Array([1, 2]));
    await sleep(200); // 故意拖着，等测试来 abort
  });

  const p = synthesize({
    sessionId: 's',
    messageId: 'm',
    token: TOKEN,
    fetchImpl: makeFetch().impl,
    webSocketImpl: FakeWS,
    signal: ac.signal,
  });
  await sleep(20);
  ac.abort();

  await assert.rejects(p, (err) => {
    assert.equal(err.name, 'AbortError');
    return true;
  });
  const sent = instances[0].sent.map((s) => JSON.parse(s));
  assert.ok(sent.some((m) => m.event === 'abort'), '应该发过 abort');
});

test('非 JSON 的文本帧只记 warning，不炸', async () => {
  const { FakeWS } = makeWs(async (ws) => {
    ws.emitRawText('this is not json');
    ws.emitText(READY());
    ws.emitFrame(0, new Uint8Array([1, 2]));
    ws.emitText(FINISH_OK);
  });

  const res = await synthesize({
    sessionId: 's',
    messageId: 'm',
    token: TOKEN,
    fetchImpl: makeFetch().impl,
    webSocketImpl: FakeWS,
  });
  assert.ok(res.warnings.some((w) => /非 JSON/.test(w)));
  assert.equal(res.frameCount, 1);
});
