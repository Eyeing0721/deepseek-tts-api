/**
 * PoW 测试。
 *
 * 这个文件里最重要的东西是 GOLDEN —— 那 13 组 (输入, 摘要) 是从**产物自己的 PoW worker**
 * 里跑出来的（fe-static.deepseek.com/chat/static/76608.8f2a9fa413.js + polyfill chunk
 * 8138.63461459c3.js，用 node:vm 起起来，喂它 challenge 再读回答案）。
 *
 * 也就是说：只要这 13 组对得上，本包的 DeepSeekHashV1 移植就跟线上客户端逐位一致。
 * 这比"我读了一遍代码觉得应该没错"强得多。而且拿本包的哈希出的题，产物的 JS worker 和
 * WASM worker 都解得出来（各 10/10），说明两个实现是同一个算法。
 *
 * 再强调一遍结论：它不是 SHA3-256，也不是 Keccak-256，node:crypto 替代不了。
 * 下面专门有一组用例把这件事钉住（标准 SHA3-256 的期望值对不上）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { DeepSeekSponge, deepseekHashHex } from '../src/deepseek-hash.mjs';
import {
  POW_HEADER,
  buildPowHeader,
  defaultBase64,
  powPrefix,
  solvePowChallenge,
} from '../src/pow.mjs';

/** 从产物 worker 里导出的 golden vectors。别手改，改了对不上就是移植坏了。 */
const GOLDEN = [
  ['', 'e594808bc5b7151ac160c6d39a02e0a8e261ed588578403099e3561dc40c26b3'],
  ['a', '910e595ccfd4af1264d04251f7273f7c28badc11e7de64c0e960419f416ed236'],
  ['abc', 'f841106c601ce9be9bc38525e90d4178d47f21dd8eb9f238fc55ffaa4ca94506'],
  ['hello world', 'd3861d3283d610f532813c30dd15162c6980aed6d34f05aa26caac9baf306f95'],
  ['DeepSeekHashV1', '3fc52c4ae40faa946b1bc0eeb747059a35fba6efaa3d616074e720d6e99436cd'],
  ['SALT_1789318365550_0', 'f1ddfcb4b04760b1868659774f42998c239611ceae5ecf83b77d7f617ff92377'],
  ['SALT_1789318365550_1', '21eb5fd9967e7118ce0e101b6862a270111803aacba906e47a3c50b245ea8666'],
  ['中文测试', '91c65cc175fa2f91871c88a04ea55108a00a6fd6d92ce774401fcab97832b884'],
  // rate = 136 字节，下面是 135 / 136 / 137 / 200 / 272 —— 把吸收时的翻页边界盖住
  ['x'.repeat(135), '83b37f61450bade766525ba50e2989c301c7a6e1dea2a3b75a7ea76c95d220ab'],
  ['y'.repeat(136), 'd64717c313c6ddbabebdfc6de1c25ba66f04ff0b9d8f95ad0b1c7acb8fb9e564'],
  ['z'.repeat(137), '99b41bd1ea50dbb2434d524ec949ae7e2d70c4ebd2b8735d5106ac4cfc37edc2'],
  ['q'.repeat(200), '26a94cf272098ba9008217bb3af335b5e1d4f4a185a4e8ba8c11739cbd145030'],
  ['w'.repeat(272), '2cb1fee551dbe27aa408dd8608b60f0287867739feff01be1a09e0e6be6a670a'],
];

test('DeepSeekHashV1 跟产物 worker 逐位一致（13 组 golden）', () => {
  for (const [input, expected] of GOLDEN) {
    assert.equal(
      deepseekHashHex(input),
      expected,
      `输入 ${JSON.stringify(input.length > 20 ? `${input[0]}x${input.length}` : input)} 对不上`,
    );
  }
});

test('输出恒为 64 个十六进制字符', () => {
  for (const [input] of GOLDEN) {
    assert.match(deepseekHashHex(input), /^[0-9a-f]{64}$/);
  }
});

test('它既不是 SHA3-256 也不是 Keccak-256 —— node:crypto 替代不了', () => {
  const mine = deepseekHashHex('abc');
  assert.equal(mine, GOLDEN[2][1]);
  const sha3 = createHash('sha3-256').update('abc').digest('hex');
  assert.equal(sha3, '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532');
  assert.notEqual(mine, sha3);
  // Keccak-256("abc") 的标准值是 4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45
  assert.notEqual(mine, '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
});

test('空串也有确定的摘要，不是全 0', () => {
  const h = deepseekHashHex('');
  assert.equal(h, GOLDEN[0][1]);
  assert.notEqual(h, '0'.repeat(64));
});

test('同一个输入永远同一个结果（可重复）', () => {
  assert.equal(deepseekHashHex('repeat-me'), deepseekHashHex('repeat-me'));
  assert.notEqual(deepseekHashHex('repeat-me'), deepseekHashHex('repeat-me!'));
});

test('sponge 的 clone/squeeze 不改原状态（求解器靠这个语义）', () => {
  const sp = new DeepSeekSponge(256).absorb(new TextEncoder().encode('prefix_'));
  const a = [...sp.squeeze(6)];
  const b = [...sp.squeeze(6)];
  assert.deepEqual(a, b, 'squeeze 不该改动 sponge 状态');
  const c1 = [...sp.clone().absorb(new TextEncoder().encode('0')).squeeze(6)];
  const c2 = [...sp.clone().absorb(new TextEncoder().encode('0')).squeeze(6)];
  assert.deepEqual(c1, c2, 'clone 出来的两个副本该一样');
  assert.deepEqual([...sp.squeeze(6)], a, '克隆后再 squeeze 原对象还是不变');
});

// ---------------- PoW 求解 ----------------

/** 造一道"我们一定能解出来"的题：先挑答案，再反推 challenge。 */
function makeChallenge({ salt = 's', expireAt = 1789318365550, answer = 7, signature = 'sig' } = {}) {
  const prefix = powPrefix({ salt, expireAt });
  return {
    challenge: {
      algorithm: 'DeepSeekHashV1',
      challenge: deepseekHashHex(prefix + answer),
      salt,
      difficulty: answer + 1,
      signature,
      expire_at: expireAt,
      expire_after: 600,
    },
    prefix,
    answer,
  };
}

test('challenge 能解出预先埋好的答案', () => {
  for (const answer of [0, 1, 7, 123, 500]) {
    const { challenge } = makeChallenge({ answer, salt: `salt-${answer}` });
    const r = solvePowChallenge(challenge);
    assert.equal(r.answer, answer);
    assert.equal(r.iterations, answer + 1);
    assert.ok(r.elapsedMs >= 0);
  }
});

test('prefix 用的是 expire_at，不是 signature —— 这是最容易搞错的地方', () => {
  const { challenge, prefix } = makeChallenge({ salt: 'S', expireAt: 111, answer: 3, signature: 'SIG' });
  assert.equal(prefix, 'S_111_');
  assert.notEqual(prefix, 'S_SIG_');
  assert.equal(solvePowChallenge(challenge).answer, 3);

  // 故意把 signature 换成 prefix 里那个字段该有的位置，就解不出来了
  const wrong = { ...challenge, signature: '111' };
  // signature 不参与 prefix，所以换掉 signature 不影响能否解出
  assert.equal(solvePowChallenge(wrong).answer, 3);

  // 反过来说：如果按"用 signature 拼 prefix"去造题，本包是解不出来的
  const badPrefix = `S_SIG_`;
  const badChallenge = {
    ...challenge,
    challenge: deepseekHashHex(badPrefix + 3),
  };
  assert.throws(() => solvePowChallenge(badChallenge), /没解出来/);
});

test('camelCase 的 expireAt 也认（官方前端会把它驼峰化）', () => {
  const { challenge, answer } = makeChallenge({ answer: 5 });
  const camel = { ...challenge, expireAt: challenge.expire_at };
  delete camel.expire_at;
  assert.equal(solvePowChallenge(camel).answer, answer);
});

test('找不到答案时报清楚的错，不返回半个结果', () => {
  const { challenge } = makeChallenge({ answer: 9 });
  const impossible = { ...challenge, challenge: 'ab'.repeat(32), difficulty: 50 };
  assert.throws(() => solvePowChallenge(impossible), (err) => {
    assert.match(err.message, /PoW 没解出来/);
    assert.equal(err.kind, 'protocol');
    return true;
  });
});

test('maxIterations 会截断搜索，并在报错里说清楚', () => {
  const { challenge } = makeChallenge({ answer: 500 });
  assert.throws(
    () => solvePowChallenge(challenge, { maxIterations: 10 }),
    (err) => {
      assert.match(err.message, /截断/);
      assert.equal(err.details.limit, 10);
      return true;
    },
  );
});

test('难度上界只支持正整数', () => {
  const { challenge } = makeChallenge({ answer: 1 });
  for (const difficulty of [0, -1, 1.5, '10', null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(
      () => solvePowChallenge({ ...challenge, difficulty }),
      (err) => {
        assert.equal(err.kind, 'protocol');
        assert.match(err.message, /difficulty/);
        return true;
      },
      `difficulty=${String(difficulty)} 应该被拒`,
    );
  }
});

test('缺字段 / 算法不对 / 参数不是对象，都要报 protocol 错', () => {
  const { challenge } = makeChallenge({ answer: 2 });
  assert.throws(() => solvePowChallenge(null), (e) => e.kind === 'usage');
  assert.throws(() => solvePowChallenge({ ...challenge, algorithm: 'SHA256' }), (e) =>
    e.kind === 'protocol' && /不认识的 PoW 算法/.test(e.message));
  assert.throws(() => solvePowChallenge({ ...challenge, challenge: undefined }), /没有 challenge/);
  assert.throws(() => solvePowChallenge({ ...challenge, salt: undefined }), /没有 salt/);
  const noExpire = { ...challenge };
  delete noExpire.expire_at;
  assert.throws(() => solvePowChallenge(noExpire), /没有 expire_at/);
});

// ---------------- 请求头 ----------------

test('PoW 请求头就是 base64(JSON)，字段和官方一一对应', () => {
  const { challenge, answer } = makeChallenge({ answer: 11, salt: 'SALT', expireAt: 999 });
  const [name, value] = buildPowHeader(challenge, answer, '/api/v0/chat/completion');
  assert.equal(name, 'X-DS-PoW-Response');
  assert.equal(name, POW_HEADER);

  const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  assert.deepEqual(Object.keys(decoded).sort(), [
    'algorithm',
    'answer',
    'challenge',
    'salt',
    'signature',
    'target_path',
  ]);
  assert.equal(decoded.algorithm, 'DeepSeekHashV1');
  assert.equal(decoded.challenge, challenge.challenge);
  assert.equal(decoded.salt, 'SALT');
  assert.equal(decoded.answer, 11);
  assert.equal(decoded.signature, 'sig');
  assert.equal(decoded.target_path, '/api/v0/chat/completion');
});

test('base64 就是标准 base64（web 端 platform=web 时 base64Encode 就是 btoa）', () => {
  assert.equal(defaultBase64('{"a":1}'), Buffer.from('{"a":1}', 'utf8').toString('base64'));
  assert.equal(defaultBase64('{"a":1}'), 'eyJhIjoxfQ==');
  // 编出来的必须是 ASCII，方便当 HTTP 头
  assert.match(defaultBase64('{"a":1}'), /^[A-Za-z0-9+/=]+$/);
});

test('powPrefix 就是 salt_expireAt_ 两段下划线', () => {
  assert.equal(powPrefix({ salt: 'a', expireAt: 1 }), 'a_1_');
  assert.equal(powPrefix({ salt: '', expireAt: '' }), '__');
});
