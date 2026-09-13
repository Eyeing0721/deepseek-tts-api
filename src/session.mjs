/**
 * 「现场造一个一次性会话 + 消息」。
 *
 * 为什么需要这个：TTS 的合成请求里只有 chat_session_id + message_id，没有正文。
 * 想让服务端念任意文本，就得先把那段文字变成你会话里的一条消息。这个模块就是干这个的，
 * 用完把会话删掉，不留痕。
 *
 * 流程：
 *   1. POST /api/v0/chat_session/create            -> chat_session.id
 *   2. POST /api/v0/chat/create_pow_challenge      -> challenge（必须解，见 pow.mjs）
 *   3. POST /api/v0/chat/completion                -> 把文本作为一条用户消息发进去（SSE 流）
 *   4. GET  /api/v0/chat/history_messages          -> 找到那条消息的 message_id
 *   5. 交给 synthesize() 去念
 *   6. POST /api/v0/chat_session/delete            -> 删掉会话
 *
 * 两种取 id 的路子：
 *   - via='user'  只等我们自己发的那条用户消息落库，然后就把生成掐掉。便宜、而且念的就是原文。
 *   - via='reply' 等模型把话说完，拿回复那条。念的是模型复述出来的东西，可能不完全一致。
 * 哪种真能念，得拿真账号试（见 VERIFY.md 里没验证的部分）。
 */

import { ENDPOINTS, HTTP_BASE } from './constants.mjs';
import {
  DeepSeekTtsError,
  ErrorCode,
  protocolError,
  transportError,
  usageError,
} from './errors.mjs';
import { assertToken, jsonHeaders } from './http.mjs';
import { POW_TARGET_COMPLETION, obtainPowHeader } from './pow.mjs';
import { redactUrl, synthesize } from './tts.mjs';

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 700;

/** 让模型复述而不是自由发挥。 */
export function buildRepeatPrompt(text) {
  return (
    '请把下面这段文字原样输出一遍，不要翻译、不要总结、不要解释、' +
    '不要加引号或任何前后缀，一个字都不要改：\n\n' +
    text
  );
}

/** 建一个空会话。 */
export async function createSession({
  token,
  signal,
  fetchImpl = globalThis.fetch,
  baseUrl = HTTP_BASE,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const t = assertToken(token);
  const url = `${baseUrl}${ENDPOINTS.sessionCreate}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const composite = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: jsonHeaders(t),
      body: JSON.stringify({}),
      signal: composite,
    });
  } catch (cause) {
    if (cause?.name === 'AbortError') {
      if (signal?.aborted) throw cause;
      throw transportError(`建会话超时（${timeoutMs}ms）`);
    }
    throw transportError(`建会话失败：${cause?.message ?? cause}`, { cause });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw protocolError(`建会话返回的不是 JSON（HTTP ${res.status}）`, undefined, {
      status: res.status,
      body: text.slice(0, 400),
    });
  }
  const data = json?.data ?? {};
  const biz = data?.biz_data ?? {};
  if (json.code !== 0 || data.biz_code !== 0) {
    throw new DeepSeekTtsError(
      `建会话被拒：code=${json.code} biz_code=${data.biz_code} ${data.biz_msg ?? json.msg ?? ''}`.trim(),
      { kind: 'protocol', code: data.biz_code ?? json.code, details: json },
    );
  }
  // 实测（2026-09-14，真账号）响应是 data.biz_data.id，不是 chat_session.id。
  // 两种都认：官方前端不同版本包过一层。
  const id = biz?.id ?? biz?.chat_session?.id;
  if (!id) {
    throw protocolError('建会话返回里没找到会话 id（试过 biz_data.id 和 biz_data.chat_session.id）',
      undefined, { raw: json });
  }
  return { id, title: biz?.title ?? biz?.chat_session?.title ?? null, raw: json };
}

/** 删会话。失败不抛，返回 false —— 清理失败不该把主流程搞崩。 */
export async function deleteSession({
  sessionIds,
  token,
  signal,
  fetchImpl = globalThis.fetch,
  baseUrl = HTTP_BASE,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const t = assertToken(token);
  const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds];
  if (!ids.length || ids.some((i) => !i)) throw usageError('deleteSession 需要至少一个 sessionId');
  const url = `${baseUrl}${ENDPOINTS.sessionDelete}`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: jsonHeaders(t),
      body: JSON.stringify({ chat_session_ids: ids }),
      signal,
    });
    const json = JSON.parse(await res.text());
    const bizCode = json?.data?.biz_code;
    return { ok: bizCode === 0, bizCode, raw: json };
  } catch (cause) {
    return { ok: false, bizCode: undefined, error: cause?.message ?? String(cause) };
  }
}

/** 拉会话消息列表。 */
export async function fetchMessages({
  sessionId,
  token,
  signal,
  fetchImpl = globalThis.fetch,
  baseUrl = HTTP_BASE,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const t = assertToken(token);
  if (!sessionId) throw usageError('fetchMessages 需要 sessionId');
  const url = `${baseUrl}${ENDPOINTS.historyMessages}?chat_session_id=${encodeURIComponent(sessionId)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const composite = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', headers: jsonHeaders(t), signal: composite });
  } catch (cause) {
    if (cause?.name === 'AbortError') {
      if (signal?.aborted) throw cause;
      throw transportError(`拉消息列表超时（${timeoutMs}ms）`);
    }
    throw transportError(`拉消息列表失败：${cause?.message ?? cause}`, { cause });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw protocolError(`拉消息列表返回的不是 JSON（HTTP ${res.status}）`, undefined, {
      status: res.status,
      body: text.slice(0, 400),
    });
  }
  const data = json?.data ?? {};
  if (json.code !== 0 || data.biz_code !== 0) {
    throw new DeepSeekTtsError(
      `拉消息列表被拒：code=${json.code} biz_code=${data.biz_code} ${data.biz_msg ?? ''}`.trim(),
      { kind: 'protocol', code: data.biz_code ?? json.code, details: json },
    );
  }
  const messages = data?.biz_data?.chat_messages;
  if (!Array.isArray(messages)) {
    throw protocolError('history_messages 返回里没有 biz_data.chat_messages 数组', undefined, { raw: json });
  }
  return { messages, cacheControl: data.biz_data.cache_control ?? null, raw: json };
}

/** 取消息的正文（服务端一般是 string，但别假定）。 */
export function messageText(m) {
  const c = m?.content ?? m?.text;
  if (typeof c === 'string') return c;
  if (c === null || c === undefined) return '';
  return JSON.stringify(c);
}

/**
 * 认「是不是用户消息」。
 *
 * role 的枚举值我们没拿到（main.js 里是 `MessageRole.ASSISTANT ? ASSISTANT : USER` 这种写法，
 * 具体数字没记），所以这里不依赖它：字符串 role 就直接看，数字/缺失就退回「正文等于我发的内容」。
 * 新会话里只有两条消息，这个判据足够稳。
 */
export function isUserMessage(m, prompt) {
  const role = m?.role;
  if (typeof role === 'string') {
    const r = role.toLowerCase();
    if (r.includes('assistant')) return false;
    if (r.includes('user')) return true;
  }
  if (typeof role === 'number') {
    // 只知道 AI 是 ASSISTANT；如果两条消息 role 不同，用户那条就是小的那个……不确定，
    // 所以数字 role 一律走正文比对，别猜。
  }
  return prompt !== undefined && messageText(m).trim() === String(prompt).trim();
}

/** 从消息列表里挑出我们要的那条。 */
export function pickMessage(messages, { prompt, want }) {
  const list = messages.filter((m) => m && (m.message_id || m.id));
  const wanted = String(prompt ?? '').trim();
  if (want === 'user') {
    // 优先「正文恰好等于我发的内容」，这条最稳，不依赖 role 枚举。
    const exact = list.find((m) => messageText(m).trim() === wanted);
    if (exact) return exact;
    // 退一步：role 是字符串的话按 role 认
    return list.find((m) => isUserMessage(m, prompt)) ?? null;
  }
  // want === 'reply'：正文非空、且不是我们发的那条
  const replies = list.filter((m) => {
    const txt = messageText(m).trim();
    return txt.length > 0 && txt !== wanted;
  });
  return replies.length ? replies[replies.length - 1] : null;
}

export function messageIdOf(m) {
  return m?.message_id ?? m?.id ?? null;
}

/** POST completion。返回未读的 Response，调用方自己决定drain 还是 abort。 */
export async function postCompletion({
  sessionId,
  prompt,
  powHeader,
  token,
  signal,
  fetchImpl = globalThis.fetch,
  baseUrl = HTTP_BASE,
  modelType = null,
  thinkingEnabled = false,
  searchEnabled = false,
  extraHeaders = {},
} = {}) {
  const t = assertToken(token);
  if (!sessionId) throw usageError('postCompletion 需要 sessionId');
  if (typeof prompt !== 'string' || !prompt) throw usageError('postCompletion 需要非空 prompt');
  if (!powHeader) throw usageError('postCompletion 需要 powHeader（completion 不接受没有 PoW 的请求）');

  const body = {
    chat_session_id: sessionId,
    parent_message_id: null,
    model_type: modelType,
    prompt,
    ref_file_ids: [],
    thinking_enabled: thinkingEnabled,
    search_enabled: searchEnabled,
    source: null,
    action: null,
    preempt: false,
  };

  const headers = {
    ...jsonHeaders(t),
    accept: 'text/event-stream',
    [powHeader[0]]: powHeader[1],
    ...extraHeaders,
  };

  const url = `${baseUrl}${ENDPOINTS.completion}`;
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw transportError(`发 completion 失败：${cause?.message ?? cause}`, { cause });
  }
}

/** 把 SSE 流读干（读到结束就说明生成完了）。 */
export async function drainSse(res, { onChunk, maxBytes = 8 * 1024 * 1024 } = {}) {
  const out = { bytes: 0, chunks: 0, text: '', truncated: false, error: null };
  if (!res?.body) return out;
  try {
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      out.bytes += chunk.byteLength;
      out.chunks++;
      if (out.text.length < 200_000) out.text += decoder.decode(chunk, { stream: true });
      if (onChunk) onChunk(chunk);
      if (out.bytes > maxBytes) {
        out.truncated = true;
        break;
      }
    }
  } catch (cause) {
    if (cause?.name === 'AbortError') return out;
    out.error = cause?.message ?? String(cause);
  }
  return out;
}

/**
 * 把一段文本塞进一个新会话，返回它的 sessionId / messageId。
 * 调用方负责之后删会话（say() 会删）。
 */
export async function putText({
  text,
  via = 'user',
  token,
  signal,
  fetchImpl = globalThis.fetch,
  baseUrl = HTTP_BASE,
  waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
  maxIterations,
  extraHeaders = {},
  keepOnError = false,
  onProgress = () => {},
} = {}) {
  const t = assertToken(token);
  if (typeof text !== 'string' || !text.trim()) throw usageError('putText 需要非空 text');
  if (!['user', 'reply'].includes(via)) {
    throw usageError(`via 只支持 'user' / 'reply'，收到 "${via}"`);
  }

  const prompt = via === 'reply' ? buildRepeatPrompt(text) : text;
  const session = await createSession({ token: t, signal, fetchImpl, baseUrl });
  const sessionId = session.id;
  onProgress({ step: 'session', sessionId });

  let aborted = false;
  const ac = new AbortController();
  const composite = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;

  const cleanupAbort = () => {
    if (!aborted) {
      aborted = true;
      ac.abort();
    }
  };

  try {
    onProgress({ step: 'pow' });
    const pow = await obtainPowHeader({
      targetPath: POW_TARGET_COMPLETION,
      token: t,
      signal: composite,
      fetchImpl,
      baseUrl,
      ...(maxIterations ? { maxIterations } : {}),
    });
    onProgress({ step: 'pow-done', answer: pow.answer, solveMs: pow.solveMs, totalMs: pow.totalMs });

    onProgress({ step: 'completion' });
    const res = await postCompletion({
      sessionId,
      prompt,
      powHeader: pow.header,
      token: t,
      signal: composite,
      fetchImpl,
      baseUrl,
      extraHeaders,
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw protocolError(
        `completion 返回 HTTP ${res.status}：${bodyText.slice(0, 300)}`,
        undefined,
        { status: res.status },
      );
    }

    // 后台把流读着，别让连接闲着；via=user 时等我们自己那条消息落库就把流掐了。
    const drainPromise = drainSse(res, {});

    const deadline = Date.now() + waitTimeoutMs;
    let picked = null;
    let lastSeen = [];
    while (Date.now() < deadline) {
      const { messages } = await fetchMessages({ sessionId, token: t, signal, fetchImpl, baseUrl });
      lastSeen = messages.map((m) => ({
        id: messageIdOf(m),
        role: m?.role,
        len: messageText(m).length,
        parent: m?.parent_id ?? null,
      }));
      picked = pickMessage(messages, { prompt, want: via });
      if (picked) {
        if (via === 'user') break;
        // reply：还要等它别长了
        const textNow = messageText(picked).trim();
        if (textNow) {
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          const again = await fetchMessages({ sessionId, token: t, signal, fetchImpl, baseUrl });
          const picked2 = pickMessage(again.messages, { prompt, want: 'reply' });
          if (picked2 && messageText(picked2).trim() === textNow) {
            picked = picked2;
            break;
          }
          picked = picked2 ?? picked;
          continue;
        }
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    if (!picked) {
      cleanupAbort();
      await drainPromise;
      throw transportError(
        `等了 ${waitTimeoutMs}ms 也没在会话 ${sessionId} 里等到${via === 'user' ? '我们发的那条用户消息' : '模型的回复'}。` +
          `会话里现在有 ${lastSeen.length} 条：${JSON.stringify(lastSeen)}`,
        { sessionId, messages: lastSeen },
      );
    }

    const messageId = messageIdOf(picked);
    if (!messageId) {
      throw protocolError('选中的消息没有 message_id（也没 id），字段名可能变了', undefined, {
        message: picked,
      });
    }

    if (via === 'user') {
      // 已经拿到要念的东西，把后面的生成掐了，省钱省时间
      cleanupAbort();
      await drainPromise;
      onProgress({ step: 'message', messageId, stopped: true });
    } else {
      const drained = await drainPromise;
      onProgress({ step: 'message', messageId, streamBytes: drained.bytes, streamError: drained.error });
    }

    return {
      sessionId,
      messageId,
      via,
      prompt,
      text,
      content: messageText(picked),
      pow: { answer: pow.answer, solveMs: pow.solveMs, iterations: pow.iterations },
    };
  } catch (err) {
    cleanupAbort();
    // 会话是我们建的，失败了就得我们负责收尸，不然每失败一次就多留一个空会话。
    if (!keepOnError) {
      const del = await deleteSession({ sessionIds: sessionId, token: t, fetchImpl, ...(baseUrl ? { baseUrl } : {}) });
      if (del.ok) {
        err.cleanedUp = true;
      } else {
        err.cleanedUp = false;
        err.cleanupError = del.error ?? `biz_code=${del.bizCode}`;
      }
    }
    throw err;
  }
}

/**
 * 一条龙：造会话 -> 塞文本 -> 合成 -> 删会话。
 *
 * via='auto' 时先试 'user'（念的就是原文、还便宜），失败再换 'reply' 重来一遍。
 */
export async function say({
  text,
  via = 'auto',
  format = 'pcm',
  voice,
  token,
  keepSession = false,
  signal,
  fetchImpl = globalThis.fetch,
  webSocketImpl = globalThis.WebSocket,
  baseUrl,
  wsEndpoint,
  maxIterations,
  waitTimeoutMs,
  ackMode,
  onProgress = () => {},
  log = () => {},
} = {}) {
  const t = assertToken(token);
  const ttsOptions = {
    format,
    token: t,
    fetchImpl,
    webSocketImpl,
    log,
    ...(voice ? { voice } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(wsEndpoint ? { endpoint: wsEndpoint } : {}),
    ...(ackMode ? { ackMode } : {}),
  };

  const attempts = via === 'auto' ? ['user', 'reply'] : [via];
  const problems = [];
  let lastSession = null;

  try {
    for (let i = 0; i < attempts.length; i++) {
      const mode = attempts[i];
      let placed = null;
      try {
        placed = await putText({
          text,
          via: mode,
          token: t,
          signal,
          fetchImpl,
          ...(baseUrl ? { baseUrl } : {}),
          ...(waitTimeoutMs ? { waitTimeoutMs } : {}),
          ...(maxIterations ? { maxIterations } : {}),
          onProgress,
        });
      } catch (err) {
        problems.push({ via: mode, stage: 'putText', error: err?.message ?? String(err) });
        if (i === attempts.length - 1) break;
        log(`via=${mode} 塞消息失败：${err?.message ?? err}；换 ${attempts[i + 1]} 再来`);
        continue;
      }

      lastSession = placed.sessionId;
      try {
        const result = await synthesize({
          sessionId: placed.sessionId,
          messageId: placed.messageId,
          ...ttsOptions,
        });
        return {
          ...result,
          scratch: {
            via: mode,
            sessionId: placed.sessionId,
            messageId: placed.messageId,
            prompt: placed.prompt,
            content: placed.content,
            pow: placed.pow,
            attempts: i + 1,
            problems,
            kept: keepSession,
          },
        };
      } catch (err) {
        problems.push({ via: mode, stage: 'tts', error: err?.message ?? String(err), code: err?.code });
        const retriable = err?.code === ErrorCode.NO_CONTENT || err?.code === ErrorCode.INVALID_INPUT;
        if (i === attempts.length - 1 || (via !== 'auto' && !retriable)) {
          // 换会话重试没意义了，把错抛出去
          err.problems = problems;
          err.scratch = { sessionId: placed.sessionId, messageId: placed.messageId, via: mode };
          throw err;
        }
        log(
          `via=${mode} 合成被拒（code=${err?.code}）——` +
            `${mode === 'user' ? '看来说的用户消息不能直接念' : ''}换 ${attempts[i + 1]} 再来`,
        );
        // 这个会话不要了，删掉再换下一种
        if (!keepSession) {
          await deleteSession({ sessionIds: placed.sessionId, token: t, fetchImpl, ...(baseUrl ? { baseUrl } : {}) });
          if (lastSession === placed.sessionId) lastSession = null;
        }
      }
    }

    const summary = problems.map((p) => `${p.via}/${p.stage}: ${p.error}`).join(' | ');
    throw new DeepSeekTtsError(
      `两种路子都没成（${attempts.join(' -> ')}）：${summary}`,
      { kind: 'protocol', details: { problems } },
    );
  } finally {
    if (lastSession && !keepSession) {
      const del = await deleteSession({ sessionIds: lastSession, token: t, fetchImpl, ...(baseUrl ? { baseUrl } : {}) });
      log(del.ok ? `已删掉临时会话 ${lastSession}` : `临时会话 ${lastSession} 没删掉（${del.error ?? del.bizCode}），自己留意一下`);
    } else if (lastSession && keepSession) {
      log(`保留了临时会话 ${lastSession}`);
    }
  }
}

export { redactUrl };
