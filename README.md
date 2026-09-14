# deepseek-tts-api

DeepSeek 网页版「朗读」的非官方客户端 + CLI。
点个star谢谢喵

> 把 DeepSeek 网页上的朗读功能，搬到命令行里。

Node 包 + CLI，命令名：

```bash
dstts
```

当前版本：`0.2.0`

环境要求：**Node.js >= 22**

运行时零依赖，直接用 Node 自带的 `fetch` 和 `WebSocket`。

[GitHub](https://github.com/Eyeing0721/deepseek-tts-api) · [个人主页 / 打赏](https://0721.luxe/) · [@Eyeing0721](https://github.com/Eyeing0721)

---

## 能拿来干嘛

```bash
# 看音色
dstts voices

# 下载试听
dstts demo mira -o 试听.mp3

# 检查账号
dstts probe

# 直接念一段文字
dstts say "今天辛苦了，早点睡。"

# 念已经聊过的某条回答
dstts read --session <id> --message <id>

# PCM 封成 WAV
dstts wav in.pcm out.wav
```

就这么简单。

---

## 上手

> **先看下面的「登录态」。** 所有命令都要登录态，一条都不能少 —— 包括 `voices` 和 `demo`。
> 没设 token 直接跑，只会收到一句 `缺少登录态`。

### 直接跑

现在 npm 还没发布，所以先从 GitHub 跑：

```bash
# 不用安装，直接跑
npx github:Eyeing0721/deepseek-tts-api voices
```

也可以全局装：

```bash
npm install -g .
dstts voices
```

或者克隆下来：

```bash
node bin/dstts.mjs voices
```

---

## 登录态

需要一个 `userToken`。

登录 [chat.deepseek.com](https://chat.deepseek.com)，按 `F12` 打开 DevTools。

Mac：

```text
Option + Command + I
```

打开 Console / 控制台，输入：

```js
JSON.parse(localStorage.getItem('userToken')).value
```

拿到的就是 `userToken`。

它是一串 **64 字符的字符串**。

Console 不让粘贴的时候，先手打：

```text
allow pasting
```

回车，再贴上面的代码。

### 怎么传

bash / macOS：

```bash
export DS_TOKEN='那串东西'
```

Windows PowerShell：

```powershell
$env:DS_TOKEN = '那串东西'
```

也可以直接：

```bash
dstts voices --token <值>
```

所有命令都需要登录态，包括 `voices` 和 `demo`。

token 只从 `DS_TOKEN` 和 `--token` 读，不写文件，也不打进日志。

---

## 音色

目前有这几只：

| ID       | 中文名 | 英文名    | 性别     | 描述   | 语言 |
| -------- | --- | ------ | ------ | ---- | -: |
| `mira`   | 贝壳  | Mira   | female | 百变活泼（可以唱歌） | 29 |
| `echo`   | 白浪  | Echo   | male   | 明朗坚定 | 29 |
| `stella` | 海星  | Stella | female | 俏皮甜美 | 10 |
| `tide`   | 暗潮  | Tide   | male   | 低沉浑厚 | 10 |

默认是：

```text
mira
```

海星和暗潮支持：

```text
ar en id ja ko ms th vi yue zh
```

还带粤语。

---

## voices

看看现在有哪些音色：

```bash
dstts voices
```

想拿 JSON：

```bash
dstts voices --json
```

输出大概这样：

```text
音色列表（官方接口 /api/v0/chat/tts/voices）
默认 mira   当前 mira

  mira     贝壳   female  百变活泼   29 种语言  试听 29 个  (默认)
  echo     白浪   male    明朗坚定   29 种语言  试听 29 个
  stella   海星   female  俏皮甜美   10 种语言  试听 10 个
  tide     暗潮   male    低沉浑厚   10 种语言  试听 10 个
```

---

## demo

想先听听某个音色长什么样：

```bash
dstts demo mira -o 试听.mp3
```

指定语言：

```bash
dstts demo tide --lang yue -o 粤语试听.mp3
```

不写 `-o` 的话，默认文件名：

```text
demo-<音色>-<语言>.mp3
```

---

## probe

先测一下账号这边能不能正常走：

```bash
dstts probe
```

也可以带上会话和消息：

```bash
dstts probe --session <id> --message <id>
```

会依次检查音色、票据和 WebSocket，然后给结果。

```bash
dstts probe --json
```

还能直接拿结构化结果。

---

## say

最适合日常玩的就是这个。

```bash
dstts say "今天天气不错，适合睡觉。"
```

换音色：

```bash
dstts say "念这句" --voice tide -o tide.wav
```

想把临时会话留下：

```bash
dstts say "别删会话" --keep
```

也能调等待时间和 PoW：

```bash
dstts say "..." --wait 60000 --max-iterations 5000000
```

额外请求头：

```bash
dstts say "..." --header "名字: 值"
```

`--header` 可以重复传。

默认输出：

```text
ds-say-<时间戳>.wav
```

### 它是怎么念出来的

DeepSeek 的 TTS 接口只接收：

```text
chat_session_id
message_id
```

服务端会自己根据这两个 id 找内容。

同时，它只念**模型消息**，用户自己发的那条消息不能直接拿去合成。

所以 `say` 会先建一个临时会话，让模型把你给的文字原样复述出来：

```text
请把下面这段文字原样输出一遍，不要翻译、不要总结、不要解释、不要加引号或任何前后缀，一个字都不要改：

<你给的文本>
```

拿到模型消息的 `message_id` 后，再交给 TTS。

整个过程：

```text
建会话
→ 解 PoW
→ 发复述提示语
→ 拉 history
→ 拿 message_id
→ 合成
→ 删掉临时会话
```

所以你写：

```bash
dstts say "今天早点睡"
```

它真的会自己走完这一整套，然后给你一个可以直接播放的 WAV。

---

## read

已经有会话和消息了，就直接读：

```bash
dstts read --session <会话id> --message <消息id> -o out.wav
```

换音色：

```bash
dstts read --session <id> --message <id> --voice tide --format pcm
```

其中：

* `session` 是网页 URL 里的 `/a/chat/s/<uuid>` 那一段
* `message` 是对应消息的 `message_id`

不写 `-o`：

```text
ds-tts-<message_id>.wav
```

---

## wav

裸 PCM 套个 WAV 头：

```bash
dstts wav in.pcm out.wav
```

默认：

```text
24000 Hz
单声道
16 bit
```

也可以自己指定：

```bash
dstts wav in.pcm out.wav --rate 16000 --channels 2
```

长度对不上 `blockAlign` 的话会直接报错。

---

## 通用选项

| 选项               | 说明                                 |
| ---------------- | ---------------------------------- |
| `-o, --out <路径>` | 输出文件                               |
| `--format <格式>`  | `pcm`（默认）或 `opus`                  |
| `--voice <id>`   | 切换音色                               |
| `--token <值>`    | userToken                          |
| `--timeout <ms>` | 超时，默认 `read=90000` / `probe=15000` |
| `--json`         | JSON 输出                            |
| `-h, --help`     | 帮助                                 |
| `--version`      | 版本                                 |

---

## 错误码

真遇到报错，CLI 会直接给中文提示，对着看就好：

|    码 | 名字                           | 中文                                |
| ---: | ---------------------------- | --------------------------------- |
|  `0` | `SUCCESS`                    | —                                 |
|  `1` | `INTERNAL_ERROR`             | 服务端内部错误                           |
|  `2` | `INVALID_INPUT`              | 请求参数不对（会话 id / 消息 id 大概率是错的）      |
|  `3` | `SERVICE_ERROR`              | 服务端业务异常                           |
|  `4` | `QUOTA_EXCEEDED`             | 朗读额度用完了（今日限额）                     |
|  `5` | `RATE_LIMIT_REACHED`         | 请求太频繁，被限流了                        |
|  `6` | `NO_CONTENT`                 | 这条消息没有可朗读的正文                      |
|  `7` | `UNSUPPORTED_LANGUAGE`       | 当前语言不支持朗读                         |
|  `8` | `VOICE_UNSUPPORTED_LANGUAGE` | 这个音色不支持当前语言                       |
|  `9` | `NOT_AVAILABLE`              | 服务端未对该账号放行（NOT_AVAILABLE，灰测/地区限制） |
| `10` | `RESUME_EXPIRED`             | 续传票据过期了                           |
| `11` | `FORBIDDEN`                  | 被拒绝（FORBIDDEN）                    |
| `12` | `CONTENT_FILTER`             | 内容被安全过滤挡了                         |

另外还有：

```text
auth：
缺少登录态：没有 userToken（DS_TOKEN 环境变量和 --token 都是空的）。取 userToken 的办法见 README 的「上手」一节
```

以及普通参数错误：

```text
参数错误：不认识的选项：--via
```

---

## 几个小提醒

### 票是一次性的

票有效期是 `600` 秒，而且只能用一次。

所以每次建立 WebSocket 之前，程序都会重新取票。

### 朗读目前正在公测
账号是否能用，由服务端决定。

碰到：

```text
code=9 NOT_AVAILABLE
```

或者：

```text
code=11 FORBIDDEN
```

就是当前账号没拿到权限。

### opus 是裸 Opus

`format=opus` 拿到的是裸 Opus 包，没有 Ogg 容器。

想拿来直接播放，默认用 `pcm` 就行。它会自动封成 WAV。

### say 会建临时会话

每次 `say` 都会创建一个临时会话。

默认念完就删，`--keep` 可以留下。

### PoW 会占一点时间

每次合成前都要做一次工作量证明。

一般大约：

```text
300 ~ 900ms
```

默认最多算：

```text
5000000 次
```

---

## 性能

实测大概是这个感觉：

| 命令                                |          耗时 |
| --------------------------------- | ----------: |
| `dstts voices`                    |      0.22 s |
| `dstts probe`                     |      0.26 s |
| `dstts say` 短句（11 字 → 1.8s 音频）    | 3.2 ~ 4.2 s |
| `dstts say` 长文本（101 字 → 19.0s 音频） |       7.1 s |
| `npx github:... help` 首次运行        |      11.1 s |

短句主要是固定流程占时间。

长一点的文本，整体会快不少。

---

## Node 里直接用

```js
import { writeFile } from 'node:fs/promises';
import { synthesize, pcmToWav } from 'deepseek-tts-api';

const r = await synthesize({
  sessionId: '...',
  messageId: '...'
});

await writeFile('out.wav', pcmToWav(r.audio));
```

不传 token 的话，会直接读：

```text
DS_TOKEN
```

`synthesize()` 会返回音频、帧信息、票据、会话信息等完整结果。

流式播放也可以：

```js
onChunk: (buf) => play(buf)
```

常用导出：

```text
issueTicket
listVoices
setVoice
resolveDemoUrl
probeProtocol
createSession
deleteSession
fetchMessages
putText
say
pcmToWav
wavHeader
parseWavHeader
DeepSeekTtsError
ErrorCode
codeName
codeHint
VOICES
PCM
FORMATS
TOKEN_ENV
parseArgv
```

错误统一是：

```js
catch (e) {
  e.kind;
  e.code;
  e.codeName;
  e.describe();
}
```

---

## 项目结构

```text
bin/dstts.mjs          CLI
src/constants.mjs      端点、音色表、错误码、PCM 参数
src/http.mjs           取票 / 音色列表 / 切音色 / demo
src/frames.mjs         WebSocket 帧处理
src/tts.mjs            synthesize()
src/wav.mjs            PCM → WAV
src/probe.mjs          probeProtocol()
src/deepseek-hash.mjs  PoW 哈希
src/pow.mjs            Challenge / PoW
src/session.mjs        会话与 say()
src/cli-args.mjs       参数解析
src/errors.mjs         错误码与中文提示
src/index.mjs          导出

test/                  测试
docs/PROTOCOL.md       协议细节
```

---

## 许可证

MIT

版权：

```text
Eyeing0721
```

仅供个人学习和技术研究

---

## 觉得好玩就点个 Star

这个项目折腾了不少细节，觉得有点意思的话，帮忙点个 ⭐ Star。

Star 对作者来说真的很有用，更新的时候也更有动力。

[⭐ GitHub](https://github.com/Eyeing0721/deepseek-tts-api)

也可以来我的主页逛逛：

**https://0721.luxe/**

喜欢的话，顺手请我喝杯奶茶也好呀。
