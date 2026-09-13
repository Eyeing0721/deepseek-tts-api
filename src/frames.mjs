/**
 * ws 二进制帧的解析与拼装，以及 ws URL 的拼法。
 *
 * 官方实现（main.js）就两行：
 *   function parseFrame(e) { return { seq: new DataView(e).getUint32(0, false), payload: new Uint8Array(e, 4) } }
 *   function buildUrl(endpoint, streamParams, opts, resume) { ... URLSearchParams ... }
 * 这里把它原样搬过来，另外加了「乱序 / 重复 / 缺帧」的处理，因为网络这层不能假定有序。
 */

import { FRAME_HEADER_BYTES, WS_ENDPOINT, WS_MODE } from './constants.mjs';
import { transportError, usageError } from './errors.mjs';

/** 把各种二进制输入统一看成「一段有 offset/length 的字节」。 */
function asByteView(input) {
  if (input instanceof ArrayBuffer) {
    return { buffer: input, byteOffset: 0, byteLength: input.byteLength };
  }
  if (ArrayBuffer.isView(input)) {
    return { buffer: input.buffer, byteOffset: input.byteOffset, byteLength: input.byteLength };
  }
  throw usageError('帧数据必须是 ArrayBuffer 或 TypedArray，收到了 ' + typeof input);
}

/**
 * 解析一个服务端二进制帧：4 字节大端 seq + 负载。
 * 返回的 payload 是原 buffer 的一个视图（不复制），要留住就自己 copy。
 */
export function parseAudioFrame(input) {
  const view = asByteView(input);
  if (view.byteLength < FRAME_HEADER_BYTES) {
    throw transportError(
      `二进制帧只有 ${view.byteLength} 字节，连 4 字节的 seq 头都不够`,
    );
  }
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const seq = dv.getUint32(0, false); // 大端
  const payload = new Uint8Array(view.buffer, view.byteOffset + FRAME_HEADER_BYTES, view.byteLength - FRAME_HEADER_BYTES);
  return { seq, payload };
}

/** 反过来：给一段负载加上 seq 头（测试和造假帧用）。 */
export function encodeAudioFrame(seq, payload) {
  const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const out = new Uint8Array(FRAME_HEADER_BYTES + body.length);
  new DataView(out.buffer).setUint32(0, seq >>> 0, false);
  out.set(body, FRAME_HEADER_BYTES);
  return out;
}

/**
 * 拼 ws 地址。
 *
 * 官方那段函数的参数顺序：endpoint, streamParams(会话/消息), {ticket, mode, format},
 * 可选的 resume{audio_id, received_seq, played_seq}。resume 三个参数只在断线续传时带上。
 */
export function buildTtsUrl({
  endpoint = WS_ENDPOINT,
  sessionId,
  messageId,
  ticket,
  mode = WS_MODE,
  format = 'pcm',
  resume,
} = {}) {
  if (!sessionId) throw usageError('buildTtsUrl 缺 sessionId');
  if (!messageId) throw usageError('buildTtsUrl 缺 messageId');
  if (!ticket) throw usageError('buildTtsUrl 缺 ticket');

  const qs = new URLSearchParams();
  qs.set('chat_session_id', String(sessionId));
  qs.set('message_id', String(messageId));
  qs.set('ticket', String(ticket));
  qs.set('mode', mode);
  qs.set('format', format);

  if (resume) {
    qs.set('audio_id', String(resume.audioId));
    qs.set('received_seq', String(resume.receivedSeq));
    qs.set('played_seq', String(resume.playedSeq));
  }

  const sep = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${sep}${qs.toString()}`;
}

/**
 * 收帧器：去重、容忍乱序、按 seq 顺序往外吐。
 *
 * seq 从几开始？官方状态机里 `receivedSeq` 初值是 -1、`receivedCount = receivedSeq + 1`，
 * 也就是它按 0 开始计数。所以正常流是 0,1,2,...。不过这里不写死起点：第一帧的 seq 就是基准，
 * 后面必须严格 +1，这样起点是 0 还是 1 都能过（真实起点我们没能拿到线上抓包确认，见 VERIFY.md）。
 *
 * 往外吐（onChunk）的前提是「到达顺序 = seq 顺序」。WebSocket 跑在 TCP 上，本来就是有序的，
 * 所以第一帧一到就直接吐。万一真有迟到帧，它会被压住并记进 outOfOrder / pendingSeqs，
 * 不影响最终拼装 —— 最终拼装是拿 frames 这个 map 按 seq 排序做的，跟到达顺序无关。
 */
export class FrameAssembler {
  #baseline = null;
  #emitNext = null;

  constructor() {
    /** 见过的所有帧：seq -> Buffer（最终拼装用这个） */
    this.frames = new Map();
    /** 还没按顺序吐出去的帧 */
    this.pending = new Map();
    /** 重复帧计数（seq 已经见过） */
    this.duplicates = 0;
    /** 迟到帧计数（seq 比已见过的最大 seq 还小） */
    this.outOfOrder = 0;
    /** 已经按顺序吐出去的帧数 */
    this.emittedCount = 0;
    this.maxSeq = -1;
    this.minSeq = null;
  }

  /** 收到的不同帧总数。对应官方 progress.receivedCount —— ack 里发的就是这个。 */
  get receivedCount() {
    return this.frames.size;
  }

  /** 拼起来的字节数。 */
  get receivedBytes() {
    let n = 0;
    for (const b of this.frames.values()) n += b.length;
    return n;
  }

  /**
   * 塞一帧进来。
   * 返回 { accepted, reason, emitted }：emitted 是这次「顺序被打通」之后能连续吐出来的负载数组。
   */
  push(seq, payload) {
    if (!Number.isInteger(seq) || seq < 0) {
      throw transportError(`非法 seq: ${String(seq)}`);
    }
    if (this.maxSeq >= 0 && seq < this.maxSeq) this.outOfOrder++;

    if (this.frames.has(seq)) {
      this.duplicates++;
      return { accepted: false, reason: 'duplicate', emitted: [] };
    }

    const buf = Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(payload.buffer ?? payload, payload.byteOffset ?? 0, payload.byteLength ?? payload.length);

    this.frames.set(seq, buf);
    this.pending.set(seq, buf);

    if (this.#baseline === null) {
      this.#baseline = seq;
      this.#emitNext = seq;
    } else if (this.emittedCount === 0 && seq < this.#baseline) {
      // 还没往外吐过任何东西，那就把基准往前挪一下，别把先到的后帧当成起点。
      this.#baseline = seq;
      this.#emitNext = seq;
    }

    if (seq > this.maxSeq) this.maxSeq = seq;
    if (this.minSeq === null || seq < this.minSeq) this.minSeq = seq;

    const emitted = [];
    while (this.pending.has(this.#emitNext)) {
      emitted.push(this.pending.get(this.#emitNext));
      this.pending.delete(this.#emitNext);
      this.#emitNext++;
      this.emittedCount++;
    }

    return { accepted: true, reason: null, emitted };
  }

  /** 按 seq 升序拼成完整音频。不检查连续性 —— 检查用 audit()。 */
  assemble() {
    const seqs = [...this.frames.keys()].sort((a, b) => a - b);
    let total = 0;
    for (const s of seqs) total += this.frames.get(s).length;
    const audio = Buffer.allocUnsafe(total);
    let off = 0;
    for (const s of seqs) {
      const b = this.frames.get(s);
      b.copy(audio, off);
      off += b.length;
    }
    return { audio, seqs };
  }

  /**
   * 连续性审计。
   *
   * contiguous 说的是「收到的 seq 集合有没有洞」—— 这才决定拼出来的音频对不对。
   * fullyEmitted 说的是「每一帧都按顺序交给 onChunk 了吗」—— 只有首帧乱序到把基准定错时才会是 false，
   * 这种情况下最终 buffer 仍然是对的，但流式消费的调用方可能少拿了几帧。
   */
  audit() {
    const { audio, seqs } = this.assemble();
    const missing = [];
    for (let i = 1; i < seqs.length; i++) {
      if (seqs[i] !== seqs[i - 1] + 1) {
        for (let s = seqs[i - 1] + 1; s < seqs[i]; s++) missing.push(s);
      }
    }
    return {
      audio,
      seqs,
      missing,
      duplicates: this.duplicates,
      outOfOrder: this.outOfOrder,
      receivedCount: this.frames.size,
      emittedCount: this.emittedCount,
      contiguous: missing.length === 0,
      fullyEmitted: this.pending.size === 0,
      pendingSeqs: [...this.pending.keys()].sort((a, b) => a - b),
      firstSeq: seqs.length ? seqs[0] : null,
      lastSeq: seqs.length ? seqs[seqs.length - 1] : null,
    };
  }
}

/** 一次性把一组 {seq, payload} 拼起来（给测试和离线分析用）。 */
export function assembleFrames(entries) {
  const asm = new FrameAssembler();
  for (const e of entries) asm.push(e.seq, e.payload);
  return asm.audit();
}
