# deepseek-tts-api

非官方的 DeepSeek 网页版「朗读」客户端。把网页上那个朗读按钮背后的东西单独拎出来做成了
一个 Node 包 + 命令行，零运行时依赖，Node >= 22 直接跑。

```
# 还没发到 npm 上，先在仓库里跑
node bin/dstts.mjs voices
```

## 为什么做这个

2026-09 那阵子 DeepSeek 网页版在灰测朗读，但灰度卡在前端的远程配置上（
`localStorage.__ds_remote_feature_store_model` 里 `model_configs[].tts_feature`），
后端其实不卡。我先把前端门拆了（另一个仓库 `deepseek-tts-unlocker`），拆完顺手把 TTS 那套
协议也读了一遍，发现它本身挺干净：REST 取票，WebSocket 收音频，二进制帧格式就一行代码。

既然协议都清楚了，就没必要绑在浏览器和那个按钮上。所以有了这个包：

- 想在脚本里批量把会话里的回答读出来 → 直接调 `synthesize()`
- 想看看自己账号到底有没有被放行 → `dstts probe`
- 只想听一下四个音色什么声 → `dstts demo mira`，连登录都不用

协议细节在 `docs/PROTOCOL.md`，是从线上产物里读出来的，不是猜的。

## 安装

```bash
# 包还没发布到 npm。先这么装：
npm install -g .
dstts voices

# 或者完全不装，克隆下来直接跑：
node bin/dstts.mjs voices
```

要求 Node >= 22。不是随便写的：22 起才有全局 `fetch` 和全局 `WebSocket`，这个包靠的就是这两个，
一个第三方依赖都没装（没有 `ws`、没有 `node-fetch`）。实测跑在 Node v25.8.0 上。

## 不需要登录就能跑的两条

### 看音色

```bash
dstts voices
```

不带登录态就打内置的那张表（逆向 + 实测核对过的），本地就有，不联网。

想拉实时的、顺带拿到全部试听地址，就得给 token：

```bash
DS_TOKEN=xxx dstts voices
```

注意「列音色」这个接口**是要登录态的**。不带 token 打过去拿到的是
`{"code":40003,"msg":"INVALID_TOKEN"}`，不是公开接口。所以不带 token 时打的是内置表，这点不糊弄。

### 下试听

```bash
dstts demo mira -o demo-mira.mp3
```

这个是公开 CDN，**真不需要登录**。mira 和 tide 的地址内置在里面（实测过）：

```
https://cdn.deepseek.com/chat/tts/voice-demos/mira_zh.79e34098.mp3
https://cdn.deepseek.com/chat/tts/voice-demos/tide_zh.42b17eef.mp3
```

echo / stella 没有内置，因为拿不到。CDN 文件名形如 `<voice>_<lang>.<hash>.mp3`，
那个 hash 是**每个「音色+语言」组合各一份、互不相同**的：

```
mira_zh.79e34098.mp3   -> 200
tide_zh.42b17eef.mp3   -> 200
mira_en.79e34098.mp3   -> 404   （语言换了，hash 也换）
echo_zh.79e34098.mp3   -> 404   （音色换了，hash 也换）
```

所以拼不出来。想要 echo / stella 就带 token 让程序去问官方接口，`demo_urls` 里什么都有。

## probe：我这账号到底能不能用

```bash
dstts probe
```

按顺序干四件事：打本地音色表 → 拉真实音色列表 → 取一张票 → 试连一次 ws，最后给一句判决。
每一步的耗时和结果都打出来。全程不抛栈，失败也是报告里的一行。

没给 `--session` / `--message` 的时候，试连是拿空 id 连的，只能证明「票和端点是通的、账号没被
挡在门外」，证明不了能合成。想让试连真的判定，补上会话和消息：

```bash
dstts probe --session <会话id> --message <消息id>
```

没登录态时它长这样：

```
$ dstts probe
Node v25.8.0

本地内置音色表（逆向 + 2026-09-12 实测）：
  mira    贝壳  女  百变活泼  29 种语言  (默认)
  echo    白浪  男  明朗坚定  29 种语言
  stella  海星  女  俏皮甜美  10 种语言
  tide    暗潮  男  低沉浑厚  10 种语言

判决：用不了 —— 缺少登录态。
  设 DS_TOKEN 或者传 --token 再来。怎么拿 token 见 README 的「登录态」一节。
  本包不会去读你的浏览器 cookie / localStorage / LevelDB，这活你自己做。
```

退出码 1。加 `--json` 拿结构化报告。

## read：真的合成一段

```bash
dstts read --session <会话id> --message <消息id> -o out.wav
dstts read --session <id> --message <id> --voice tide --format pcm -o tide.wav
```

- `--session`：会话 id，就是网页端 URL 里 `/a/chat/s/<uuid>` 那一段。
- `--message`：那条消息的 message_id。
- `--voice`：传了就先切音色（服务端会话级状态，切了就一直是你切的那个）。
- `--format`：`pcm`（默认）或 `opus`。
- 不写 `-o` 的话默认输出 `ds-tts-<message_id>.wav`。
- 要 token：`DS_TOKEN` 环境变量或 `--token`。

pcm 出来会自动套好 44 字节 WAV 头（24kHz / 单声道 / s16le），拿来就能播。
opus 那条路写出来的是**裸 Opus 包，没有容器**，多数播放器打不开 —— 想听就用 pcm，
或者自己封进 Ogg。别问我为什么，官方就是这么发的，它自己也是丢给 WebCodecs 的解码器。

### 本地 PCM 套 WAV

```bash
dstts wav in.pcm out.wav
dstts wav in.pcm out.wav --rate 16000 --channels 2
```

顺手带的小工具。长度不是 `blockAlign` 整数倍会直接报错，不会悄悄给你补一个字节 ——
被截断的流应该让人知道，而不是让人拿到一个听不出毛病但尾部错位的文件。

## 当库用

```js
import { writeFile } from 'node:fs/promises';
import { synthesize, pcmToWav } from 'deepseek-tts-api';

const result = await synthesize({
  sessionId: '...',
  messageId: '...',
  format: 'pcm',
  // token 不给就读 DS_TOKEN
});

console.log(result.frameCount, result.bytes, result.durationSec, result.voiceId);

await writeFile('out.wav', pcmToWav(result.audio));
```

`synthesize()` 返回的东西（节选）：

```js
{
  audio,            // Buffer，按 seq 排好拼起来的音频
  format,           // 服务端实际给的格式（可能和你请求的不一样，以它为准）
  requestedFormat,
  bytes, frameCount, firstSeq, lastSeq, missingSeqs,
  duplicates, outOfOrder, contiguous,
  sampleRate, channels, bitsPerSample, samples, durationSec,   // pcm 才有
  voiceId, audioId, traceId, finish, events, acksSent, warnings,
}
```

其它能用的：

```js
import { issueTicket, listVoices, setVoice, resolveDemoUrl, probeProtocol } from 'deepseek-tts-api';

const { ticket, expiresInSecs } = await issueTicket({ token });
const { voices, defaultVoiceId, currentVoiceId } = await listVoices({ token });
await setVoice({ voiceId: 'tide', token });
const report = await probeProtocol({ token, log: console.log });
```

想一边收一边处理就用 `onChunk`，它按 seq 顺序回调（WebSocket 走 TCP，正常就是有序到达）：

```js
await synthesize({ sessionId, messageId, onChunk: (buf) => play(buf) });
```

出错都是 `DeepSeekTtsError`，带 `kind` 和 `code`：

```js
try { await synthesize({ ... }) }
catch (e) {
  e.kind;      // usage | auth | protocol | transport | network
  e.code;      // 协议错误码（0-12），没有就是 undefined
  e.codeName;  // 'NOT_AVAILABLE' 这种
  e.describe();
}
```

## 音色

| voice_id | 中文名 | 性别 | 描述 | 语言数 |
|---|---|---|---|---|
| `mira` | 贝壳 | 女 | 百变活泼 | 29（默认） |
| `echo` | 白浪 | 男 | 明朗坚定 | 29 |
| `stella` | 海星 | 女 | 俏皮甜美 | 10 |
| `tide` | 暗潮 | 男 | 低沉浑厚 | 10 |

表里是逐个在真实账号上核对过的。海星/暗潮只支持 `ar en id ja ko ms th vi yue zh` 这 10 种
（这条出自逆向备忘，我没逐语言打接口验过）。

## 限制，以及一些坑

### 请求里没有正文，这是最大的限制

合成请求里只有 `chat_session_id` + `message_id`，**没有任何文本参数**。读哪段文字是服务端拿这
两个 id 去你自己的会话里查出来的。

所以它读不了任意字符串。想让它念一段文字，得先让那段文字变成你会话里的一条消息；`message_id`
传错基本就是 `code=2` 或者 `code=6`。

### ticket 是一次性的

600 秒有效，但**只能用一次**。同一张票第二次建 ws 会被服务端 1006 断开、零帧、没有任何错误信息。

我刚写循环的时候就栽在这：第一轮好好的，第二轮开始永远连不上，还查不出原因。现在每次建连前都
重新取票。

### 别的

- `mode` 恒为 `manual`，网页端没有 App 那个语音对话模式。
- 服务端可能压根不放行你的账号（`code=9 NOT_AVAILABLE` / `11 FORBIDDEN`），
  灰测和地区都可能。跑 `dstts probe` 就知道。
- 朗读有额度限制（`4 QUOTA_EXCEEDED`）、会限流（`5 RATE_LIMIT_REACHED`）、
  会被内容过滤挡（`12 CONTENT_FILTER`）。
- `format=opus` 是裸 Opus 包，不是 Ogg，别指望直接能播。
- 协议随时可能变。这是逆向出来的东西，官方改前端、换接口、上更严的风控，这个包就废了。

## 登录态

需要一个 `userToken`。怎么拿是你自己的事，**本包不会去读你的浏览器数据** ——
不翻 localStorage、不碰 cookie、不开 LevelDB。

拿的路径（你自己在浏览器里操作）：登录 `chat.deepseek.com`，开 DevTools，执行

```js
JSON.parse(localStorage.getItem('userToken')).value
```

得到的是一个 **64 字符的不透明串，不是 JWT**。

然后：

```bash
export DS_TOKEN='那串东西'          # Linux / macOS
$env:DS_TOKEN = '那串东西'          # PowerShell
dstts read --session ... --message ...
```

或者临时用 `--token`。本包只从环境变量和 `--token` 读 token，**不写进任何文件、不打进日志**。
`probe` 的报告里连票都只报长度不报内容，URL 里的票也会被替换成 `<redacted>`。

## 目录

```
bin/dstts.mjs        CLI，只做参数 -> 调库 -> 打印
src/constants.mjs    端点、音色表、错误码、pcm 参数
src/http.mjs         取票 / 音色列表 / 切音色 / 下 demo
src/frames.mjs       4 字节大端 seq 解析、收帧器、ws 地址
src/tts.mjs          synthesize()
src/wav.mjs          PCM -> WAV
src/probe.mjs        probeProtocol()
src/cli-args.mjs     参数解析（纯函数，能单独测）
test/                node --test，86 个用例
docs/PROTOCOL.md     协议细节 + 没验证到的东西
VERIFY.md            本机跑过的验证记录，含原始输出
```

## 测试

```bash
npm test        # 就是 node --test
```

86 个用例，不需要网络也不需要 token：WAV 头是拿纸笔算出来的期望字节逐一对比的，
`4` 字节大端 seq、乱序、重复、缺帧都有覆盖，`synthesize()` 用假 WebSocket + 假 fetch
把服务端演了一遍（ready → 帧 → finish），错误码、ack 口径、abort 也都有对应用例。

注意 Node 25 起 `node --test test/` 不再接受目录参数，直接 `node --test` 就行。

## 免责声明

非官方。跟 DeepSeek 没有任何关系，不是他们发布的，也没得到他们认可。

协议是逆向出来的，随时可能变。仅供个人学习和技术研究，别拿去搞批量滥用 ——
额度、限流、内容过滤都是服务端说了算，你的账号被封跟我没关系。用之前先看一眼
DeepSeek 的服务条款，自己判断。

MIT，版权 Eyeing0721。
