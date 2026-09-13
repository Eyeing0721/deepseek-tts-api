# DeepSeek 网页版朗读（TTS）协议笔记

这份文档写清楚 `deepseek-tts-api` 实现的是什么东西。协议不是猜的，是从线上产物里读出来的，
再拿真实账号校准过。

## 来源

| 东西 | 地址 |
|---|---|
| 主包 | `https://fe-static.deepseek.com/chat/static/main.d69e3d8c16.js` |
| 懒加载 chunk | `https://fe-static.deepseek.com/chat/static/web-tts.d93cb232e3.js`（chunk id 74268） |
| commit-id | `5d128f98` |
| 抓取日期 | 2026-09-12 |

两个文件都是公开可访问的。chunk 是点「朗读」按钮时才 `import()` 进来的，也就是 TTS 那一整套
状态机都在里面。本文里凡是「官方实现」的引用，指的就是这两个文件。

`main.d69e3d8c16.js` 里能直接读到关键的那几个函数：

```js
// ws 地址
wsEndpoint: "wss://".concat(window.location.host, "/api/v0/chat/tts/")

// 取票
await http.post("/api/v0/auth/ticket", { context: withToken, json: { scope: "tts" } })
// -> json.data.biz_data.ticket

// 音色列表：字段是一对一映射的
t.http.get("/api/v0/chat/tts/voices").then(({ json: n }) => {
  const { voices: r, default_voice_id: s, current_voice_id: a } = n.data.biz_data;
  return r.map(e => ({
    voiceId: e.voice_id, nameI18n: e.name_i18n, descriptionI18n: e.description_i18n,
    gender: e.gender, languages: e.languages, demoUrls: e.demo_urls, isDefault: e.is_default,
  }));
});

// 切音色
http.post("/api/v0/chat/tts/voice", { json: { voice_id: voiceId } })
// -> n.data.biz_code（0 = 成功）
```

以及二进制帧的解析和 ws 地址拼装，一个字都不用改：

```js
function parseFrame(e) {
  return { seq: new DataView(e).getUint32(0, !1), payload: new Uint8Array(e, 4) };
}
// getUint32(0, false) —— 第二个参数 false 就是「大端」，这一点很关键，写成小端 seq 全乱。

function buildUrl(endpoint, streamParams, opts, resume) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(streamParams)) s.set(k, v);
  s.set("ticket", opts.ticket);
  s.set("mode", opts.mode);
  s.set("format", opts.format);
  if (resume !== undefined) {
    s.set("audio_id", resume.audio_id);
    s.set("received_seq", String(resume.received_seq));
    s.set("played_seq", String(resume.played_seq));
  }
  const sep = endpoint.includes("?") ? "&" : "?";
  return endpoint + sep + s.toString();
}
```

## 整体时序

```
浏览器/本包                                          chat.deepseek.com
     |                                                        |
     |-- GET  /api/v0/chat/tts/voices ----------------------->|  音色列表（需要登录态）
     |<-- {code:0, data:{biz_code:0, biz_data:{voices:[...]}} |
     |                                                        |
     |-- POST /api/v0/chat/tts/voice {voice_id:"tide"} ------>|  切音色（服务端会话级状态，可选）
     |<-- {code:0, data:{biz_code:0}}                         |
     |                                                        |
     |-- POST /api/v0/auth/ticket {scope:"tts"} ------------->|  取票（一次性，600s）
     |<-- {code:0,data:{biz_code:0,biz_data:{ticket,expires_in_secs:600}}}
     |                                                        |
     |== WS 升级 ============================================>|
     |   wss://chat.deepseek.com/api/v0/chat/tts/
     |     ?chat_session_id=<sid>&message_id=<mid>
     |     &ticket=<票>&mode=manual&format=pcm|opus
     |                                                        |
     |<== {"event":"ready","audio_id":"..","format":"pcm",   |
     |     "voice_id":"mira","trace_id":".."} ================|
     |                                                        |
     |--- {"event":"ack","received_seq":0,"played_seq":0} --->|
     |                                                        |
     |<== [4B 大端 seq][负载]   x N 个二进制帧 ================|
     |--- {"event":"ack","received_seq":n,"played_seq":m} --->|  官方：首帧之后每 1000ms 一次
     |                                                        |
     |<== {"event":"finish","code":0,"msg":"success"} ========|
     |--- {"event":"finish"} -------------------------------->|
     |=== 关闭 ===|
```

## 1. 取票

```
POST /api/v0/auth/ticket
Authorization: Bearer <userToken>
Content-Type: application/json

{"scope":"tts"}
```

成功：

```json
{"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"","biz_data":{"ticket":"<uuid>","expires_in_secs":600}}}
```

注意信封是两层：外层 `code` 判 HTTP 层的成败，内层 `data.biz_code` 判业务层。外层失败时会是什么样：

```
HTTP 200
{"code":40003,"msg":"INVALID_TOKEN","data":null}
```

**状态码是 200。** 只看 HTTP 状态码判断成败会一路踩坑，必须解析 body。

### ticket 的两个性质

1. **600 秒有效**（`expires_in_secs: 600`）。
2. **一次性。** 600 秒内也只能用一次。同一张票第二次建 ws，服务端直接 1006 断开、零帧。
   所以每次建连之前都要重新取一张，别缓存、别复用。

第 2 条是 2026-09-12 实测出来的，也是这个协议里最容易踩的坑：写循环的时候忘了重新取票，
表现为「第一次成功，之后永远连不上」，而且断得干干净净，没有任何错误信息。

## 2. 音色列表

```
GET /api/v0/chat/tts/voices
Authorization: Bearer <userToken>
```

**这个接口要登录态。** 不带或带错的 token 都会拿到 `{"code":40003,"msg":"INVALID_TOKEN","data":null}`，
不是公开接口。

成功时 `data.biz_data` 的形状：

```
{
  voices: [{
    voice_id, name_i18n, description_i18n, gender,
    languages, demo_urls, is_default, ...
  }],
  default_voice_id,
  current_voice_id
}
```

四个音色的实测对照（这个别猜，2026-09-12 在真实账号上逐个核对过）：

| voice_id | 中文名 | 性别 | 描述 | 语言数 |
|---|---|---|---|---|
| `mira` | 贝壳 | 女 | 百变活泼 | 29（默认） |
| `echo` | 白浪 | 男 | 明朗坚定 | 29 |
| `stella` | 海星 | 女 | 俏皮甜美 | 10 |
| `tide` | 暗潮 | 男 | 低沉浑厚 | 10 |

海星/暗潮只支持 10 种语言的代码清单（来自逆向备忘，**未逐语言实测**）：
`ar en id ja ko ms th vi yue zh`。

`gender` 字段原始值到底是什么（数字还是字符串）没有记下来，本包里的女/男是归一化过的。

## 3. 切音色

```
POST /api/v0/chat/tts/voice
Authorization: Bearer <userToken>
Content-Type: application/json

{"voice_id":"tide"}
```

返回 `data.biz_code`：`0` 成功，`1` 音色已下线，`2` 参数错（这个对照来自逆向备忘，`0` 之外的没见过）。

**这是服务端会话级状态**：切一次之后，后面所有合成都是这个音色，直到你再切一次。
所以合成前要先切，再取票、再建连。

## 4. WebSocket 合成

```
wss://chat.deepseek.com/api/v0/chat/tts/
  ?chat_session_id=<会话id>
  &message_id=<消息id>
  &ticket=<票>
  &mode=manual
  &format=pcm|opus
```

`chat_session_id` 就是网页端 URL 里 `/a/chat/s/<uuid>` 的那段。`message_id` 是会话里具体某条消息的 id。

断线续传时再补三个 query 参数：`audio_id`、`received_seq`、`played_seq`（见 §7）。

### 服务端 -> 客户端：文本帧

连接建立后先来一个 `ready`：

```json
{"event":"ready","audio_id":"<uuid>","format":"pcm","voice_id":"mira","trace_id":"<...>"}
```

`format` 是**服务端实际给的格式**，不一定等于你请求的。以它为准。

结束是 `finish`：

```json
{"event":"finish","code":0,"msg":"success"}
```

`code` 非 0 就是失败，含义见 §6。

### 服务端 -> 客户端：二进制帧

每帧的布局：

```
 0        1        2        3        4                            len-1
+--------+--------+--------+--------+------------------------------+
|            seq (uint32, 大端)     |          负载 ...            |
+--------+--------+--------+--------+------------------------------+
```

- `seq`：4 字节**大端**无符号整数。
- 负载：第 4 字节之后的全部内容。

官方实现就是 `new DataView(e).getUint32(0, false)` 加 `new Uint8Array(e, 4)`，
注意 `getUint32` 的第二个参数是 `false`（大端）。写反了不会报错，只会得到一堆天文数字 seq。

**seq 从 0 开始**（推断，见 §8）：官方状态机里 `receivedSeq` 初值是 `-1`，
且 `receivedCount = receivedSeq + 1` —— 也就是「收到的帧数 = 最后一个 seq + 1」，
这只在 seq 从 0 连续递增时成立。

### 客户端 -> 服务端：文本帧

```json
{"event":"ack","received_seq":<n>,"played_seq":<m>}
{"event":"finish"}
{"event":"abort","reason":"<...>"}
```

官方实现：

```js
sendAck(e, t)    { this.sendJson({ event: "ack", received_seq: e, played_seq: t }); }
sendAbort(e)     { this.sendJson({ event: "abort", reason: e }); }
sendFinish()     { this.sendJson({ event: "finish" }); }
```

调用点：

- 收到 `ready` 之后不动。
- **首帧到达**时启动一个 1000ms 的定时器：`setInterval(() => sendAck(progress.receivedCount, pipeline.playedFrames), 1000)`。
- 收到服务端 `finish` 之后回一句 `{"event":"finish"}`，然后拆连接。
- 用户中断时发 `{"event":"abort","reason":...}`。

### ack 里两个 seq 的口径（容易搞错）

- `received_seq` = **收到的帧数**（不是最后一个 seq 的下标）。`progress.receivedCount` 就是
  `receivedSeq + 1`。seq 从 0 起的话，收满 26 帧后应发 `received_seq: 26`。
- `played_seq` = **已播出的 100ms 格数**，不是帧数。官方：

  ```js
  get playedFrames() {
    if (!this.hasScheduled) return 0;
    const e = Math.max(0, this.ctx.currentTime - this.segmentStartTime);
    return Math.floor(Math.min(this.samplesBeforeSegment + Math.round(24000 * e), this.scheduledSamples) / 2400);
  }
  // 2400 采样 @ 24kHz = 100ms；遥测里也是 playedMs = 100 * playedFrames
  ```

  所以 `played_seq` 是音频时间轴上的量，跟「第几帧」没关系。

需要说明的是：2026-09-12 那次跑通的探针发的其实是 `{received_seq: <最后一个seq>, played_seq: <同一个值>}`，
每帧发一次，也把 26 帧全收齐了。**所以服务端看起来两种口径都收**，或者这个 ack 本身偏建议性质。
本包默认按官方口径（`ackMode: 'count'`），另留了 `ackMode: 'index'` 复现探针那种写法。

## 5. pcm 和 opus 的区别

| | `format=pcm` | `format=opus` |
|---|---|---|
| 负载 | 24kHz / 单声道 / s16le 裸流 | **裸 Opus 包**，没有 Ogg 容器 |
| 2026-09-12 实测 | 26 帧 / 124426 字节 / 2.59 秒（同一句 14 字中文） | 24 帧 / 7351 字节 |
| 换 tide 同句 | 30 帧 / 142080 字节 | 未测 |
| 能不能直接用 | 能，套个 WAV 头就能播 | 不能，得先过 Opus 解码器 |

opus 是裸包这一点从 chunk 里能确认：解码器有三种实现，按 `["wasm","webcodecs","pcm"]` 的顺序挑，
WebCodecs 那路的配置就是

```js
decoder.configure({ codec: "opus", sampleRate: 24000, numberOfChannels: 1 })
```

喂给 `AudioDecoder` 的是一个个独立的 Opus 包（`EncodedAudioChunk`），chunk 里全文没有 `ogg` 字样。
所以**别指望把 opus 那些帧直接拼起来就是个能播的文件** —— 想用的话得自己封进 Ogg/WebM。

网页端默认走 opus，解码器起不来时回退：

```js
// 触发 "format-fallback" 之后
this.requestedFormat = "pcm";
this.finish = null;
this.streamEpoch = 0;
this.progress.resetForNewStream();
this.pipeline.teardown();
this.pipeline = this.createPipeline();
this.transport.reconnectWithFormat("pcm");   // 丢掉重连，换 pcm 重来
```

也就是说 pcm 这条路是官方代码里写死的回退路径，稳定。本包 CLI 默认也是 pcm。

## 6. 错误码

枚举直接来自 `main.js`（`dC.me`），不是从提示文案反推的：

| code | 名字 | 大概什么意思 |
|---|---|---|
| 0 | `SUCCESS` | 成功 |
| 1 | `INTERNAL_ERROR` | 服务端内部错误 |
| 2 | `INVALID_INPUT` | 参数不对（会话/消息 id 错了） |
| 3 | `SERVICE_ERROR` | 服务端业务异常 |
| 4 | `QUOTA_EXCEEDED` | 朗读额度用完（今日限额） |
| 5 | `RATE_LIMIT_REACHED` | 触发限流 |
| 6 | `NO_CONTENT` | 这条消息没有可朗读的正文 |
| 7 | `UNSUPPORTED_LANGUAGE` | 语言不支持朗读 |
| 8 | `VOICE_UNSUPPORTED_LANGUAGE` | 这个音色不支持当前语言 |
| 9 | `NOT_AVAILABLE` | 服务端未对该账号放行（灰测/地区） |
| 10 | `RESUME_EXPIRED` | 续传票据过期 |
| 11 | `FORBIDDEN` | 被拒绝 |
| 12 | `CONTENT_FILTER` | 内容被安全过滤挡住 |

跟合成有关的错误码会出现在 `finish.code` 里。另外服务端也可能直接 1006 断连不给 `finish`。

## 7. 断线续传

官方状态机在有 `ready` 之后遇到连接断开会走 `resume`：

```js
resume(audioId, receivedSeq, playedSeq) {
  this.resumeParams = { audioId, receivedSeq, playedSeq };
  this.episodeDeadlineAt = Date.now() + this.deps.resumeMaxTimeMs;
  // ... 重新 issueTicket，然后带上这三个参数重连
}

// 重连时：
buildUrl(wsEndpoint, streamParams, { ticket, mode: "manual", format }, {
  audio_id: audioId, received_seq: receivedSeq, played_seq: playedSeq,
})
```

注意重连**仍然要重新取票**（`issueTicket(signal, 1)`），票的一次性对续传同样适用。
`received_seq` 传的是 `progress.receivedCount`（帧数），`played_seq` 是 100ms 格数。

本包没有实现自动续传（`synthesize` 在断线时直接报错），但 `buildTtsUrl` 支持传 `resume` 参数。

## 8. 限制

### 请求里没有正文

这一条必须说清楚：合成请求里只有 `chat_session_id` 和 `message_id`，**没有任何文本参数**。

```
?chat_session_id=<sid>&message_id=<mid>&ticket=<票>&mode=manual&format=pcm
```

「读哪段文字」是服务端拿这两个 id 去你自己的会话里查出来的。也就是说：

- 你**没法**用它朗读任意字符串。
- 想让它读一段文字，得先让那段文字成为会话里的一条消息。
- 消息必须是服务端认可的、有正文的那条（`message_id` 传错大概率拿到 `code=2` 或 `code=6`）。

### mode 恒为 manual

`mode=manual` 是网页端写死的值。App 那边有语音对话模式，网页端没有。

### 其他

- 音色接口需要登录态，不是公开接口。
- 票一次性，每轮连接前重新取。
- `format=opus` 给的是裸包，需要自己封装才能播。
- 朗读受服务端额度/风控约束（4 / 5 / 12 这些码）。

## 9. 没验证到的部分

诚实列一下。下面这些要么是推断，要么没机会验证：

1. **seq 从 0 开始** —— 从官方状态机的 `receivedSeq = -1` / `receivedCount = receivedSeq + 1` 推断出来的，
   没有线上抓包逐帧确认。本包不写死起点（第一帧的 seq 就是基准），所以起点是 0 还是 1 都能正常工作。
2. **真实端到端合成** —— 本次没有 token，没有跑过 `synthesize` 的真实网络路径。
   实现依据是产物代码 + 2026-09-12 的实测记录，测试用的是假 WebSocket 回放。
3. **ack 到底是不是必须的** —— 官方发，早期探针用另一种口径发也成功。服务端不 ack 会怎样没测过。
4. **HTTP 请求还需要别的头吗** —— 目前只发了 `content-type` / `accept` / `user-agent` / `authorization`。
   官方前端走的是它自己的 http 封装（`withDefaultHttpContext`），可能还带了别的头，没验证过。
5. **ws 握手要不要 `Origin` 头** —— 浏览器必定会带，Node 不带。本包默认塞一个
   `Origin: https://chat.deepseek.com`（undici 的非标准扩展），塞不进去也不报错。服务端是否校验，不知道。
6. **`gender` 字段的原始值** —— 只记了归一化后的女/男。
7. **stella / tide 的 10 种语言清单** —— 出自逆向备忘，没有逐语言打接口核对。
8. **`color_palette` 字段** —— 早期备忘里提到过，但这一版客户端没有映射它，所以本包也没写成事实。
9. **续传路径** —— 完全按代码写的，没有实际断线重连验证过。
10. **opus 负载的分帧语义** —— 确认了是裸 Opus 包，但每个包多少采样、能否独立解码没验证。
