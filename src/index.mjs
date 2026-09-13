/**
 * deepseek-tts-api —— 非官方 DeepSeek 网页版朗读（TTS）客户端。
 *
 * 零运行时依赖，要求 Node >= 22（靠的是全局 fetch 和全局 WebSocket）。
 *
 * 用法：
 *   import { issueTicket, listVoices, synthesize, pcmToWav } from 'deepseek-tts-api';
 *
 *   const { audio, format, durationSec } = await synthesize({
 *     sessionId: '...', messageId: '...', format: 'pcm',
 *   });
 *   await writeFile('out.wav', pcmToWav(audio));
 */

export {
  HOST,
  HTTP_BASE,
  WS_ENDPOINT,
  WS_MODE,
  ENDPOINTS,
  FORMATS,
  PCM,
  TICKET_TTL_SECONDS,
  PLAYED_SEQ_UNIT_MS,
  VOICES,
  VOICE_IDS,
  SHORT_LANGUAGE_CODES,
  FRAME_HEADER_BYTES,
  getVoice,
} from './constants.mjs';

export {
  DeepSeekTtsError,
  ErrorCode,
  codeName,
  codeHint,
  isSuccessCode,
  usageError,
  authError,
  transportError,
  protocolError,
} from './errors.mjs';

export {
  TOKEN_ENV,
  MISSING_TOKEN_MESSAGE,
  resolveToken,
  looksLikeToken,
  assertToken,
  issueTicket,
  listVoices,
  normalizeVoice,
  setVoice,
  resolveDemoUrl,
  fetchBinary,
} from './http.mjs';

export {
  parseAudioFrame,
  encodeAudioFrame,
  buildTtsUrl,
  assembleFrames,
  FrameAssembler,
} from './frames.mjs';

export { WAV_HEADER_BYTES, wavHeader, pcmToWav, parseWavHeader } from './wav.mjs';

export { synthesize, synthesizeToWavBuffer, redactUrl } from './tts.mjs';

export { probeProtocol } from './probe.mjs';

export {
  COMMANDS,
  OPTION_NAMES,
  parseArgv,
  numericOptions,
  requireOption,
  requirePositional,
} from './cli-args.mjs';
