/**
 * 参数解析。单独拎出来是为了能脱开进程测 —— CLI 里剩下的都是副作用。
 *
 * 规则很简单，不搞什么花活：
 *   位置参数随便放，选项一律 --long value 或者 -x value，不支持下划线缩写、不支持内联 =（
 *   --out=x 这种顺手支持一下吧，反正一行的事）。
 */

import { FORMATS } from './constants.mjs';
import { usageError } from './errors.mjs';

export const COMMANDS = Object.freeze(['voices', 'demo', 'probe', 'read', 'say', 'wav', 'help']);

/** 选项定义：名字 -> {alias, takesValue, multi, validate} */
const OPTIONS = Object.freeze({
  out: { alias: 'o', takesValue: true },
  session: { takesValue: true },
  message: { takesValue: true },
  voice: { takesValue: true },
  format: {
    takesValue: true,
    validate: (v) => (FORMATS.includes(v) ? null : `--format 只支持 ${FORMATS.join(' / ')}，收到 "${v}"`),
  },
  text: { takesValue: true },
  keep: { takesValue: false },
  header: { takesValue: true, multi: true },
  'max-iterations': {
    takesValue: true,
    validate: (v) => (/^\d+$/.test(v) && Number(v) > 0 ? null : `--max-iterations 得是正整数，收到 "${v}"`),
  },
  wait: {
    takesValue: true,
    validate: (v) => (/^\d+$/.test(v) && Number(v) > 0 ? null : `--wait 得是正整数（毫秒），收到 "${v}"`),
  },
  lang: { takesValue: true },
  token: { takesValue: true },
  rate: {
    takesValue: true,
    validate: (v) => (/^\d+$/.test(v) && Number(v) > 0 ? null : `--rate 得是正整数，收到 "${v}"`),
  },
  channels: {
    takesValue: true,
    validate: (v) => (/^\d+$/.test(v) && Number(v) > 0 ? null : `--channels 得是正整数，收到 "${v}"`),
  },
  timeout: {
    takesValue: true,
    validate: (v) => (/^\d+$/.test(v) && Number(v) > 0 ? null : `--timeout 得是正整数（毫秒），收到 "${v}"`),
  },
  'ack-mode': {
    takesValue: true,
    validate: (v) => (['count', 'index'].includes(v) ? null : `--ack-mode 只支持 count / index，收到 "${v}"`),
  },
  json: { takesValue: false },
  'no-ws': { takesValue: false },
  help: { alias: 'h', takesValue: false },
  version: { takesValue: false },
});

const ALIAS_TO_NAME = Object.freeze(
  Object.fromEntries(
    Object.entries(OPTIONS)
      .filter(([, def]) => def.alias)
      .map(([name, def]) => [def.alias, name]),
  ),
);

export const OPTION_NAMES = Object.freeze(Object.keys(OPTIONS));

/**
 * @param {string[]} argv 已经去掉 node 和脚本路径
 * @returns {{command:string|null, positionals:string[], options:object, errors:string[], help:boolean, version:boolean}}
 */
export function parseArgv(argv = []) {
  const positionals = [];
  const options = {};
  const errors = [];
  let command = null;
  let afterDoubleDash = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (afterDoubleDash) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      afterDoubleDash = true;
      continue;
    }

    if (arg.startsWith('-') && arg !== '-') {
      let name;
      let inlineValue;

      if (arg.startsWith('--')) {
        const eq = arg.indexOf('=');
        name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
        if (eq !== -1) inlineValue = arg.slice(eq + 1);
      } else {
        const short = arg.slice(1);
        name = ALIAS_TO_NAME[short];
        if (!name) {
          errors.push(`不认识的选项：${arg}`);
          continue;
        }
      }

      const def = OPTIONS[name];
      if (!def) {
        errors.push(`不认识的选项：--${name}`);
        continue;
      }

      if (!def.takesValue) {
        if (inlineValue !== undefined) {
          errors.push(`--${name} 是开关，不该带值（收到 "${inlineValue}"）`);
          continue;
        }
        options[name] = true;
        continue;
      }

      let value = inlineValue;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined) {
          errors.push(`--${name} 后面缺值`);
          continue;
        }
        value = next;
        i++;
      }
      if (def.validate) {
        const problem = def.validate(value);
        if (problem) {
          errors.push(problem);
          continue;
        }
      }
      options[name] = def.multi
        ? [...(Array.isArray(options[name]) ? options[name] : options[name] === undefined ? [] : [options[name]]), value]
        : value;
      continue;
    }

    if (command === null && COMMANDS.includes(arg)) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }

  return {
    command,
    positionals,
    options,
    errors,
    help: Boolean(options.help) || command === 'help' || (command === null && positionals.length === 0),
    version: Boolean(options.version),
  };
}

/** 把 "--rate 24000" 这种文本选项转成数字，集中在一处，省得每个命令各写一遍。 */
export function numericOptions(options) {
  const out = {};
  for (const key of ['rate', 'channels', 'timeout', 'max-iterations', 'wait']) {
    if (options[key] !== undefined) out[key] = Number(options[key]);
  }
  return out;
}

/**
 * 把 ["a: b", "c: d"] 解析成 { a: 'b', c: 'd' }。
 * 官方前端还会带一批指纹头（x-hif-leim / x-hif-dliq 之类），本包不伪造它们；
 * 万一服务端非要，就用这个口子自己塞。
 */
export function parseHeaderList(list) {
  const headers = {};
  const items = Array.isArray(list) ? list : list === undefined ? [] : [list];
  for (const raw of items) {
    const idx = String(raw).indexOf(':');
    if (idx <= 0) throw usageError(`--header 得写成 "名字: 值" 的形式，收到 "${raw}"`);
    const name = String(raw).slice(0, idx).trim();
    const value = String(raw).slice(idx + 1).trim();
    if (!name) throw usageError(`--header 的名字是空的："${raw}"`);
    headers[name] = value;
  }
  return headers;
}

export function requireOption(parsed, name, hint) {
  const v = parsed.options[name];
  if (v === undefined || v === '') {
    throw usageError(`缺参数 --${name}${hint ? `（${hint}）` : ''}`);
  }
  return v;
}

export function requirePositional(parsed, index, label, hint) {
  const v = parsed.positionals[index];
  if (v === undefined || v === '') {
    throw usageError(`缺参数 <${label}>${hint ? `（${hint}）` : ''}`);
  }
  return v;
}
