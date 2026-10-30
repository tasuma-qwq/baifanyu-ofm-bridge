import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { FORBIDDEN_PROVIDERS, laneKey } from './model-lanes.js';

// Discovery is intentionally limited to OFM-owned provider families. Selecting
// anything else requires an explicit project-level integration, never a guess.
const OFM_PROVIDERS = new Set(['our-free-model', 'our-free-model-region-limited', 'kilo', 'eac', 'qoder', 'qodercn', 'trae', 'lobster', 'lobsterai', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini']);
export const PUBLIC_POOL_NOTICE = '免费公开池是共享服务，可能限流、拥堵、超时，受网络与地区影响，模型会变化；不保证无限量或长期可用。';
export const ACCOUNT_SETUP_GUIDE = '需要自己的账号时，在 DSH 设置 → Our Free Model → 账号/渠道页面添加并授权账号，核对额度及可能费用、启用模型并刷新目录，再用 setup --lanes 显式选择。详见 https://github.com/tasuma-qwq/baifanyu-ofm-bridge/blob/main/docs/public-pool-and-accounts.md';
export function defaultConfigFile(dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')) {
  return path.join(dshHome, 'baifanyu-ofm', 'config.local.json');
}
export function publicPoolLanes(catalog) {
  // Do not infer "free" from an OFM provider name alone: that group can also
  // contain EAC/account prefixes and user-edited combo chains.
  const priority = ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'mimo-v2.6-flash-free', 'big-pickle'];
  return discoverLanes(catalog).filter(lane => lane.provider === 'our-free-model'
    && !lane.model.includes('/') && !lane.model.startsWith('combo:')
    && (lane.model.endsWith('-free') || lane.model === 'big-pickle'))
    .sort((a, b) => {
      const rank = id => priority.includes(id) ? priority.indexOf(id) : priority.length;
      return rank(a.model) - rank(b.model) || a.model.localeCompare(b.model);
    }).slice(0, 2).map(laneKey);
}
export function discoverLanes(catalog) {
  if (!Array.isArray(catalog?.groups)) throw Object.assign(new Error('DSH 模型目录格式不受支持'), { code: 'UNSUPPORTED_CATALOG' });
  return catalog.groups.flatMap(group => {
    if (!OFM_PROVIDERS.has(group.id) || FORBIDDEN_PROVIDERS.includes(group.id)) return [];
    return (group.models ?? []).filter(m => typeof m.id === 'string').map(m => ({
      provider: group.id, model: m.id,
      label: String(m.name ?? m.label ?? m.id),
      authorization: ['our-free-model', 'kilo'].includes(group.id) ? 'upstream-dependent' : 'own-account-required'
    }));
  });
}
export function makeConfiguration(catalog, requested = [], { qoderCnFreeUntil } = {}) {
  const keys = [...new Set(requested.length ? requested : publicPoolLanes(catalog))];
  if (!keys.length) throw Object.assign(new Error('当前目录没有可确认的免费公开池模型；先在 OFM 中启用公开池并刷新，或添加自己的账号后显式指定 --lanes'), { code: 'PUBLIC_POOL_UNAVAILABLE' });
  const available = discoverLanes(catalog);
  const laneChain = keys.map(key => {
    const match = available.find(l => laneKey(l) === key);
    if (!match) throw Object.assign(new Error(`当前 OFM 目录中没有允许的候选：${key}`), { code: 'INVALID_LANE' });
    if (key === 'qodercn/dfmodel' && !(Date.parse(qoderCnFreeUntil) > Date.now())) {
      throw Object.assign(new Error('Qoder CN 需要核实权益后提供未来的 --cn-until；也可先选择其他渠道'), { code: 'ENTITLEMENT_REQUIRED' });
    }
    return { provider: match.provider, model: match.model };
  });
  return { enabled: true, dsh: {
    allowedProviders: [...new Set(laneChain.map(l => l.provider))], allowedLanes: keys,
    includeDefaultLanes: false, laneChain, reasoningEffort: 'lowest',
    taskReasoningEfforts: { chat: 'lowest', diary: 'high', selfReflection: 'high' },
    ...(qoderCnFreeUntil ? { qoderCnFreeUntil } : {})
  } };
}
export function saveConfiguration(file, config) {
  const contents = JSON.stringify(config, null, 2) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const previous = fs.readFileSync(file, 'utf8');
    if (JSON.stringify(JSON.parse(previous)) === JSON.stringify(config)) return { changed: false, file };
    // Never replace the user's configuration implicitly.
    throw Object.assign(new Error(`配置已存在且不同：${file}；使用新的 --config 路径或先人工合并`), { code: 'CONFIG_EXISTS' });
  }
  // Exclusive creation makes parallel setup runs harmless. No secrets belong here.
  fs.writeFileSync(file, contents, { flag: 'wx', mode: 0o600 });
  return { changed: true, file };
}
export function acquireStateLock(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'writer.lock');
  const id = randomUUID();
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, id }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw Object.assign(new Error(`状态目录已有写入者；确认旧进程退出后再处理 ${file}`), { code: 'STATE_BUSY' });
  }
  return () => { if (JSON.parse(fs.readFileSync(file, 'utf8')).id === id) fs.unlinkSync(file); };
}
