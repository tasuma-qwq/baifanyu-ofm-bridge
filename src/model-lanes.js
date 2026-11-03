// Extracted routing policy; see NOTICE.md and docs/architecture.md.

import fs from 'node:fs';
import path from 'node:path';

// Compatibility export: selection is controlled by the caller's explicit configuration.
export const FORBIDDEN_PROVIDERS = Object.freeze([]);

export const DEFAULT_ALLOWED_PROVIDERS = Object.freeze(['qodercn', 'trae']);

export const DEFAULT_LANE_CHAIN = Object.freeze([
  { provider: 'qodercn', model: 'dfmodel' },
  { provider: 'trae', model: 'deepseek-v4.1-flash' }
]);

export const KNOWN_EFFORT_VOCAB = Object.freeze({
  dfmodel: Object.freeze(['none', 'low', 'high', 'max']),
  qfmodel: Object.freeze(['none', 'low', 'medium', 'xhigh']),
  'deepseek-v4.1-flash': Object.freeze(['light', 'high', 'extra_high'])
});

const EFFORT_STRENGTH = Object.freeze({
  off: 0, none: 0, disabled: 0, light: 1, low: 1, medium: 1.5, balanced: 1.5, high: 2, deep: 2, max: 3, xhigh: 3, extra_high: 3
});

export function laneEffortVocab(catalog, provider, model) {
  const group = (Array.isArray(catalog?.groups) ? catalog.groups : []).find((g) => String(g?.id) === String(provider));
  const entry = (Array.isArray(group?.models) ? group.models : []).find((m) => String(m?.id) === String(model));
  if (entry && !entry.reasoning) return [];
  const fromCatalog = (Array.isArray(entry?.reasoning?.efforts) ? entry.reasoning.efforts : [])
    .map((e) => String(e?.id ?? '').trim()).filter(Boolean);
  if (fromCatalog.length) return fromCatalog;
  return KNOWN_EFFORT_VOCAB[String(model)] ? [...KNOWN_EFFORT_VOCAB[String(model)]] : null;
}

export function resolveLaneEffort({ lane = null, catalog = null, globalEffort = '' } = {}) {
  const provider = String(lane?.provider ?? '').trim();
  const model = String(lane?.model ?? '').trim();
  if (!provider || !model) return undefined;
  const vocab = laneEffortVocab(catalog, provider, model);
  if (vocab?.length === 0) return undefined;
  const explicit = typeof lane?.reasoningEffort === 'string' ? lane.reasoningEffort.trim() : '';
  if (!vocab) return explicit || undefined;
  if (explicit && vocab.includes(explicit)) return explicit;
  if (globalEffort === 'lowest') return vocab.reduce((best, id) =>
    (EFFORT_STRENGTH[id] ?? Infinity) < (EFFORT_STRENGTH[best] ?? Infinity) ? id : best);
  const target = EFFORT_STRENGTH[String(globalEffort ?? '').trim().toLowerCase()];
  if (!Number.isFinite(target)) return undefined;
  let best;
  let bestGap = Infinity;
  for (const id of vocab) {
    const rank = EFFORT_STRENGTH[String(id).toLowerCase()];
    if (!Number.isFinite(rank)) continue;
    const gap = Math.abs(rank - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = id;
    }
  }
  return best;
}

export const AUTH_QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
export const TRANSPORT_COOLDOWN_MS = 10 * 60 * 1000;
export const ROUTE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export function laneKey(lane) {
  return `${String(lane?.provider ?? '').trim()}/${String(lane?.model ?? '').trim()}`;
}

function isUsableLane(lane) {
  return Boolean(lane && typeof lane.provider === 'string' && lane.provider && typeof lane.model === 'string' && lane.model);
}

export function resolveLaneChain(dsh = {}, now = Date.now()) {
  const allowed = Array.isArray(dsh?.allowedProviders) && dsh.allowedProviders.length
    ? dsh.allowedProviders.map((p) => String(p).trim())
    : DEFAULT_ALLOWED_PROVIDERS.slice();
  const raw = [
    ...(Array.isArray(dsh?.laneChain) ? dsh.laneChain : []),
    { provider: dsh?.provider, model: dsh?.model },
    ...(dsh.includeDefaultLanes === false ? [] : DEFAULT_LANE_CHAIN)
  ];
  const seen = new Set();
  const chain = [];
  for (const lane of raw) {
    if (!isUsableLane(lane)) continue;
    const provider = String(lane.provider).trim();
    const model = String(lane.model).trim();
    const key = `${provider}/${model}`;
    if (!allowed.includes(provider)) continue;
    if (Array.isArray(dsh.allowedLanes) && !dsh.allowedLanes.includes(key)) continue;
    const freeUntil = Date.parse(String(dsh.qoderCnFreeUntil ?? ''));
    if (key === 'qodercn/dfmodel' && Number.isFinite(freeUntil) && now >= freeUntil) continue;
    const until = Date.parse(String(dsh?.laneHolds?.[key]?.until ?? ''));
    if (Number.isFinite(until) && until > now) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    const effort = typeof lane.reasoningEffort === 'string' && lane.reasoningEffort ? lane.reasoningEffort : undefined;
    chain.push(effort ? { provider, model, reasoningEffort: effort } : { provider, model });
  }
  return chain;
}

export function readLaneCooldowns(file, now = Date.now()) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const lanes = saved && typeof saved.lanes === 'object' ? saved.lanes : {};
    const out = {};
    for (const [key, value] of Object.entries(lanes)) {
      const retryAt = Number(value?.retryAt);
      if (Number.isFinite(retryAt) && retryAt > now) out[key] = { retryAt, kind: String(value.kind ?? ''), reason: String(value.reason ?? '') };
    }
    return out;
  } catch {
    return {};
  }
}

export function createLaneLedger({ file, now = Date.now, policy = () => ({}), log = () => {} } = {}) {
  let writable = true;
  let lanes = {};
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!saved || typeof saved.lanes !== 'object' || saved.lanes === null) throw new Error('invalid lane ledger');
    lanes = saved.lanes;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      writable = false;
      log('车道冷却记录损坏，保留原件；本进程仍按内存态退避');
    }
  }
  function prune() {
    const at = now();
    for (const [key, value] of Object.entries(lanes)) {
      if (!Number.isFinite(Number(value?.retryAt)) || Number(value.retryAt) <= at) delete lanes[key];
    }
  }
  function save() {
    if (!writable) return;
    const temp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify({ version: 1, at: now(), lanes }, null, 2));
      fs.renameSync(temp, file);
    } catch {
      log('车道冷却未能持久保存，本进程仍保留');
    }
  }
  function cooling(key) {
    prune();
    const value = lanes[key];
    if (!value) return null;
    return { key, ...value };
  }
  function isCooling(key) {
    return Boolean(cooling(key));
  }
  function cool(key, { kind = 'unknown', reason = '', ms = TRANSPORT_COOLDOWN_MS } = {}) {
    const wait = Number(ms);
    let retryAt = now() + (Number.isFinite(wait) && wait > 0 ? wait : TRANSPORT_COOLDOWN_MS);
    if (key === 'qodercn/dfmodel' && ['quota','daily-quota'].includes(kind) && policy().dailyQuotaResetUtcOffset === 8) {
      const shifted = new Date(now() + 8 * 3600000);
      retryAt = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()+1)-8*3600000;
    }
    lanes[key] = { kind, reason: String(reason).slice(0, 300), retryAt, failedAt: now() };
    prune();
    save();
  }
  function clear(key) {
    if (key) delete lanes[key];
    else lanes = {};
    save();
  }
  function snapshot() {
    prune();
    return JSON.parse(JSON.stringify(lanes));
  }
  return { cooling, isCooling, cool, clear, snapshot, save };
}

export function lanePresent(catalog, provider, model) {
  if (!catalog) return null;
  const groups = Array.isArray(catalog.groups) ? catalog.groups : [];
  const group = groups.find((g) => String(g?.id) === String(provider));
  if (!group) return false;
  return (Array.isArray(group.models) ? group.models : []).some((m) => String(m?.id) === String(model));
}

export function pickLane({ chain = [], catalog = null, ledger = null, cooling = null, prefer = '' } = {}) {
  const isCooling = ledger && typeof ledger.cooling === 'function'
    ? (key) => ledger.cooling(key)
    : (key) => (cooling && cooling[key] ? { kind: 'cooling', reason: '', retryAt: cooling[key].retryAt } : null);
  const skipped = [];
  for (const lane of chain) {
    const key = laneKey(lane);
    const blocked = isCooling(key);
    if (blocked) {
      skipped.push({ lane: key, why: `冷却中（${blocked.kind || '未知'}），${Math.max(0, Math.ceil((blocked.retryAt - Date.now()) / 60000))} 分钟后重试` });
      continue;
    }
    const present = lanePresent(catalog, lane.provider, lane.model);
    if (present === false) {
      skipped.push({ lane: key, why: 'DSH 模型目录里没有这条车道（渠道包已关闭或账号失效）' });
      continue;
    }
    if (prefer && !key.toLowerCase().includes(String(prefer).toLowerCase())) continue;
    return { lane, skipped };
  }
  if (prefer) return pickLane({ chain, catalog, ledger, cooling });
  return { lane: null, skipped };
}

export function classifyLaneFailure(error) {
  const status = Number(error?.status) || 0;
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? error ?? '');
  if (/daily.*(?:limit|quota|count)|(?:limit|quota).*daily|billing.*count.*exceed|今日.*(?:用尽|上限)|每日.*(?:额度|次数).*(?:用尽|上限)/i.test(message)) return {kind:'daily-quota',ms:AUTH_QUOTA_COOLDOWN_MS,reason:message};
  if (status === 402 || /QUOTA/i.test(code)) return { kind: 'quota', ms: AUTH_QUOTA_COOLDOWN_MS, reason: message || '额度不足（402）' };
  if (status === 401 || ['AUTHENTICATION', 'UNAUTHORIZED'].includes(code)) return { kind: 'auth', ms: AUTH_QUOTA_COOLDOWN_MS, reason: message || '认证失败（401）' };
  if (status === 429 || code === 'RATE_LIMIT') return {kind:'rate-limit',ms:60000,reason:message||'请求限频'};
  if (['TRANSPORT','TIMEOUT','SERVER','EMPTY_RESPONSE','TURN_STALL'].includes(code)) return {kind:'transport',ms:TRANSPORT_COOLDOWN_MS,reason:message||code};
  if (['session/model-unavailable', 'session/model-not-found'].includes(code)) return { kind: 'route', ms: ROUTE_COOLDOWN_MS, reason: message };
  if (/unknown (?:model|provider)|no route|invalid model|model .*disabled|disabled model/i.test(message)) return { kind: 'route', ms: ROUTE_COOLDOWN_MS, reason: message };
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|stream|502|503|504|上游/i.test(message)) return { kind: 'transport', ms: TRANSPORT_COOLDOWN_MS, reason: message };
  if (status >= 500) return { kind: 'transport', ms: TRANSPORT_COOLDOWN_MS, reason: message || `上游 ${status}` };
  return null;
}

export async function runLaneAttempts({run,canRetry=error=>error?.safeToRetry===true,maxAttempts=2}={}) {
  const count=Math.max(1,Math.min(2,Number(maxAttempts)||1));
  for(let attempt=0;attempt<count;attempt++){
    try{return await run(attempt);}
    catch(error){if(attempt+1>=count||!canRetry(error))throw error;}
  }
}
