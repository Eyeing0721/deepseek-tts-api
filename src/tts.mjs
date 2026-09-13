/**
 * 合成：取票 -> 建 ws -> 收帧 -> 回 ack -> 拼音频。
 *
 * 服务端行为（2026-09-12 实测 + 从 web-tts.d93cb232e3.js 读出来的状态机）：
 *   1. 连上后先来一个文本帧 ready：{"event":"ready","audio_id":..,"format":..,"voice_id":..,"trace_id":..}
 *   2. 然后一串二进制帧，每帧前 4 字节大端 seq + 负载
 *   3. 最后文本帧 finish：{"event":"finish","code":0,"msg":"success"}
 *   客户端发：
 *   {"event":"ack","received_seq":n,"played_seq":n}   官方是首帧之后每 1000ms 发一次
 *   {"event":"finish"}                                收到服务端 finish 之后回一句
 *   {"event":"abort","reason":..}                     主动中断时
 *
 * 「没有正文参数」这件事见 README —— 读什么由服务端从会话消息里取。
 */

import { PCM, PLAYED_SEQ_UNIT_MS, WS_ENDPOINT, FORMATS } from './constants.mjs';
import { ErrorCode, codeName, protocolError, transportError, usageError } from './errors.mjs';
import { FrameAssembler, buildTtsUrl, parseAudioFrame } from './frames.mjs';
import { assertToken, issueTicket, resolveToken, setVoice as setVoiceApi } from './http.mjs';

const DEFAULT_ORIGIN = 'https://chat.deepseek.com';
const DEFAULT_TIMEOUT_MS = 90_000;

/** 别把票打到日志里。 */
export function redactUrl(url) {
  return String(url).replace(/([?&]ticket=)[^&]*/i, '$1<redacted>');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 收一段朗读音频。
 *
 * @param {object} o
 * @param {string} o.sessionId  会话 id（网页端 URL 里 /a/chat/s/<uuid> 那段）
 * @param {string} o.messageId  要读的那条消息的 id
 * @param {string} [o.token]    userToken；不给就读 DS_TOKEN
 * @param {'pcm'|'opus'} [o.format='pcm']
 * @param {string} [o.voice]    传了就先用它切一次音色（服务端会话级状态）
 * @param {'count'|'index'} [o.ackMode='count']  ack 里 received_seq 的口径，见下方注释
 * @param {number} [o.timeoutMs]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<object>} 见文件末尾 return 处
 */
export async function synthesize({
  sessionId,
  messageId,
  token,
  format = 'pcm',
  voice,
  ackMode = 'count',
  ackIntervalMs = 1000,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  origin = DEFAULT_ORIGIN,
  signal,
  fetchImpl = globalThis.fetch,
  webSocketImpl = globalThis.WebSocket,
  baseUrl,
  endpoint = WS_ENDPOINT,
  onEvent,
  onChunk,
  log = () => {},
} = {}) {
  if (!sessionId) throw usageError('synthesize 缺 sessionId（会话 id）');
  if (!messageId) throw usageError('synthesize 缺 messageId（消息 id）');
  if (!FORMATS.includes(format)) {
    throw usageError(`format 只支持 ${FORMATS.join(' / ')}，收到 "${format}"`);
  }
  if (typeof webSocketImpl !== 'function') {
    throw usageError(
      '当前运行时没有 WebSocket。本包要求 Node >= 22（22 起才有全局 WebSocket），实测在 ' +
        `${process.version} 上可用。`,
    );
  }

  const t = assertToken(resolveToken(token));

  const warnings = [];

  // 切音色是服务端会话级状态，所以必须在取票/建连之前做完。
  if (voice) {
    await setVoiceApi({ voiceId: voice, token: t, signal, fetchImpl, ...(baseUrl ? { baseUrl } : {}) });
  }

  // 票是一次性的，每次建连前现取。
  const ticketInfo = await issueTicket({ token: t, signal, fetchImpl, ...(baseUrl ? { baseUrl } : {}) });

  const url = buildTtsUrl({ endpoint, sessionId, messageId, ticket: ticketInfo.ticket, format });

  const asm = new FrameAssembler();
  const events = [];
  const state = {
    settled: false,
    ready: null,
    finish: null,
    firstFrameAt: null,
    lastError: null,
    closeInfo: null,
    ackCount: 0,
    ackTimer: null,
    ws: null,
  };

  let resolveOut;
  let rejectOut;
  const done = new Promise((res, rej) => {
    resolveOut = res;
    rejectOut = rej;
  });

  const clearAckTimer = () => {
    if (state.ackTimer) {
      clearInterval(state.ackTimer);
      state.ackTimer = null;
    }
  };

  const cleanup = () => {
    clearTimeout(overallTimer);
    clearAckTimer();
    if (signal) signal.removeEventListener('abort', onAbort);
    const ws = state.ws;
    if (ws) {
      try {
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.onopen = null;
        ws.close();
      } catch {
        /* 关不掉就算了，后面有超时兜底 */
      }
    }
  };

  const settle = (err, result) => {
    if (state.settled) return;
    state.settled = true;
    cleanup();
    if (err) {
      if (result) err.details = { ...(err.details ?? {}), result };
      rejectOut(err);
    } else {
      resolveOut(result);
    }
  };

  /** 该往 ack 里填什么。 */
  const currentSeqs = () => {
    if (ackMode === 'index') {
      // 更省事的口径：直接把最后一个 seq 回过去。
      // 2026-09-12 那次探针就是这么发的，能收全帧。官方不是这么发的。
      const last = asm.maxSeq < 0 ? 0 : asm.maxSeq;
      return { received: last, played: last };
    }
    // 官方口径：received_seq 是「收到的帧数」（progress.receivedCount = receivedSeq + 1，
    // receivedSeq 初值 -1，所以 seq 是 0 起的）；played_seq 的单位是 100ms。
    const received = asm.receivedCount;
    let played;
    if (format === 'pcm') {
      const samplesPerUnit = (PCM.sampleRate * PLAYED_SEQ_UNIT_MS) / 1000;
      const samples = Math.floor(asm.receivedBytes / (PCM.bitsPerSample / 8) / PCM.channels);
      played = Math.floor(samples / samplesPerUnit);
    } else {
      // opus 不解码就算不出采样数，只能拿已消费的帧数顶一下。这一支没有实测过。
      played = asm.emittedCount;
    }
    return { received, played };
  };

  const sendJson = (obj) => {
    const ws = state.ws;
    if (!ws || ws.readyState !== 1 /* OPEN */) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (cause) {
      state.lastError = state.lastError ?? cause;
      return false;
    }
  };

  const sendAck = () => {
    const { received, played } = currentSeqs();
    if (sendJson({ event: 'ack', received_seq: received, played_seq: played })) {
      state.ackCount++;
    }
    return { received, played };
  };

  const overallTimer = setTimeout(() => {
    const where = state.ready ? (state.firstFrameAt ? '收完 ready 和部分帧后卡住了' : '等第一帧音频等超了') : '等 ready 等超了';
    settle(
      transportError(
        `合成超时（${timeoutMs}ms，${where}）。已收到 ${asm.receivedCount} 帧 / ${asm.receivedBytes} 字节。`,
      ),
      buildResult(),
    );
  }, timeoutMs);

  function onAbort() {
    sendJson({ event: 'abort', reason: 'user_cancelled' });
    const e = new Error('aborted');
    e.name = 'AbortError';
    settle(e, buildResult());
  }

  if (signal) {
    if (signal.aborted) {
      onAbort();
      return done;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  function buildResult({ requestedFormat = format } = {}) {
    const audit = asm.audit();
    const actualFormat = state.ready?.format ?? requestedFormat;
    if (!audit.fullyEmitted) {
      warnings.push(
        `有 ${audit.pendingSeqs.length} 帧没能按顺序交给 onChunk（seq ${audit.pendingSeqs
          .slice(0, 10)
          .join(', ')}）—— 首帧乱序导致的，最终 buffer 不受影响，但流式消费会少拿这几帧`,
      );
    }
    const result = {
      audio: audit.audio,
      bytes: audit.audio.length,
      format: actualFormat,
      requestedFormat,
      voiceId: state.ready?.voice_id ?? voice ?? null,
      audioId: state.ready?.audio_id ?? null,
      traceId: state.ready?.trace_id ?? null,
      frameCount: audit.receivedCount,
      firstSeq: audit.firstSeq,
      lastSeq: audit.lastSeq,
      missingSeqs: audit.missing,
      duplicates: audit.duplicates,
      outOfOrder: audit.outOfOrder,
      contiguous: audit.contiguous,
      fullyEmitted: audit.fullyEmitted,
      acksSent: state.ackCount,
      events,
      finish: state.finish,
      ticket: { expiresInSecs: ticketInfo.expiresInSecs },
      url: redactUrl(url),
      sessionId,
      messageId,
      warnings,
      closeInfo: state.closeInfo,
    };
    if (actualFormat === 'pcm') {
      const samples = Math.floor(audit.audio.length / (PCM.bitsPerSample / 8) / PCM.channels);
      result.sampleRate = PCM.sampleRate;
      result.channels = PCM.channels;
      result.bitsPerSample = PCM.bitsPerSample;
      result.samples = samples;
      result.durationSec = samples / PCM.sampleRate;
    }
    return result;
  }

  const handleTextFrame = (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      warnings.push(`收到非 JSON 的文本帧：${String(data).slice(0, 120)}`);
      return;
    }
    events.push(msg);
    if (typeof onEvent === 'function') onEvent(msg);

    if (msg.event === 'ready') {
      state.ready = msg;
      if (Object.prototype.hasOwnProperty.call(msg, 'format') && msg.format !== format) {
        warnings.push(`服务端把 format 从 ${format} 改成了 ${msg.format}，按服务端的来`);
      }
      // 官方前端在收到 ready 之后不专门 ack，只在首帧之后每 1s 发一次；
      // 那次能跑通的探针是在 ready 后先补一个 0/0。这里两个都做，反正服务端不挑。
      sendAck();
      return;
    }

    if (msg.event === 'finish') {
      state.finish = msg;
      sendJson({ event: 'finish' });
      const result = buildResult();
      if (msg.code !== ErrorCode.SUCCESS) {
        settle(
          protocolError(
            `服务端 finish 带错误码：code=${msg.code}(${codeName(msg.code)}) msg=${msg.msg ?? ''}`.trim(),
            msg.code,
            { raw: msg },
          ),
          result,
        );
        return;
      }
      if (!result.audio.length) {
        settle(protocolError('合成结束但一帧音频都没有', msg.code, { raw: msg }), result);
        return;
      }
      if (!result.contiguous) {
        // 有洞还硬拼会导致音频错位/杂音，宁可报错也别给个坏文件。
        settle(
          transportError(
            `帧不连续：共 ${result.frameCount} 帧，缺 seq [${result.missingSeqs.slice(0, 20).join(', ')}` +
              `${result.missingSeqs.length > 20 ? ', ...' : ''}]${result.missingSeqs.length ? '' : '（有帧一直没等到）'}`,
          ),
          result,
        );
        return;
      }
      settle(null, result);
      return;
    }
    // 其它 event 不认，记下来就行
  };

  const handleBinaryFrame = async (data) => {
    let buf = data;
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      buf = await data.arrayBuffer();
    }
    let parsed;
    try {
      parsed = parseAudioFrame(buf);
    } catch (err) {
      settle(err, buildResult());
      return;
    }

    const pushed = asm.push(parsed.seq, Buffer.from(parsed.payload));

    if (!state.firstFrameAt) {
      state.firstFrameAt = Date.now();
      state.ackTimer = setInterval(sendAck, ackIntervalMs);
      if (typeof state.ackTimer?.unref === 'function') state.ackTimer.unref();
    }

    if (!pushed.accepted) {
      log(`重复帧 seq=${parsed.seq}，丢掉`);
      return;
    }
    for (const chunk of pushed.emitted) {
      if (typeof onChunk === 'function') onChunk(chunk, { seq: parsed.seq, format: state.ready?.format ?? format });
    }
  };

  // 建连。undici 的 WebSocket 支持第三个参数里塞 headers（非标准扩展），
  // 浏览器那边是不能塞头的（官方前端也是裸 new WebSocket(url)），所以塞不进去也无所谓。
  let ws;
  try {
    ws = origin
      ? new webSocketImpl(url, { headers: { Origin: origin } })
      : new webSocketImpl(url);
  } catch {
    try {
      ws = new webSocketImpl(url);
    } catch (cause) {
      settle(
        transportError(`建 ws 失败（${redactUrl(url)}）：${cause?.message ?? cause}`, { cause }),
      );
      return done;
    }
  }
  state.ws = ws;

  try {
    ws.binaryType = 'arraybuffer';
  } catch {
    /* 有些实现不允许改，那就按它默认的来，binary 分支里两种都兜了 */
  }

  ws.onopen = () => log('ws 已连接');
  ws.onmessage = (ev) => {
    const data = ev?.data;
    if (typeof data === 'string') {
      handleTextFrame(data);
    } else if (data !== undefined && data !== null) {
      handleBinaryFrame(data).catch((err) => settle(err, buildResult()));
    }
  };
  ws.onerror = (ev) => {
    state.lastError = ev?.error ?? ev?.message ?? new Error('websocket error');
  };
  ws.onclose = (ev) => {
    state.closeInfo = { code: ev?.code, reason: ev?.reason, wasClean: ev?.wasClean };
    if (state.settled) return;
    if (state.finish) return; // finish 那条路已经 settle 了，理论上不会走到这
    const got = asm.receivedCount;
    const extra =
      ev?.code === 1006 || got === 0
        ? '。1006 + 零帧最常见的原因是这张 ticket 已经用过一次了（票是一次性的），' +
          '或者服务端没放行这个会话/消息 id'
        : '';
    settle(
      transportError(
        `连接在收到 finish 之前断了：close code=${ev?.code}${ev?.reason ? ` reason=${ev.reason}` : ''}，` +
          `已收到 ${got} 帧 / ${asm.receivedBytes} 字节${extra}` +
          (state.lastError ? `；底层报错：${state.lastError.message ?? state.lastError}` : ''),
        { closeInfo: state.closeInfo },
      ),
      buildResult(),
    );
  };

  return done;
}

/** 小工具：给个会话 id 和消息 id，合成并直接落到 wav / opus 文件上（CLI 用）。 */
export async function synthesizeToWavBuffer(options = {}) {
  const result = await synthesize(options);
  if (result.format !== 'pcm') {
    throw protocolError(
      `想要 wav 但服务端给的是 ${result.format}，WAV 只能从 pcm 封。`,
      ErrorCode.INVALID_INPUT,
    );
  }
  const { pcmToWav } = await import('./wav.mjs');
  return { ...result, wav: pcmToWav(result.audio) };
}

export { sleep };
