# deepseek-tts-api

DeepSeek 网页版「朗读」的非官方客户端和命令行。零运行时依赖，Node >= 22 直接跑喵。

还没发到 npm，两种用法：

```bash
npx github:Eyeing0721/deepseek-tts-api voices    # 不装，直接从 GitHub 跑
node bin/dstts.mjs voices                         # 或者 clone 下来跑
```

## 上手

```bash
npm install -g .
```

Node >= 22（用的是自带的 `fetch` 和 `WebSocket`，没装第三方依赖）。

然后设登录态。登录 `chat.deepseek.com`，开 DevTools 跑一句：

```js
JSON.parse(localStorage.getItem('userToken')).value
```

拿到一串 64 字符的东西，喂给它：

```bash
export DS_TOKEN='那串东西'      # bash
$env:DS_TOKEN = '那串东西'      # PowerShell
```

也可以临时用 `--token`。只从环境变量和 `--token` 读，不写文件、不打日志、不碰你的浏览器数据喵。

试一下通不通：

```bash
dstts probe
```

## 三个常用命令

```bash
dstts voices                          # 看四个音色
dstts demo mira -o mira.mp3           # 下试听
dstts say "今天天气不错，适合睡觉。" -o out.wav    # 念一段你写的文本
```

`say` 是重点，往下翻。

## voices / demo

```bash
dstts voices
dstts demo mira -o mira.mp3
dstts demo tide -o tide.mp3
```

四个音色：

| voice_id | 中文名 | 性别 | 描述 | 语言数 |
|---|---|---|---|---|
| `mira` | 贝壳 | 女 | 百变活泼 | 29（默认） |
| `echo` | 白浪 | 男 | 明朗坚定 | 29 |
| `stella` | 海星 | 女 | 俏皮甜美 | 10 |
| `tide` | 暗潮 | 男 | 低沉浑厚 | 10 |

海星/暗潮支持的是 `ar en id ja ko ms th vi yue zh` 这 10 种。

试听是 CDN 上的 mp3，文件名形如 `<音色>_<语言>.<哈希>.mp3`，每个组合一份、哈希各不相同，
拼不出来。地址统一从 `dstts voices` 的列表里拿。

## probe

```bash
dstts probe
```

依次打音色列表、取票、试连一次 ws，最后给一句判决，每一步的耗时都打出来。失败也是报告里的一行，不抛栈。

不给 `--session` / `--message` 时，试连用的是空 id，只能证明票和端点是通的：

```bash
dstts probe --session <会话id> --message <消息id>
```

加上会话和消息才是真正的判定。退出码 1 表示用不了，`--json` 出结构化报告。

## say

```bash
dstts say "今天天气不错，适合睡觉。"
dstts say "念这句" --voice tide -o tide.wav
dstts say "长文本……" --via reply
dstts say "别删会话" --keep
```

合成的请求里只有 `chat_session_id` 和 `message_id`，没有正文——读什么由服务端拿这两个 id
去你会话里查。所以 `say` 会现场造一个一次性会话，把文本塞进去，拿到 id 去念，念完删掉。

```
建会话 → 取 PoW challenge → 解工作量证明 → 把文本作为一条消息发进去
      → 拉 history 拿到 message_id → 合成 → 删会话
```

整条链路大概 3 秒出头（短句），长文本按音频时长线性涨，一秒音频约 0.2 秒。

`--via` 三种：

- `reply`：让模型复述一遍，念它那条。**推荐用这个**，比 `auto` 快一倍。
- `user`：只等我们发的那条用户消息落库，念的就是原文。服务端会拒（`code=6`）。
- `auto`（默认）：先试 `user`，被拒了换 `reply` 重来。

`--voice` 切音色，`-o` 指定输出，`--format opus|pcm`。默认念完删掉临时会话，`--keep` 留着。
要加自定义请求头用 `--header "名字: 值"`。

### 关于那个工作量证明

`/api/v0/chat/completion` 强制要 PoW，官方前端解不出来是直接不发请求的。
算法叫 `DeepSeekHashV1`，是 DeepSeek 自己的一套哈希，`node:crypto` 替代不了。
`test/pow.test.mjs` 里有 13 组从产物 worker 跑出来的 golden vector，改了立刻红。
细节和坑在 `docs/PROTOCOL.md`。

难度每轮不一样，实测在 5 万到 13 万次迭代之间，本地做题 300~900ms。

## read

```bash
dstts read --session <会话id> --message <消息id> -o out.wav
dstts read --session <id> --message <id> --voice tide --format pcm -o tide.wav
```

- `--session`：会话 id，网页端 URL 里 `/a/chat/s/<uuid>` 那一段。
- `--message`：那条消息的 `message_id`。
- `--voice`：传了就先切音色（服务端会话级状态）。
- `--format`：`pcm`（默认）或 `opus`。
- 不写 `-o` 默认输出 `ds-tts-<message_id>.wav`。

pcm 出来自动套好 44 字节 WAV 头（24kHz / 单声道 / s16le），拿来就能播。
opus 是裸包没有容器，多数播放器打不开，想听就用 pcm。

### wav

```bash
dstts wav in.pcm out.wav
dstts wav in.pcm out.wav --rate 16000 --channels 2
```

本地 PCM 套头的小工具。长度不是 `blockAlign` 整数倍会直接报错。

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
  format,           // 服务端实际给的格式，以它为准
  requestedFormat,
  bytes, frameCount, firstSeq, lastSeq, missingSeqs,
  duplicates, outOfOrder, contiguous,
  sampleRate, channels, bitsPerSample, samples, durationSec,   // pcm 才有
  voiceId, audioId, traceId, finish, events, acksSent, warnings,
}
```

其它导出：

```js
import { issueTicket, listVoices, setVoice, resolveDemoUrl, probeProtocol } from 'deepseek-tts-api';

const { ticket, expiresInSecs } = await issueTicket({ token });
const { voices, defaultVoiceId, currentVoiceId } = await listVoices({ token });
await setVoice({ voiceId: 'tide', token });
const report = await probeProtocol({ token, log: console.log });
```

一边收一边处理用 `onChunk`，按 seq 顺序回调：

```js
await synthesize({ sessionId, messageId, onChunk: (buf) => play(buf) });
```

出错都是 `DeepSeekTtsError`，带 `kind` 和 `code`：

```js
try { await synthesize({ ... }) }
catch (e) {
  e.kind;      // usage | auth | protocol | transport | network
  e.code;      // 协议错误码 0-12，没有就是 undefined
  e.codeName;  // 'NOT_AVAILABLE' 这种
  e.describe();
}
```

## 得知道的几件事

**票是一次性的。** 600 秒有效，但只能用一次。同一张票第二次建 ws 会被 1006 断开，零帧、没有任何错误信息。每次建连前都重新取票。

**`user` 那条路服务端不收。** 念用户消息是 `code=6 NO_CONTENT`。用 `--via reply`。

**账号可能压根没被放行。** `code=9 NOT_AVAILABLE` / `11 FORBIDDEN`，灰测和地区都有可能。跑 `probe` 看。

**别的错误码**：`4 QUOTA_EXCEEDED` 额度、`5 RATE_LIMIT_REACHED` 限流、`12 CONTENT_FILTER` 内容过滤。

**指纹头不伪造。** 官方前端还带 `x-hif-leim` / `x-hif-dliq` / `x-client-*`，这个包不发。服务端要的话用 `--header` 自己塞。

**opus 无言容器。** 裸 Opus 包，不是 Ogg。

**没验到的**：额度/限流错误码没触发过，断线续传没试，opus 每包多少采样没确认。完整清单在 `VERIFY.md`。

## 目录

```
bin/dstts.mjs          CLI，只做参数 -> 调库 -> 打印
src/constants.mjs      端点、音色表、错误码、pcm 参数
src/http.mjs           取票 / 音色列表 / 切音色 / 下 demo
src/frames.mjs         4 字节大端 seq 解析、收帧器、ws 地址
src/tts.mjs            synthesize()
src/wav.mjs            PCM -> WAV
src/probe.mjs          probeProtocol()
src/deepseek-hash.mjs  DeepSeekHashV1
src/pow.mjs            取 challenge / 解 PoW / 拼 X-DS-PoW-Response
src/session.mjs        建一次性会话、塞文本、say() 编排
src/cli-args.mjs       参数解析（纯函数，能单独测）
test/                  node --test，126 个用例
docs/PROTOCOL.md       协议细节
VERIFY.md              本机跑过的验证记录，含原始输出
```

## 测试

```bash
npm test        # 就是 node --test
```

126 个用例，不需要网络也不需要 token。WAV 头是拿纸笔算出来的期望字节逐一比的；
4 字节大端 seq 的乱序、重复、缺帧都有覆盖；`synthesize()` 用假 WebSocket + 假 fetch
把服务端演了一遍；PoW 有 13 组 golden vector 和 120 组随机串对拍。

Node 25 起 `node --test test/` 不再接受目录参数，直接 `node --test`。

## 关于我喵

我是 [@Eyeing0721](https://github.com/Eyeing0721)，主页在 **https://0721.luxe/**，
折腾的东西和写过的帖都堆在那儿。

这个包是我自己要用才写的——想把会话里的回答批量读出来做素材，官方只给了个按钮，
那就自己拆。写着写着觉得还挺顺手，就整理出来放这儿了。

要是它帮你省了点事，来主页请我喝杯奶茶喵 🐟

## 免责

非官方，跟 DeepSeek 没有任何关系，也没得到他们认可。

协议是逆向出来的，官方一改前端、换接口、上更严的风控，这个包就废了。
仅供个人学习和技术研究，别拿去批量滥用——额度、限流、内容过滤都是服务端说了算，
账号被封跟我没关系。用之前看一眼 DeepSeek 的服务条款，自己判断。

MIT，版权 Eyeing0721。
