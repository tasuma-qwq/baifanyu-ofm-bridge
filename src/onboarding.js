// Default DeepSeek onboarding and passive receipts. OFM owns account rotation,
// recovery and cooldowns; this layer does not replay or schedule accounts.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const requestTrace = new AsyncLocalStorage();
// Host services are awaited without their own deadlines, so every call the
// plugin makes on behalf of a turn gets a local ceiling: a stalled host call
// must end as an error the user can read, never as a turn that never returns.
export const DEFAULT_HOST_TIMEOUT_MS = 15000;
const POOL_OBSERVER = Symbol.for('baifanyu-ofm.account-pool-observer');
export function guard(operation, { signal, timeoutMs = DEFAULT_HOST_TIMEOUT_MS, label = '宿主调用' } = {}) {
  const started = Promise.resolve().then(() => operation());
  // The host keeps working on its own promise after we stop waiting for it.
  started.catch(() => {});
  let onAbort;
  let timer;
  const stopped = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(fail('HOST_CALL_STALLED',
      `宿主在 ${Math.round(timeoutMs / 1000)} 秒内没有完成${label}，本插件已停止等待`,
      '未确认的调用不能当作已完成；先检查 DSH 与 OFM 是否仍在处理，再用 status 核对实际状态，不重复提交。')), timeoutMs);
    if (signal?.aborted) reject(cancelled(signal, label));
    else if (signal) {
      onAbort = () => reject(cancelled(signal, label));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  return Promise.race([started, stopped]).finally(() => {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  });
}
const cancelled = (signal, label) => fail('HOST_CALL_CANCELLED',
  signal?.reason?.name === 'TimeoutError' ? `宿主侧超时，${label}未完成，本插件停止等待` : `${label}已被取消，本插件停止等待`,
  '被取消的调用结果未知；用 status 查看已确认到的状态，不自动重发。');
// Observe OFM's existing selector, without changing order, exclusions,
// credentials, return values or retries. Identities live only in this request's
// in-memory Set; receipts contain counts and a rotation boolean, never ids.
export function observeAccountPool(pool) {
  if (typeof pool?.getAvailableAccount !== 'function') return () => {};
  const shared = pool.getAvailableAccount[POOL_OBSERVER];
  // A second fiber must not wrap our own wrapper: chained wrappers grow on every
  // re-mount and only the innermost one is restored on dispose.
  if (shared) {
    shared.holders += 1;
    return () => { shared.holders -= 1; if (shared.holders <= 0) shared.restore(); };
  }
  const original = pool.getAvailableAccount;
  const wrapped = async function (...args) {
    const value = await original.apply(this, args);
    const trace = requestTrace.getStore();
    if (trace && args[0] === trace.provider && args[1] === trace.model && value?.entry?.id) trace.accounts.add(String(value.entry.id));
    return value;
  };
  const state = { holders: 1, restore: () => { if (pool.getAvailableAccount === wrapped) pool.getAvailableAccount = original; } };
  Object.defineProperty(wrapped, POOL_OBSERVER, { value: state, enumerable: false });
  pool.getAvailableAccount = wrapped;
  return () => { state.holders -= 1; if (state.holders <= 0) state.restore(); };
}


export const ACCOUNT_PROVIDERS = Object.freeze(['qoder', 'qodercn', 'trae', 'lobsterai', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini']);
// The two adapter routes OFM itself registers; presence of either means a live
// OFM instance owns the model pool, so no second copy may be mounted.
export const OFM_ROUTE_PROVIDERS = Object.freeze(['our-free-model', 'our-free-model-region']);
export const OFM_PROVIDERS = Object.freeze([...OFM_ROUTE_PROVIDERS, ...ACCOUNT_PROVIDERS]);
export const OFFICIAL_PROVIDERS = Object.freeze(['deepseek-official', 'deepseek-account']);
export const NOTICES = Object.freeze([
  '免费公开池无账号门槛，但可能限流、拥堵或受地区网络影响。公开池没有可轮换的账号。',
  '可显式指定本人已有的 qoder、qodercn、trae（也识别 trea 拼写）账号渠道；在 OFM 页面登录、按服务规则领取积分并核对权益，不保证所有模型免费。',
  '低档位思考通常更快；本流程保留当前档位，不主动降低或提高。'
]);
export const fail = (code, message, next) => Object.assign(new Error(message), { code, next, userSafe: true });
export function noteFailure(store, error, sessionId) {
  const failure = { code: String(error.code ?? 'OFM_REQUEST_FAILED'), status: Number(error.status) || 0, at: Date.now() };
  const failures = { ...store.read().failures };
  if (sessionId) failures[sessionId] = failure;
  store.update({ failure, failures: Object.fromEntries(Object.entries(failures).slice(-20)) });
}
export function normalizeProvider(value) { return value === 'trea' ? 'trae' : value; }
export function failureNext(failure) {
  if (!failure) return null;
  const code = failure.code ?? '';
  if (/DISCLAIMER|TERMS|ACKNOWLEDG/i.test(code)) return '在 OFM 设置中本人阅读并确认首次使用说明，再重试；插件不会替你接受协议。';
  if (/QUOTA|BILLING/i.test(code) || failure.status === 402) return '在 OFM 查看该账号额度与重置时间，或添加同渠道可用备用账号；不反复新建会话绕过限制。';
  if (/AUTH|CREDENTIAL/i.test(code) || failure.status === 401) return '在 OFM 中重新登录或刷新本人账号授权，再检查其有效性。';
  if (/RATE_LIMIT/i.test(code) || failure.status === 429) return '按 OFM 提示等待限流恢复；不要全局拉黑渠道，也不要创建新会话绕过 session 限速。';
  if (/TIMEOUT|TRANSPORT|SERVER|OVERLOADED/i.test(code) || failure.status >= 500) return '检查 OFM 运行日志和网络出口，等待上游恢复；结果未知的任务不自动重发。';
  return '在 OFM 运行日志中核对这次失败原因，完成其给出的操作后再检查 status；未验证前不报告完成。';
}
export function isDeepSeek(provider, model, entry) {
  if (typeof model !== 'string' || model.startsWith('combo:')) return false;
  if (/(^|\/)deepseek(?:[-_:/]|$)/i.test(model)) return true;
  return ['qoder', 'qodercn'].includes(provider) && model === 'dfmodel'
    && (!entry?.name || /deepseek/i.test(entry.name));
}
export function routes(catalog, provider = 'free') {
  const selected = normalizeProvider(provider);
  if (!Array.isArray(catalog?.groups)) throw fail('CATALOG_REQUIRED', '未取得宿主当前模型目录', '重新读取目录后运行 onboard。');
  if (selected !== 'free' && !ACCOUNT_PROVIDERS.includes(selected)) throw fail('PROVIDER_INVALID', '不是受支持的 OFM 账号渠道', '使用 free、qoder、qodercn 或 trae 等 OFM 账号渠道。');
  return catalog.groups.flatMap(group => {
    if (selected === 'free' ? group.id !== 'our-free-model' : group.id !== selected) return [];
    return (group.models ?? []).filter(entry => isDeepSeek(group.id, entry.id, entry)
      && (selected !== 'free' || !entry.id.includes('/') && /-free$/.test(entry.id)))
      .map(entry => ({ provider: group.id, model: entry.id, entry }));
  }).sort((a, b) => a.model.localeCompare(b.model));
}
export function preserveEffort(route, current = {}) {
  const effort = current.reasoningEffort;
  if (!effort) return { provider: route.provider, model: route.model };
  const menu = route.entry?.reasoning?.efforts?.map(item => item.id) ?? [];
  if (!menu.includes(effort)) throw fail('EFFORT_NOT_PRESERVED', `候选 DeepSeek 模型不支持原档位 ${effort}，未切换`, '选用支持原档位的 DeepSeek 渠道，或由你明确指定新的思考档位。');
  return { provider: route.provider, model: route.model, reasoningEffort: effort };
}
export function chooseDeepSeek(catalog, provider, current) {
  const candidates = routes(catalog, provider);
  if (!candidates.length) throw fail('DEEPSEEK_UNAVAILABLE', '当前目录没有所选来源的 DeepSeek 模型；不会改用其他模型或官方余额', provider === 'free'
    ? '在 OFM 中启用并刷新 DeepSeek 公开池，或显式指定已有账号渠道；不要为绕过限流反复创建新会话。'
    : '在 OFM 中登录该渠道、启用 DeepSeek 并刷新目录，再运行 onboard。');
  let effortError;
  for (const route of candidates) {
    try { return preserveEffort(route, current); } catch (error) { effortError = error; }
  }
  throw effortError;
}
export function createPolicyStore(file, { onWriteError = () => {} } = {}) {
  // Observation runs inside every model call, so persistence must never sit on
  // the event loop: the policy is cached in memory and written asynchronously,
  // one in-flight write plus a coalesced follow-up. Explicit flush() is offered
  // to the command paths that need the file to be on disk before returning.
  let cache;
  let inFlight;
  let overdue = false;
  let writeError;
  function load() {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value.schema !== 3) throw new Error('schema');
      cache = value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail('POLICY_UNREADABLE', '接入记录不可读；原文件保留，模型调用不受限制', '检查并恢复策略文件后重新 onboard。');
      cache = { schema: 3, provider: 'free', route: null, fallback: { active: false }, receipt: null, failure: null };
    }
    return cache;
  }
  function persist() {
    if (inFlight) {
      overdue = true;
      return;
    }
    const payload = JSON.stringify(cache ?? {}, null, 2) + '\n';
    const temp = `${file}.${randomUUID()}.tmp`;
    inFlight = (async () => {
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(temp, payload, { mode: 0o600, flag: 'wx' });
        await fsp.rename(temp, file);
        writeError = void 0;
      } catch (error) {
        // An EPERM'd rename on Windows used to leave one *.tmp behind per call.
        writeError = error;
        await fsp.rm(temp, { force: true }).catch(() => {});
      }
    })().then(() => {
      inFlight = void 0;
      if (overdue) {
        overdue = false;
        persist();
      } else if (writeError) try { onWriteError(writeError); } catch {}
    });
  }
  function read() { return cache ?? load(); }
  function update(patch) {
    const next = { ...read(), ...patch, schema: 3 };
    cache = next;
    persist();
    return next;
  }
  async function flush() {
    while (inFlight) await inFlight;
    if (writeError) throw Object.assign(new Error('onboarding policy could not be persisted'), { code: 'POLICY_UNWRITABLE', cause: writeError });
  }
  return { read, update, flush };
}

export function configuredRoute(policy, sessionId) {
  return policy.sessionRoutes?.[sessionId]?.route ?? policy.route;
}
export async function rotationReadiness(pool, route, { signal, timeoutMs = DEFAULT_HOST_TIMEOUT_MS } = {}) {
  if (route.provider === 'our-free-model' || route.provider === 'our-free-model-region') {
    return { available: false, exercised: false, reason: 'PUBLIC_POOL_HAS_NO_ACCOUNTS', next: '需要账号轮换时，显式指定已添加至少两个可用账号的同一 OFM 渠道。' };
  }
  if (!pool || typeof pool.getAvailableAccount !== 'function') return { available: false, exercised: false, reason: 'OFM_ACCOUNT_POOL_UNAVAILABLE', next: '在 OFM 中检查账号渠道包是否已就绪。' };
  // Use OFM's own selection predicate, including enabled credentials/model
  // rate limits. Never copy returned credentials or account identities to state.
  const first = await guard(() => pool.getAvailableAccount(route.provider, route.model, new Set()), { signal, timeoutMs, label: 'OFM 账号池预检' });
  if (!first?.entry?.id) return { available: false, exercised: false, reason: 'NO_USABLE_ACCOUNT', next: '在 OFM 中登录并启用本人账号，核对登录有效性及额度。' };
  const second = await guard(() => pool.getAvailableAccount(route.provider, route.model, new Set([first.entry.id])), { signal, timeoutMs, label: 'OFM 账号池预检' });
  return second?.entry?.id && second.entry.id !== first.entry.id
    ? { available: true, exercised: false, reason: 'OFM_CAN_SELECT_DISTINCT_BACKUP', next: '账号池可选择不同备用账号；实际额度故障切换仍由 OFM 处理，未人为耗尽额度。' }
    : { available: false, exercised: false, reason: 'SECOND_USABLE_ACCOUNT_REQUIRED', next: '在同一 OFM 渠道添加并启用第二个可用账号；不同渠道各一个账号不等于账号池轮换。' };
}
export async function onboard({ catalog, current, provider = 'free', select, store, pool, sessionId, makeDefault = true, signal, timeoutMs = DEFAULT_HOST_TIMEOUT_MS }) {
  const source = normalizeProvider(provider);
  try {
    const route = chooseDeepSeek(catalog, source, current);
    const selected = await select(route);
    const actual = selected?.selected ?? selected;
    if (actual?.provider !== route.provider || actual?.model !== route.model
      || (route.reasoningEffort && actual.reasoningEffort !== route.reasoningEffort)) {
      throw fail('SELECTION_UNCONFIRMED', '宿主没有确认同一 DeepSeek 路由和原档位', '保留原设置，核对宿主版本和模型目录。');
    }
    const previous = store.read();
    const fallback = !sessionId || previous.fallback?.sessionId === sessionId ? { active: false } : previous.fallback;
    const state = store.update({
      ...(!previous.route || makeDefault ? { provider: source, route } : {}), fallback,
      ...(sessionId ? { sessionRoutes: { ...previous.sessionRoutes, [sessionId]: { provider: source, route } } } : {})
    });
    // The host selection is already installed at this point, so an unwritable
    // policy file is reported instead of turning a confirmed switch into a failure.
    let persistence;
    try { await store.flush?.(); }
    catch (error) { persistence = { ok: false, code: error.code ?? 'POLICY_UNWRITABLE' }; }
    const rotation = await rotationReadiness(pool, route, { signal, timeoutMs });
    const receipt = sessionId ? state.receipts?.[sessionId] : state.receipt;
    const routed = receipt?.provider === route.provider && receipt.model === route.model && receipt.outcome === 'completed' && Date.now() - receipt.at < 600000;
    const rotationObserved = routed && receipt.accountPoolObserved && receipt.rotationObserved;
    rotation.verified = Boolean(rotationObserved);
    rotation.exercised = Boolean(rotationObserved);
    if (rotationObserved) rotation.reason = 'OFM_ACCOUNT_ROTATION_OBSERVED';
    const lastFailure = sessionId ? state.failures?.[sessionId] : state.failure;
    return { status: routed && rotation.available && rotationObserved ? 'complete' : 'needs-verification-or-action', notices: NOTICES, lastFailure: lastFailure ?? null,
      ...(persistence ? { policyPersistence: persistence } : {}),
      route, modelConfirmed: true, ofmRoutingConfirmed: routed, ofmAccountPoolConfirmed: Boolean(routed && receipt?.accountPoolObserved), automaticOfficialFallback: false, modelRestrictions: false, rotation,
      usageScope: '宿主路由与 OFM 账号选择；上游物理请求与实际扣费以 OFM/账号账本为准。',
      next: failureNext(lastFailure) ?? (!routed ? '在当前会话发送一次已授权的普通消息，再运行 /bfy-ofm status 核对实际 OFM DeepSeek 调用。'
        : rotation.available && !rotationObserved ? '账号池能选择备用，但尚无当前会话的真实轮换证据；OFM 发生切换后再查 status，不人为耗尽配额。' : rotation.next) };
  } catch (error) {
    if (['DEEPSEEK_UNAVAILABLE', 'EFFORT_NOT_PRESERVED', 'SELECTION_UNCONFIRMED'].includes(error.code)) {
      noteFailure(store, error, sessionId);
    }
    throw error;
  }
}
export function observeStream(store, { onError = () => {} } = {}) {
  return (request, next) => {
    // A request the host did not shape as expected must pass through untouched
    // instead of throwing inside the observation generator.
    if (!request || typeof request !== 'object') return next(request);
    return (async function* () {
      const lane = OFM_PROVIDERS.includes(request.provider) ? 'ofm' : OFFICIAL_PROVIDERS.includes(request.provider) ? 'official' : 'other';
      const trace = { provider: request.provider, model: request.model, accounts: new Set() };
      function record(outcome, failure) {
        try {
          const row = { provider: request.provider, model: request.model, lane, at: Date.now(), outcome, physicalRequests: 'unknown',
            accountPoolObserved: trace.accounts.size > 0, distinctAccounts: trace.accounts.size, rotationObserved: trace.accounts.size > 1 };
          const state = store.read();
          const receipts = { ...state.receipts };
          const failures = { ...state.failures };
          const sessionId = request.sessionId ?? request.conversationId;
          if (typeof sessionId === 'string') receipts[sessionId] = row;
          if (failure && lane === 'ofm' && sessionId) failures[sessionId] = { code: String(failure.code ?? 'OFM_REQUEST_FAILED'), status: Number(failure.status) || 0, at: row.at };
          else if (outcome === 'completed' && lane === 'ofm' && sessionId) delete failures[sessionId];
          store.update({ receipt: row, receipts: Object.fromEntries(Object.entries(receipts).slice(-20)),
            failures: Object.fromEntries(Object.entries(failures).slice(-20)),
            ...(failure && lane === 'ofm' ? { failure: { code: String(failure.code ?? 'OFM_REQUEST_FAILED'), status: Number(failure.status) || 0, at: row.at } } : {}) });
        } catch { try { onError(); } catch {} }
      }
      let finished = false;
      record('pending');
      try {
        const stream = await requestTrace.run(trace, next);
        const iterator = stream[Symbol.asyncIterator]();
        const scopedStream = { [Symbol.asyncIterator]: () => ({
          next: (...args) => requestTrace.run(trace, () => iterator.next(...args)),
          throw: error => iterator.throw ? requestTrace.run(trace, () => iterator.throw(error)) : Promise.reject(error),
          return: (...args) => requestTrace.run(trace, () => iterator.return?.(...args) ?? Promise.resolve({ done: true }))
        }) };
        for await (const chunk of scopedStream) {
          if (chunk.type === 'finish') {
            finished = true;
            const failed = ['error', 'aborted'].includes(chunk.reason?.kind);
            record(failed ? 'failed' : 'completed', failed ? chunk.reason.failure : undefined);
          }
          yield chunk;
        }
      } catch (error) { record('failed', error); finished = true; throw error; }
      finally { if (!finished) record('unknown'); }
    })();
  };
}
export function officialFallback(catalog, store, confirmed, sessionId) {
  if (confirmed !== true) throw fail('OFFICIAL_CONFIRMATION_REQUIRED', '官方兜底会消耗官方余额、套餐额度或 API 费用；仅在 OFM 无可用 DeepSeek、额度/认证/连接故障时由你主动切回', '确认后手动执行 /bfy-ofm fallback --confirm-official-billing；重新 onboard 会关闭官方兜底。');
  const saved = store.read();
  const state = { ...saved, failure: sessionId ? saved.failures?.[sessionId] : saved.failure, receipt: sessionId ? saved.receipts?.[sessionId] : saved.receipt };
  const eligible = state.failure && (/DEEPSEEK_UNAVAILABLE|QUOTA|CREDENTIAL|AUTH|TIMEOUT|TRANSPORT|UNAVAILABLE|OVERLOADED|RATE_LIMIT|SERVER/i.test(state.failure.code)
    || [401, 402, 429].includes(state.failure.status) || state.failure.status >= 500 && state.failure.status <= 599);
  const recovered = state.receipt?.lane === 'ofm' && state.receipt.outcome === 'completed' && state.receipt.at >= state.failure?.at;
  if (!eligible || recovered || Date.now() - state.failure.at > 600000) throw fail('FALLBACK_TRIGGER_MISSING', '没有近期未恢复的 OFM 不可用、额度、认证或连接故障证据；未切换官方', '先检查 OFM 状态；账号不足、业务拒绝或档位不兼容不由官方余额兜底。');
  for (const group of catalog.groups ?? []) {
    if (!OFFICIAL_PROVIDERS.includes(group.id)) continue;
    for (const entry of group.models ?? []) {
      if (isDeepSeek(group.id, entry.id, entry)) return preserveEffort({ provider: group.id, model: entry.id, entry }, configuredRoute(state, sessionId) ?? catalog.default);
    }
  }
  throw fail('OFFICIAL_DEEPSEEK_UNAVAILABLE', '宿主没有可确认的官方 DeepSeek 候选', '核对官方账号或 API 配置；不会选择其他模型。');
}
