/**
 * 线上常量。
 *
 * 来源：2026-09-12 逆向 https://fe-static.deepseek.com/chat/static/main.d69e3d8c16.js
 * （commit-id 5d128f98）与懒加载 chunk web-tts.d93cb232e3.js，并在真实账号上实测校准。
 * 这些值都是从产物里读出来的，不是猜的；凡是没实测过的，注释里会写「未验证」。
 */

/** 网页端 host。CLI / 库都只对这个域说话。 */
export const HOST = 'chat.deepseek.com';

export const HTTP_BASE = `https://${HOST}`;

/** main.js 里就是一句：`wss://` + location.host + `/api/v0/chat/tts/`（结尾斜杠有） */
export const WS_ENDPOINT = `wss://${HOST}/api/v0/chat/tts/`;

export const ENDPOINTS = Object.freeze({
  /** POST，body {"scope":"tts"}，需要 Authorization: Bearer <userToken> */
  ticket: '/api/v0/auth/ticket',
  /** GET，需要登录态 */
  voices: '/api/v0/chat/tts/voices',
  /** POST，body {"voice_id":"<id>"}，需要登录态；服务端会话级状态 */
  voice: '/api/v0/chat/tts/voice',
  /** POST，body {}，返回 biz_data.chat_session.id —— 建一个新会话 */
  sessionCreate: '/api/v0/chat_session/create',
  /** POST，body {"chat_session_ids":[...]} —— 删会话 */
  sessionDelete: '/api/v0/chat_session/delete',
  /** GET ?chat_session_id=<id> —— 拉会话消息列表 */
  historyMessages: '/api/v0/chat/history_messages',
  /** POST，body 见 src/session.mjs —— 往会话里发一条消息（需要 PoW） */
  completion: '/api/v0/chat/completion',
  /** POST，body {"target_path":"..."} —— 取 PoW challenge */
  powChallenge: '/api/v0/chat/create_pow_challenge',
});

/** 网页端恒定值。App 有语音对话模式，网页端没有。 */
export const WS_MODE = 'manual';

export const FORMATS = Object.freeze(['pcm', 'opus']);

/** pcm 负载的参数。opus 是 Ogg 裸包，采样率由解码器按 24k/单声道配置。 */
export const PCM = Object.freeze({
  sampleRate: 24000,
  channels: 1,
  bitsPerSample: 16,
});

/** 官方 played_seq 的单位：playedFrames = floor(samples / 2400)，即 100ms 一格。 */
export const PLAYED_SEQ_UNIT_MS = 100;

/** ticket 有效期。实测返回体里带 expires_in_secs: 600。 */
export const TICKET_TTL_SECONDS = 600;

/**
 * 四个音色。
 *
 * voice_id / 中文名 / 性别 / 描述 来自线上音色接口的实测记录（2026-09-12，真实账号）。
 * `gender` 这里是我们归一化过的女/男；接口原始 gender 字段的字面值（数字还是字符串）没记下来，
 * 所以没写进代码。
 *
 * `demoUrls` 只放实测能下载的公开 CDN 地址。CDN 文件名里的哈希是「每个音色+语言一个文件」各不
 * 相同（实测 mira_zh 与 tide_zh 的哈希不同，mira_en.79e34098.mp3 是 404），所以没实测过的组合
 * 没法靠猜拼出来 —— echo / stella 的地址必须带登录态调音色接口拿。
 */
export const VOICES = Object.freeze([
  Object.freeze({
    id: 'mira',
    name: '贝壳',
    nameEn: 'Mira',
    gender: 'female',
    description: '百变活泼',
    descriptionEn: 'Versatile & Playful',
    languageCount: 29,
    isDefault: true,
    demoUrls: Object.freeze({
      zh: 'https://cdn.deepseek.com/chat/tts/voice-demos/mira_zh.79e34098.mp3',
    }),
  }),
  Object.freeze({
    id: 'echo',
    name: '白浪',
    nameEn: 'Echo',
    gender: 'male',
    description: '明朗坚定',
    descriptionEn: 'Bright & Confident',
    languageCount: 29,
    isDefault: false,
    demoUrls: Object.freeze({}),
  }),
  Object.freeze({
    id: 'stella',
    name: '海星',
    nameEn: 'Stella',
    gender: 'female',
    description: '俏皮甜美',
    descriptionEn: 'Sweet & Lively',
    languageCount: 10,
    isDefault: false,
    demoUrls: Object.freeze({}),
  }),
  Object.freeze({
    id: 'tide',
    name: '暗潮',
    nameEn: 'Tide',
    gender: 'male',
    description: '低沉浑厚',
    descriptionEn: 'Deep & Rich',
    languageCount: 10,
    isDefault: false,
    demoUrls: Object.freeze({
      zh: 'https://cdn.deepseek.com/chat/tts/voice-demos/tide_zh.42b17eef.mp3',
    }),
  }),
]);

export const VOICE_IDS = Object.freeze(VOICES.map((v) => v.id));

/** 只支持 10 种语言的那两个音色支持哪些语言（来自逆向备忘，未逐语言实测）。 */
export const SHORT_LANGUAGE_CODES = Object.freeze([
  'ar', 'en', 'id', 'ja', 'ko', 'ms', 'th', 'vi', 'yue', 'zh',
]);

export function getVoice(id) {
  if (typeof id !== 'string') return undefined;
  const key = id.trim().toLowerCase();
  return VOICES.find((v) => v.id === key);
}

/**
 * ws 二进制帧：前 4 字节大端 uint32 是 seq，其后全是负载。
 * 见 main.js：`{seq:new DataView(e).getUint32(0,!1), payload:new Uint8Array(e,4)}`
 */
export const FRAME_HEADER_BYTES = 4;
