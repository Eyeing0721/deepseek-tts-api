/**
 * CLI 参数解析。这部分没有任何副作用，所以能纯测。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COMMANDS, numericOptions, parseArgv, parseHeaderList } from '../src/cli-args.mjs';

test('七个子命令都认得', () => {
  assert.deepEqual([...COMMANDS], ['voices', 'demo', 'probe', 'read', 'say', 'wav', 'help']);
});

test('say：位置参数拼成文本，选项各就各位', () => {
  const p = parseArgv(['say', '你好', '世界', '--voice', 'tide', '-o', 'a.wav', '--keep']);
  assert.deepEqual(p.errors, []);
  assert.equal(p.command, 'say');
  assert.deepEqual(p.positionals, ['你好', '世界']);
  assert.equal(p.options.voice, 'tide');
  assert.equal(p.options.out, 'a.wav');
  assert.equal(p.options.keep, true);
});

test('say：--text 也能给文本', () => {
  const p = parseArgv(['say', '--text', '念这句']);
  assert.deepEqual(p.errors, []);
  assert.equal(p.options.text, '念这句');
  assert.deepEqual(p.positionals, []);
});

test('--via 已经去掉了（只有一种念法，不需要开关）', () => {
  const p = parseArgv(['say', 'x', '--via', 'reply']);
  assert.ok(p.errors.length > 0, '--via 应该被当成不认识的选项');
  assert.equal(p.options.via, undefined);
});

test('--header 可以重复给，收成数组', () => {
  const p = parseArgv(['say', 'x', '--header', 'a: 1', '--header', 'b: 2']);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.options.header, ['a: 1', 'b: 2']);
});

test('--header 只给一次时也收成数组（省得下游判断两种类型）', () => {
  const p = parseArgv(['say', 'x', '--header', 'a: 1']);
  assert.deepEqual(p.options.header, ['a: 1']);
});

test('parseHeaderList 把 "名: 值" 拆开', () => {
  assert.deepEqual(parseHeaderList(['a: 1', 'X-Hif-Leim: zz']), { a: '1', 'X-Hif-Leim': 'zz' });
  // 值里带冒号只切第一个
  assert.deepEqual(parseHeaderList(['referer: https://x/y']), { referer: 'https://x/y' });
  assert.deepEqual(parseHeaderList(undefined), {});
  assert.throws(() => parseHeaderList(['没有冒号']), (e) => e.kind === 'usage');
});

test('--max-iterations / --wait 必须是正整数，并且会进 numericOptions', () => {
  const p = parseArgv(['say', 'x', '--max-iterations', '1000', '--wait', '2000']);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(numericOptions(p.options), { 'max-iterations': 1000, wait: 2000 });
  assert.match(parseArgv(['say', 'x', '--max-iterations', '0']).errors[0], /--max-iterations/);
  assert.match(parseArgv(['say', 'x', '--wait', 'abc']).errors[0], /--wait/);
});

test('read：长短选项混着来', () => {
  const p = parseArgv(['read', '--session', 'sess-abc', '--message', 'msg-1', '-o', 'out.wav', '--voice', 'mira']);
  assert.deepEqual(p.errors, []);
  assert.equal(p.command, 'read');
  assert.deepEqual(p.positionals, []);
  assert.equal(p.options.session, 'sess-abc');
  assert.equal(p.options.message, 'msg-1');
  assert.equal(p.options.out, 'out.wav');
  assert.equal(p.options.voice, 'mira');
  assert.equal(p.help, false);
});

test('demo：位置参数是 voice_id，-o 是输出', () => {
  const p = parseArgv(['demo', 'mira', '-o', 'demo-mira.mp3']);
  assert.deepEqual(p.errors, []);
  assert.equal(p.command, 'demo');
  assert.deepEqual(p.positionals, ['mira']);
  assert.equal(p.options.out, 'demo-mira.mp3');
});

test('wav：两个位置参数', () => {
  const p = parseArgv(['wav', 'in.pcm', 'out.wav', '--rate', '24000']);
  assert.deepEqual(p.errors, []);
  assert.equal(p.command, 'wav');
  assert.deepEqual(p.positionals, ['in.pcm', 'out.wav']);
  assert.equal(p.options.rate, '24000');
  assert.deepEqual(numericOptions(p.options), { rate: 24000 });
});

test('voices 不带任何选项', () => {
  const p = parseArgv(['voices']);
  assert.deepEqual(p.errors, []);
  assert.equal(p.command, 'voices');
  assert.equal(p.help, false);
});

test('--out=值 这种内联写法也认', () => {
  const p = parseArgv(['demo', 'tide', '--out=x.mp3', '--lang=en']);
  assert.deepEqual(p.errors, []);
  assert.equal(p.options.out, 'x.mp3');
  assert.equal(p.options.lang, 'en');
});

test('开关型选项不吃后面的值', () => {
  const p = parseArgv(['probe', '--json', '--no-ws']);
  assert.deepEqual(p.errors, []);
  assert.equal(p.options.json, true);
  assert.equal(p.options['no-ws'], true);
});

test('--format 只认 pcm / opus', () => {
  assert.deepEqual(parseArgv(['read', '--format', 'pcm']).errors, []);
  assert.deepEqual(parseArgv(['read', '--format', 'opus']).errors, []);
  const bad = parseArgv(['read', '--format', 'mp3']);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /--format 只支持 pcm \/ opus/);
  // 校验没过就不该把它塞进 options
  assert.equal(bad.options.format, undefined);
});

test('--ack-mode 只认 count / index', () => {
  assert.deepEqual(parseArgv(['read', '--ack-mode', 'index']).errors, []);
  assert.match(parseArgv(['read', '--ack-mode', 'fast']).errors[0], /--ack-mode/);
});

test('数字型选项必须是正整数', () => {
  assert.deepEqual(parseArgv(['wav', 'a', 'b', '--rate', '16000']).errors, []);
  assert.match(parseArgv(['wav', 'a', 'b', '--rate', 'abc']).errors[0], /--rate 得是正整数/);
  assert.match(parseArgv(['wav', 'a', 'b', '--rate', '0']).errors[0], /--rate 得是正整数/);
  assert.match(parseArgv(['wav', 'a', 'b', '--channels', '-1']).errors[0], /--channels/);
});

test('不认识的选项报错，但不影响后面的解析', () => {
  const p = parseArgv(['read', '--session', 's', '--nope', '--message', 'm']);
  assert.equal(p.errors.length, 1);
  assert.match(p.errors[0], /不认识的选项：--nope/);
  assert.equal(p.options.session, 's');
  assert.equal(p.options.message, 'm');
});

test('短选项不认识也报错', () => {
  const p = parseArgv(['voices', '-x']);
  assert.match(p.errors[0], /不认识的选项：-x/);
});

test('选项后面缺值', () => {
  const p = parseArgv(['read', '--session']);
  assert.equal(p.errors.length, 1);
  assert.match(p.errors[0], /--session 后面缺值/);
});

test('开关型选项带值要报错', () => {
  const p = parseArgv(['probe', '--json=1']);
  assert.match(p.errors[0], /--json 是开关/);
});

test('-- 之后一律当位置参数', () => {
  const p = parseArgv(['demo', '--', '--weird-name']);
  assert.deepEqual(p.errors, []);
  assert.equal(p.command, 'demo');
  assert.deepEqual(p.positionals, ['--weird-name']);
});

test('裸 - 当位置参数，不当选项', () => {
  const p = parseArgv(['wav', '-', 'out.wav']);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.positionals, ['-', 'out.wav']);
});

test('没参数就是 help', () => {
  const p = parseArgv([]);
  assert.equal(p.command, null);
  assert.equal(p.help, true);
});

test('-h 和 --help 都开 help', () => {
  assert.equal(parseArgv(['-h']).help, true);
  assert.equal(parseArgv(['--help']).help, true);
  assert.equal(parseArgv(['read', '--help']).help, true);
  assert.equal(parseArgv(['help']).help, true);
  assert.equal(parseArgv(['help']).command, 'help');
});

test('--version', () => {
  assert.equal(parseArgv(['--version']).version, true);
  assert.equal(parseArgv(['voices']).version, false);
});

test('不是子命令的第一个词会掉进位置参数，command 保持 null', () => {
  const p = parseArgv(['bogus']);
  assert.equal(p.command, null);
  assert.deepEqual(p.positionals, ['bogus']);
  // 有位置参数、没显式 help，所以不算 help 请求
  assert.equal(p.help, false);
});

test('子命令后面再跟一个子命令名，第二个当位置参数', () => {
  const p = parseArgv(['demo', 'voices']);
  assert.equal(p.command, 'demo');
  assert.deepEqual(p.positionals, ['voices']);
});

test('token 能从选项里读到（但别指望它会打印出来）', () => {
  const p = parseArgv(['probe', '--token', 'x'.repeat(64)]);
  assert.deepEqual(p.errors, []);
  assert.equal(p.options.token, 'x'.repeat(64));
});
