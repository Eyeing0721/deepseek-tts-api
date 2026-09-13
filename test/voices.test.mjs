/**
 * 音色表完整性。
 *
 * 表里的内容来自 2026-09-12 在真实账号上调 /api/v0/chat/tts/voices 的实测记录。
 * 测试的作用是：以后谁手滑改错一个字，或者把 tide 的语言数抄成 29，这里会炸。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ErrorCode, VOICES, VOICE_IDS, getVoice, codeHint, codeName, isSuccessCode } from '../src/index.mjs';

test('正好四个音色，id 就是这四个', () => {
  assert.equal(VOICES.length, 4);
  assert.deepEqual([...VOICE_IDS], ['mira', 'echo', 'stella', 'tide']);
});

test('中文名 / 性别 / 描述 逐个对', () => {
  const expected = {
    mira: { name: '贝壳', gender: 'female', description: '百变活泼' },
    echo: { name: '白浪', gender: 'male', description: '明朗坚定' },
    stella: { name: '海星', gender: 'female', description: '俏皮甜美' },
    tide: { name: '暗潮', gender: 'male', description: '低沉浑厚' },
  };
  for (const [id, want] of Object.entries(expected)) {
    const v = getVoice(id);
    assert.ok(v, `找不到音色 ${id}`);
    assert.equal(v.name, want.name, `${id} 的中文名`);
    assert.equal(v.gender, want.gender, `${id} 的性别`);
    assert.equal(v.description, want.description, `${id} 的描述`);
    assert.ok(v.descriptionEn.length > 0, `${id} 缺英文描述`);
    assert.equal(v.id, id);
  }
});

test('语言数：贝壳/白浪 29，海星/暗潮 10', () => {
  assert.equal(getVoice('mira').languageCount, 29);
  assert.equal(getVoice('echo').languageCount, 29);
  assert.equal(getVoice('stella').languageCount, 10);
  assert.equal(getVoice('tide').languageCount, 10);
});

test('默认音色只有 mira 一个', () => {
  assert.equal(VOICES.filter((v) => v.isDefault).length, 1);
  assert.equal(getVoice('mira').isDefault, true);
  for (const id of ['echo', 'stella', 'tide']) {
    assert.equal(getVoice(id).isDefault, false);
  }
});

test('内置的试听地址只有实测过的那两个，而且是 https + .mp3', () => {
  // 这条测试同时是在记录一个已知缺口：echo / stella 的 CDN 文件名带内容哈希，
  // 没登录态拿不到，所以内置表里就是空的。见 README 的「限制」。
  assert.deepEqual(Object.keys(getVoice('mira').demoUrls), ['zh']);
  assert.deepEqual(Object.keys(getVoice('tide').demoUrls), ['zh']);
  assert.deepEqual(Object.keys(getVoice('echo').demoUrls), []);
  assert.deepEqual(Object.keys(getVoice('stella').demoUrls), []);

  assert.equal(
    getVoice('mira').demoUrls.zh,
    'https://cdn.deepseek.com/chat/tts/voice-demos/mira_zh.79e34098.mp3',
  );
  assert.equal(
    getVoice('tide').demoUrls.zh,
    'https://cdn.deepseek.com/chat/tts/voice-demos/tide_zh.42b17eef.mp3',
  );

  for (const v of VOICES) {
    for (const url of Object.values(v.demoUrls)) {
      assert.match(url, /^https:\/\/cdn\.deepseek\.com\/chat\/tts\/voice-demos\/.+\.mp3$/);
    }
  }
});

test('两个哈希是各自独立的 —— 别以为换个音色名就能拼出来', () => {
  const mira = getVoice('mira').demoUrls.zh;
  const tide = getVoice('tide').demoUrls.zh;
  const hashOf = (u) => u.slice(u.lastIndexOf('.', u.lastIndexOf('.') - 1) + 1, u.lastIndexOf('.'));
  assert.notEqual(hashOf(mira), hashOf(tide));
});

test('getVoice 大小写不敏感，空值/未知给 undefined', () => {
  assert.equal(getVoice('MIRA').name, '贝壳');
  assert.equal(getVoice('  Tide  ').name, '暗潮');
  assert.equal(getVoice('nope'), undefined);
  assert.equal(getVoice(''), undefined);
  assert.equal(getVoice(null), undefined);
  assert.equal(getVoice(undefined), undefined);
  assert.equal(getVoice(42), undefined);
});

test('表是冻结的，防止运行时被改', () => {
  assert.ok(Object.isFrozen(VOICES));
  assert.ok(Object.isFrozen(VOICES[0]));
  assert.ok(Object.isFrozen(VOICES[0].demoUrls));
  assert.throws(() => {
    VOICES.push({ id: 'fake' });
  }, TypeError);
  assert.throws(() => {
    VOICES[0].name = '改掉';
  }, TypeError);
});

test('错误码表就是 main.js 里那 13 个，一个不多一个不少', () => {
  const expected = {
    SUCCESS: 0,
    INTERNAL_ERROR: 1,
    INVALID_INPUT: 2,
    SERVICE_ERROR: 3,
    QUOTA_EXCEEDED: 4,
    RATE_LIMIT_REACHED: 5,
    NO_CONTENT: 6,
    UNSUPPORTED_LANGUAGE: 7,
    VOICE_UNSUPPORTED_LANGUAGE: 8,
    NOT_AVAILABLE: 9,
    RESUME_EXPIRED: 10,
    FORBIDDEN: 11,
    CONTENT_FILTER: 12,
  };
  assert.deepEqual({ ...ErrorCode }, expected);
});

test('codeName / isSuccessCode / codeHint 行为正确', () => {
  assert.equal(codeName(0), 'SUCCESS');
  assert.equal(codeName(9), 'NOT_AVAILABLE');
  assert.equal(codeName(11), 'FORBIDDEN');
  assert.equal(codeName(99), 'UNKNOWN(99)');
  assert.equal(codeName(undefined), 'UNKNOWN');

  assert.equal(isSuccessCode(0), true);
  assert.equal(isSuccessCode(4), false);
  assert.equal(isSuccessCode('0'), false);

  assert.match(codeHint(4), /额度/);
  assert.match(codeHint(5), /限流|频繁/);
  assert.match(codeHint(9), /放行|灰测/);
  assert.equal(codeHint(99), null);
});
