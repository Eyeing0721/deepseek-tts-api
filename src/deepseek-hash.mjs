/**
 * DeepSeekHashV1 —— DeepSeek 工作量证明用的哈希。
 *
 * 这不是 SHA3-256，也不是 Keccak-256。实测过：拿标准 SHA3-256 出题，
 * 官方的 JS worker 和 WASM worker 都是 0/8 解不出来；用下面这个置换，两边都 8/8。
 * 所以 node:crypto 替代不了它，只能照抄。
 *
 * 出处：2026-09-12 线上产物里的 PoW worker
 *   - WASM 版 https://fe-static.deepseek.com/chat/static/37627.ebf6d8f55d.js
 *     （配 static/sha3_wasm_bg.7b9ca65ddd.wasm）
 *   - JS 版   https://fe-static.deepseek.com/chat/static/76608.8f2a9fa413.js
 *     （配 polyfill chunk 8138.63461459c3.js）
 * 两份实现在同一批随机题上给出的答案完全一致（8/8 对 8/8），所以抄 JS 那份是安全的。
 *
 * 和标准 Keccak-f[1600] 的差别（不是笔误，是原样照抄）：
 *   1. 置换只跑 23 轮（round 1..23），不是标准的 24 轮。
 *   2. 内部用 32 位半字数组 (hi, lo) 表示每个 lane，字节装载/取出时高低字是反的。
 *   3. 每 5 个连续 lane 为一组做 chi，而不是标准里按行 (x) 分组。
 * 结果就是它自成一个哈希，只跟它自己对得上。
 */

/** 一次置换的状态：25 个 lane，每个 lane 占两个 uint32（[hi, lo] 顺序）。 */
const STATE_WORDS = 50;

/**
 * 标准 Keccak 的轮常数，但这里是按「两个 uint32 一组」直接展开的，
 * 就是原文件里那 50 个数字，没动过。
 */
const RC = new Uint32Array([
  0, 1, 0, 32898, 0x80000000, 32906, 0x80000000, 0x80008000, 0, 32907,
  0, 0x80000001, 0x80000000, 0x80008081, 0x80000000, 32777, 0, 138,
  0, 136, 0, 0x80008009, 0, 0x8000000a, 0, 0x8000808b,
  0x80000000, 139, 0x80000000, 32905, 0x80000000, 32771, 0x80000000, 32770,
  0x80000000, 128, 0, 32778, 0x80000000, 0x8000000a, 0x80000000, 0x80008081,
  0x80000000, 32896, 0, 0x80000001, 0x80000000, 0x80008008,
]);

/** rho/pi 用的两个表，照抄自产物。 */
const RHO = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const PI = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];

/** lane 拷贝。产物里那个 `(t,e)=>(r,n)=>{...}` 就是这个意思。 */
function copyLane(src, srcLane, dst, dstLane) {
  const s = srcLane * 2;
  const d = dstLane * 2;
  dst[d] = src[s];
  dst[d + 1] = src[s + 1];
}

/** theta */
function theta(A, C, D, W) {
  for (let t = 0; t < 5; t++) {
    const n = 2 * t;
    const i = (t + 5) * 2;
    const o = (t + 10) * 2;
    const f = (t + 15) * 2;
    const s = (t + 20) * 2;
    C[n] = A[n] ^ A[i] ^ A[o] ^ A[f] ^ A[s];
    C[n + 1] = A[n + 1] ^ A[i + 1] ^ A[o + 1] ^ A[f + 1] ^ A[s + 1];
  }
  for (let t = 0; t < 5; t++) {
    copyLane(C, (t + 1) % 5, W, 0);
    const o = W[0];
    const f = W[1];
    W[0] = (o << 1) | (f >>> 31);
    W[1] = (f << 1) | (o >>> 31);
    D[2 * t] = C[((t + 4) % 5) * 2] ^ W[0];
    D[2 * t + 1] = C[((t + 4) % 5) * 2 + 1] ^ W[1];
    for (let r = 0; r < 25; r += 5) {
      A[(r + t) * 2] ^= D[2 * t];
      A[(r + t) * 2 + 1] ^= D[2 * t + 1];
    }
  }
}

/** rho + pi */
function rhoPi(A, C, W) {
  let i = 0;
  copyLane(A, i + 1, W, i);
  for (; i < 24; i++) {
    const t = RHO[i];
    const a = PI[i];
    copyLane(A, t, C, 0);
    const o = W[0];
    const f = W[1];
    const u = 32 - a;
    const s = a < 32 ? 0 : 1;
    W[s] = (o << a) | (f >>> u);
    W[(s + 1) % 2] = (f << a) | (o >>> u);
    copyLane(W, 0, A, t);
    copyLane(C, 0, W, 0);
  }
}

/** chi */
function chi(A, C) {
  for (let t = 0; t < 25; t += 5) {
    for (let n = 0; n < 5; n++) copyLane(A, t + n, C, n);
    for (let n = 0; n < 5; n++) {
      const i = (t + n) * 2;
      const o = ((n + 1) % 5) * 2;
      const f = ((n + 2) % 5) * 2;
      A[i] ^= ~C[o] & C[f];
      A[i + 1] ^= ~C[o + 1] & C[f + 1];
    }
  }
}

/**
 * iota。
 *
 * 注意原实现是 `e[0]^=d[n], e[1]^=d[n+1]`，n = 2*round —— 也就是说轮常数**永远异或进
 * lane 0**，而不是像标准 Keccak 那样异或进 lane round。照抄，不要"顺手修正"。
 */
function iota(A, round) {
  const n = 2 * round;
  A[0] ^= RC[n];
  A[1] ^= RC[n + 1];
}

/** 注意：这里刻意是 23 轮（round 1..23），跟产物一致。 */
function keccakPermute(A) {
  const C = new Uint32Array(10);
  const D = new Uint32Array(10);
  const W = new Uint32Array(2);
  for (let round = 1; round < 24; round++) {
    theta(A, C, D, W);
    rhoPi(A, C, W);
    chi(A, C);
    iota(A, round);
  }
}

/** 把 rate 长度的字节块 XOR 进状态（产物的 `I`）。 */
function xorBlockIntoState(bytes, state) {
  for (let r = 0; r < bytes.length; r += 8) {
    const n = r / 4;
    state[n] ^= (bytes[r + 7] << 24) | (bytes[r + 6] << 16) | (bytes[r + 5] << 8) | bytes[r + 4];
    state[n + 1] ^= (bytes[r + 3] << 24) | (bytes[r + 2] << 16) | (bytes[r + 1] << 8) | bytes[r];
  }
}

/** 把状态挤出成字节（产物的 `A`）。 */
function stateToBytes(state, out) {
  for (let r = 0; r < out.length; r += 8) {
    const n = r / 4;
    out[r] = state[n + 1];
    out[r + 1] = state[n + 1] >>> 8;
    out[r + 2] = state[n + 1] >>> 16;
    out[r + 3] = state[n + 1] >>> 24;
    out[r + 4] = state[n];
    out[r + 5] = state[n] >>> 8;
    out[r + 6] = state[n] >>> 16;
    out[r + 7] = state[n] >>> 24;
  }
}

const HEX = '0123456789abcdef';
export function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return s;
}

const encoder = new TextEncoder();

/**
 * 产物的 sponge：capacity 以 bit 计，rate = 200 - capacity/4 字节，输出 capacity/8 字节。
 * 只要 capacity=256 / padding=6 这一种用法（就是 SHA3 那套域分隔常量），但保留参数。
 */
export class DeepSeekSponge {
  constructor(capacityBits = 256) {
    this.capacityBits = capacityBits;
    this.rate = 200 - capacityBits / 4;
    this.outLen = capacityBits / 8;
    this.state = new Uint32Array(STATE_WORDS);
    this.queue = new Uint8Array(this.rate);
    this.queueOffset = 0;
  }

  absorb(bytes) {
    for (let i = 0; i < bytes.length; i++) {
      this.queue[this.queueOffset++] = bytes[i];
      if (this.queueOffset >= this.rate) {
        xorBlockIntoState(this.queue, this.state);
        keccakPermute(this.state);
        this.queueOffset = 0;
      }
    }
    return this;
  }

  clone() {
    const c = new DeepSeekSponge(this.capacityBits);
    c.state.set(this.state);
    c.queue.set(this.queue);
    c.queueOffset = this.queueOffset;
    return c;
  }

  /** 挤出 outLen 字节。padding 默认 6（SHA3 域分隔）。 */
  squeeze(padding = 6) {
    const out = new Uint8Array(this.outLen);
    const q = Uint8Array.from(this.queue);
    q.fill(0, this.queueOffset);
    q[this.queueOffset] |= padding;
    q[this.rate - 1] |= 0x80;
    const st = Uint32Array.from(this.state);
    xorBlockIntoState(q, st);
    // 输出比 rate 短，所以这里只会置换一次
    keccakPermute(st);
    stateToBytes(st, out);
    return out;
  }

  digest(bytes) {
    return this.clone().absorb(bytes).squeeze(6);
  }

  digestHex(bytes) {
    return toHex(this.digest(bytes));
  }

  /** 直接把一个字符串哈希成 64 位十六进制。 */
  static hashHex(str) {
    return toHex(new DeepSeekSponge(256).absorb(encoder.encode(str)).squeeze(6));
  }
}

/** 方便调用：DeepSeekHashV1(字符串) -> 64 字符 hex。 */
export function deepseekHashHex(str) {
  return DeepSeekSponge.hashHex(str);
}

export const DEEPSEEK_HASH_NAME = 'DeepSeekHashV1';
