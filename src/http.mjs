/**
 * HTTP 那一半：取票、列音色、切音色、下 demo。
 *
 * 全是公开 REST 接口，用 Node 22+ 的全局 fetch，不引第三方。
 * 注意服务端喜欢「HTTP 200 + 业务错误 JSON」这一套，所以不能靠状态码判断成败，
 * 必须解析 body 里的 code / data.biz_code。
 */

import { ENDPOINTS, HTTP_BASE, VOICES, getVoice } from './constants.mjs';
import { DeepSeekTtsError, authError, codeHint, codeName, protocolError, usageError } from './errors.mjs';

export const TOKEN_ENV = 'DS_TOKEN';

/** 官方前端发的头。别的头要不要加没有实测过 —— 目前这套在 2026-09-12 是通的。 */
export function jsonHeaders(token) {
  const h = {
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
    'user-agent': 'deepseek-tts-api (unofficial; +https://github.com/Eyeing0721)',
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/**
 * 拿 token：显式传的优先，其次环境变量 DS_TOKEN。
 * 只读环境变量，绝不落盘、绝不打印。
 */
export function resolveToken(explicit, env = process.env) {
  const t = explicit ?? env?.[TOKEN_ENV] ?? null;
  if (t === null || t === undefined) return null;
  const s = String(t).trim();
  return s.length ? s : null;
}

/** 一个很松的合理性检查：64 字符不透明串（不是 JWT）。只用来提醒，不用来拦截。 */
export function looksLikeToken(token) {
  return typeof token === 'string' && token.length === 64;
}

/** 缺 token 的提示只写一份，库和 CLI 都从这拿，免得同一个错两种说法。 */
export const MISSING_TOKEN_MESSAGE =
  '缺少登录态：没有 userToken（DS_TOKEN 环境变量和 --token 都是空的）。' +
  '取 userToken 的办法见 README 的「登录一次就好」一节 —— 本包不会去读你的浏览器数据。';

export function assertToken(token) {
  if (!token) throw authError(MISSING_TOKEN_MESSAGE);
  return token;
}

/** 解析统一信封 {code, msg, data}。失败就抛，带上服务端原话。 */
function unwrap(json, { what }) {
  if (json === null || typeof json !== 'object') {
    throw protocolError(`${what}: 服务端返回的不是 JSON 对象`, undefined, { raw: json });
  }
  if (json.code !== 0) {
    const isAuth = json.code === 40003;
    const msg = `${what} 失败：code=${json.code} ${json.msg ?? ''}`.trim();
    if (isAuth) {
      throw new DeepSeekTtsError(
        `${msg} —— token 无效或已过期（40003 INVALID_TOKEN）。重新从浏览器里取一个 userToken。`,
        { kind: 'auth', code: json.code, details: json },
      );
    }
    throw new DeepSeekTtsError(msg, { kind: 'protocol', code: json.code, details: json });
  }
  return json.data ?? {};
}

async function postJson(url, body, { token, signal, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw new DeepSeekTtsError(`请求 ${url} 失败：${cause?.message ?? cause}`, {
      kind: 'network',
      cause,
    });
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw protocolError(`POST ${url} 返回的不是 JSON（HTTP ${res.status}）`, undefined, {
      status: res.status,
      body: text.slice(0, 500),
    });
  }
  return { res, json };
}

async function getJson(url, { token, signal, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', headers: jsonHeaders(token), signal });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw new DeepSeekTtsError(`请求 ${url} 失败：${cause?.message ?? cause}`, {
      kind: 'network',
      cause,
    });
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw protocolError(`GET ${url} 返回的不是 JSON（HTTP ${res.status}）`, undefined, {
      status: res.status,
      body: text.slice(0, 500),
    });
  }
  return { res, json };
}

/**
 * 取一张 tts 票。
 *
 * 官方：`http.post('/api/v0/auth/ticket', {context: withToken, json: {scope:'tts'}})`，
 * 然后取 `json.data.biz_data.ticket`。
 *
 * 票是一次性的：600 秒有效期内，同一张票第二次建 ws 会被服务端 1006 断掉、零帧。
 * 所以每次建连之前都要重新取一张，别缓存。
 */
export async function issueTicket({
  token,
  signal,
  fetchImpl = globalThis.fetch,
  baseUrl = HTTP_BASE,
} = {}) {
  const t = assertToken(token);
  const url = `${baseUrl}${ENDPOINTS.ticket}`;
  const { json } = await postJson(url, { scope: 'tts' }, { token: t, signal, fetchImpl });
  const data = unwrap(json, { what: '取票' });

  const bizCode = data.biz_code;
  if (bizCode !== 0) {
    throw new DeepSeekTtsError(
      `取票被拒：biz_code=${bizCode}(${codeName(bizCode)}) ${data.biz_msg ?? ''}`.trim(),
      { kind: 'protocol', code: bizCode, details: json },
    );
  }
  const ticket = data?.biz_data?.ticket;
  if (!ticket || typeof ticket !== 'string') {
    throw protocolError('取票返回里没有 biz_data.ticket', undefined, { raw: json });
  }
  return {
    ticket,
    expiresInSecs: data.biz_data.expires_in_secs ?? null,
    bizCode,
    raw: json,
  };
}

/** 把接口返回的 voices[] 归一化成我们自己的形状。 */
export function normalizeVoice(v) {
  return {
    id: v?.voice_id,
    nameI18n: v?.name_i18n ?? {},
    descriptionI18n: v?.description_i18n ?? {},
    gender: v?.gender,
    languages: v?.languages ?? [],
    demoUrls: v?.demo_urls ?? {},
    isDefault: Boolean(v?.is_default),
  };
}

/** 取当前账号能看到的音色列表。官方前端就是这么映射的。 */
export async function listVoices({
  token,
  signal,
  fetchImpl = globalThis.fetch,
  baseUrl = HTTP_BASE,
} = {}) {
  const t = assertToken(token);
  const url = `${baseUrl}${ENDPOINTS.voices}`;
  const { json } = await getJson(url, { token: t, signal, fetchImpl });
  const data = unwrap(json, { what: '拉音色列表' });
  const biz = data.biz_data ?? {};
  if (data.biz_code !== 0) {
    throw new DeepSeekTtsError(
      `拉音色列表被拒：biz_code=${data.biz_code}(${codeName(data.biz_code)})`,
      { kind: 'protocol', code: data.biz_code, details: json },
    );
  }
  return {
    voices: (biz.voices ?? []).map(normalizeVoice),
    defaultVoiceId: biz.default_voice_id ?? null,
    currentVoiceId: biz.current_voice_id ?? null,
    raw: json,
  };
}

/**
 * 切音色。这是服务端会话级状态，切一次后面都算这个音色，直到你再切。
 * 返回的 biz_code: 0 成功 / 1 音色已下线 / 2 参数错（逆向备忘里记的，0 之外没见过）。
 */
export async function setVoice({
  voiceId,
  token,
  signal,
  fetchImpl = globalThis.fetch,
  baseUrl = HTTP_BASE,
} = {}) {
  const t = assertToken(token);
  if (!voiceId) throw usageError('setVoice 缺 voiceId');
  const url = `${baseUrl}${ENDPOINTS.voice}`;
  const { json } = await postJson(url, { voice_id: voiceId }, { token: t, signal, fetchImpl });
  const data = unwrap(json, { what: '切音色' });
  const bizCode = data.biz_code;
  if (bizCode !== 0) {
    const hint = bizCode === 1 ? '该音色已下线' : bizCode === 2 ? '参数错' : (codeHint(bizCode) ?? '');
    throw new DeepSeekTtsError(`切音色失败：biz_code=${bizCode} ${hint}`.trim(), {
      kind: 'protocol',
      code: bizCode,
      details: json,
    });
  }
  return { code: bizCode, raw: json };
}

/**
 * 找某个音色某个语言的试听 demo 地址。
 *
 * 两条路：
 *  1. 有登录态 —— 调音色接口，直接读 demo_urls[lang]。这是唯一能覆盖全部音色/语言的办法。
 *  2. 没登录态 —— 只能查本包内置的那几个实测过的地址（目前只有 mira/zh 和 tide/zh）。
 *
 * CDN 文件名形如 <voice>_<lang>.<hash>.mp3，哈希是每个「音色+语言」组合一份、各不相同，
 * 所以没实测过的组合拼不出来，只能老实说没有。
 */
export async function resolveDemoUrl({
  voiceId,
  lang = 'zh',
  token,
  signal,
  fetchImpl = globalThis.fetch,
  baseUrl = HTTP_BASE,
} = {}) {
  if (!voiceId) throw usageError('resolveDemoUrl 缺 voiceId');

  if (token) {
    const { voices } = await listVoices({ token, signal, fetchImpl, baseUrl });
    const hit = voices.find((v) => v.id === voiceId);
    if (!hit) {
      throw usageError(
        `账号可见的音色里没有 "${voiceId}"。有：${voices.map((v) => v.id).join(', ') || '(空)'}`,
      );
    }
    const url = hit.demoUrls?.[lang];
    if (!url) {
      const have = Object.keys(hit.demoUrls ?? {});
      throw usageError(
        `音色 ${voiceId} 没有 ${lang} 的试听。它有：${have.length ? have.join(', ') : '(一个都没有)'}`,
      );
    }
    return { url, source: 'api' };
  }

  const local = getVoice(voiceId)?.demoUrls?.[lang];
  if (local) return { url: local, source: 'builtin' };

  const known = [];
  for (const v of VOICES) {
    for (const [l, u] of Object.entries(v.demoUrls)) known.push(`${v.id}/${l}  ${u}`);
  }
  throw usageError(
    `没有登录态时我只有这几个实测过的试听地址：\n  ${known.join('\n  ')}\n` +
      `要听 ${voiceId}/${lang}，得带上 --token 或 DS_TOKEN 让程序去问官方音色接口。` +
      'CDN 文件名里带内容哈希（每个音色+语言一份，各不相同），没实测过的拼不出来。',
  );
}

/** 下载任意 URL 成 Buffer。 */
export async function fetchBinary(url, { signal, fetchImpl = globalThis.fetch, maxBytes } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', signal });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw new DeepSeekTtsError(`下载 ${url} 失败：${cause?.message ?? cause}`, {
      kind: 'network',
      cause,
    });
  }
  if (!res.ok) {
    throw new DeepSeekTtsError(`下载 ${url} 失败：HTTP ${res.status}`, {
      kind: 'network',
      details: { status: res.status },
    });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (maxBytes && buf.length > maxBytes) {
    throw new DeepSeekTtsError(`下载 ${url} 超出 ${maxBytes} 字节上限`, { kind: 'network' });
  }
  return {
    data: buf,
    contentType: res.headers.get('content-type') ?? null,
    status: res.status,
    url,
  };
}
