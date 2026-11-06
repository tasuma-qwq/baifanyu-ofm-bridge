import path from 'node:path';
import { defaultConfigFile } from './configuration.js';
import { DshClient } from './dsh-client.js';
import { createPolicyStore, configuredRoute, guard, onboard, observeStream, rotationReadiness, officialFallback, fail, NOTICES, OFM_PROVIDERS, OFM_ROUTE_PROVIDERS, observeAccountPool, noteFailure, isDeepSeek, failureNext, normalizeProvider } from './onboarding.js';

export const name = 'baifanyu-ofm';
export const inject = ['commands', 'sessionController', 'llm'];
export function apply(ctx, options = {}) {
  const profile = ctx.get?.('profileContext')?.name ?? 'unscoped';
  if (!options.policyFile && !/^[A-Za-z0-9_-]+$/.test(profile)) throw fail('PROFILE_NAME_UNSUPPORTED', 'profile 名称不受支持，无法保存接入记录', '显式指定独立 policyFile 路径后重试。');
  const file = options.policyFile ?? path.join(path.dirname(options.configFile ?? defaultConfigFile()), 'profiles', profile, 'onboarding-policy.json');
  const timeoutMs = Number(options.hostTimeoutMs) > 0 ? Number(options.hostTimeoutMs) : 0;
  const ceiling = () => (timeoutMs ? { timeoutMs } : {});
  const store = createPolicyStore(file, { onWriteError: () => ctx.logger?.warn?.('baifanyu-ofm: 接入记录未能写入磁盘；已确认的模型路由与后续调用不受影响') });
  // Observation never restricts or rewrites a user's or bridge's model choice.
  ctx.on('llm/stream', observeStream(store, { onError: () => ctx.logger?.warn?.('baifanyu-ofm: observation unavailable; model dispatch continues') }), { prepend: true });
  ctx.inject(['accountPool'], scoped => scoped.effect(() => observeAccountPool(scoped.accountPool)));
  const pool = () => ctx.get?.('accountPool');
  // OFM is detected by capability, never by the presence of a Loader row. This
  // bundle must not mount a second copy of a third-party plugin: a row named by
  // its bare package also carries that plugin's browser half, and a duplicate
  // half can abort the whole desktop boot instead of failing one plugin only.
  const ofmMounted = () => Boolean(pool())
    || (ctx.llm?.listProviders?.() ?? []).some(provider => OFM_ROUTE_PROVIDERS.includes(provider?.id));
  const ofmMissing = () => fail('OFM_NOT_MOUNTED',
    '宿主当前没有已启用的 OFM：既未提供账号池服务，也未注册 OFM 模型路由',
    '先通过 DSH 插件管理器安装并启用 dsh-our-free-model（https://github.com/Ebony-Vinyl/dsh-our-free-model），再运行 /bfy-ofm onboard。本插件不会替你安装，也不会再挂一份 OFM 副本。');
  async function ensureOfmEnabled({ signal } = {}) {
    if (options.ofmControl) return options.ofmControl({ signal });
    // `authenticate()` and the host round-trips carry no deadline of their own,
    // so a stalled host call would otherwise wait forever — and a tool call that
    // never returns keeps its turn, and that session, open indefinitely.
    return guard(async () => {
      const server = ctx.get?.('webServer');
      if (!server?.port) throw fail('OFM_API_NOT_READY', '宿主本机接口尚未就绪，未确认 OFM 已启用', '宿主启动完成后再运行 /bfy-ofm onboard。');
      const host = server.host === '::1' ? '[::1]' : '127.0.0.1';
      const protocol = String(server.protocol ?? 'http:').replace(/:$/, '');
      const client = new DshClient({ baseUrl: `${protocol}://${host}:${server.port}`, useLocalSession: true });
      await client.authenticate();
      async function request(endpoint, patch) {
        const response = await fetch(`${client.baseUrl}/api/our-free-model/${endpoint}`, { method: patch ? 'POST' : 'GET',
          headers: { cookie: client.cookie, 'content-type': 'application/json' }, redirect: 'error',
          ...(patch ? { body: JSON.stringify(patch) } : {}), signal: AbortSignal.timeout(10000) });
        // OFM registers this prefix itself: a 404 says it is not mounted at all,
        // which no socket deadline can distinguish from a slow but live OFM.
        if (response.status === 404 && !patch) throw ofmMissing();
        if (!response.ok) throw fail('OFM_API_UNAVAILABLE', 'OFM 设置接口不可用', '检查 OFM 版本与装载日志；不导入或覆盖账号凭据。');
        return response.json();
      }
      let summary = await request('summary');
      let enabledByPlugin = false;
      if (summary.settings?.enabled === false) {
        await request('settings', { enabled: true });
        summary = await request('summary');
        enabledByPlugin = summary.settings?.enabled === true;
      }
      if (summary.settings?.enabled !== true) throw fail('OFM_ENABLE_UNCONFIRMED', 'OFM 总开关未确认启用', '在 OFM 设置中启用并刷新，然后重新 onboard。');
      return { version: summary.version, enabled: true, enabledByPlugin, channels: summary.channels?.state };
    }, { signal, ...ceiling(), label: 'OFM 设置接口调用' });
  }
  const currentSelection = (agent, catalog) => ctx.sessionController.agents?.selectionFor?.(agent)?.current
    ?? agent?.model?.current ?? agent?.session?.requestHeader?.()?.config ?? catalog.default ?? {};
  async function configure(agent, provider, { signal } = {}) {
    if (!ofmMounted()) {
      const error = ofmMissing();
      noteFailure(store, error, agent.id);
      throw error;
    }
    let ofm;
    try { ofm = await ensureOfmEnabled({ signal }); }
    catch (error) { noteFailure(store, error, agent.id); throw error; }
    if (provider !== 'free' && ofm.channels && ofm.channels !== 'ready') throw fail('OFM_CHANNELS_NOT_READY', 'OFM 账号渠道包尚未就绪；不能据此判断账号未登录', '等待渠道包就绪并检查 OFM 日志，然后重试。');
    const catalog = await guard(() => ctx.sessionController.modelCatalog(), { signal, ...ceiling(), label: '宿主模型目录读取' });
    const current = currentSelection(agent, catalog);
    const result = await onboard({ catalog, current, provider, store, pool: pool(), sessionId: agent.id, signal, ...ceiling(),
      select: route => guard(() => ctx.sessionController.selectModel({ sessionId: agent.id, ...route }), { signal, ...ceiling(), label: '宿主选模' }) });
    return { ...result, ofmEnabledByThisRun: ofm.enabledByPlugin === true,
      ...(ofm.enabledByPlugin ? { ofmEnabledNotice: '本次接入把 OFM 总开关从关闭改为启用；这是 OFM 的全局设置，其他会话同样会经由 OFM。' } : {}) };
  }
  // An explicitly requested lane change reuses the whole onboard path
  // (catalog choice, guarded selection, receipts, rotation precheck) but never
  // flips OFM's global switch and never picks a lane the user did not name.
  async function switchLane(agent, target, { signal } = {}) {
    if (!ofmMounted()) { const error = ofmMissing(); noteFailure(store, error, agent.id); throw error; }
    const [rawProvider, rawModel = ''] = String(target ?? '').trim().split('/');
    const provider = normalizeProvider((rawProvider ?? '').toLowerCase() || 'free');
    if (provider === 'eac') throw fail('EAC_NOT_A_LANE', 'EAC 是 GitHub 授权解锁的桌面端模型通道，不是本插件的可切换车道', '在 OFM 设置页完成 EAC 授权后，EAC 模型就是目录里的普通条目，直接在 DSH 中选择即可。');
    const catalog = await guard(() => ctx.sessionController.modelCatalog(), { signal, ...ceiling(), label: '宿主模型目录读取' });
    const from = configuredRoute(store.read(), agent.id) ?? null;
    const result = await onboard({ catalog, current: currentSelection(agent, catalog), provider, model: rawModel, store, pool: pool(), sessionId: agent.id, signal, ...ceiling(),
      select: route => guard(() => ctx.sessionController.selectModel({ sessionId: agent.id, ...route }), { signal, ...ceiling(), label: '宿主选模' }) });
    return { ...result, switchedFrom: from };
  }
  async function status(agent, { signal } = {}) {
    const state = store.read();
    const route = configuredRoute(state, agent.id);
    const rotation = route ? await rotationReadiness(pool(), route, { signal, ...ceiling() }) : { available: false, reason: 'ONBOARD_REQUIRED' };
    const receipt = state.receipts?.[agent.id];
    const actual = ctx.sessionController.agents?.selectionFor?.(agent)?.current ?? agent.model?.current;
    const selected = Boolean(actual && route && actual.provider === route.provider && actual.model === route.model);
    const routed = selected && receipt?.outcome === 'completed' && receipt.lane === 'ofm'
      && receipt.provider === route?.provider && receipt.model === route?.model && Date.now() - receipt.at < 600000;
    rotation.verified = Boolean(routed && receipt.accountPoolObserved && receipt.rotationObserved);
    rotation.exercised = rotation.verified;
    if (rotation.verified) rotation.reason = 'OFM_ACCOUNT_ROTATION_OBSERVED';
    const ownFallback = state.fallback?.active && state.fallback.sessionId === agent.id;
    return { status: selected && routed && rotation.available && rotation.verified && !ownFallback ? 'complete' : 'needs-verification-or-action',
      ofmMounted: ofmMounted(),
      modelConfirmed: Boolean(actual && isDeepSeek(actual.provider, actual.model)), ofmRouteSelected: Boolean(selected), ofmRoutingConfirmed: Boolean(routed), ofmAccountPoolConfirmed: Boolean(routed && receipt?.accountPoolObserved), route: actual ?? null, configuredOfmRoute: route,
      rotation, officialFallback: state.fallback?.sessionId === agent.id ? state.fallback : { active: false }, lastHostCall: receipt ?? null, lastFailure: state.failures?.[agent.id] ?? null,
      next: ofmMounted() ? failureNext(state.failures?.[agent.id]) ?? (rotation.available && !rotation.verified ? '账号池已可选择备用，但尚无当前会话的实际轮换证据；OFM 发生切换后再查 status，不人为耗尽配额。'
        : rotation.next ?? '运行 /bfy-ofm onboard。') : ofmMissing().next, notices: NOTICES };
  }
  const describeError = error => ({ status: 'needs-action', code: error.code ?? 'OFM_ONBOARD_FAILED',
    reason: error.userSafe ? error.message : '宿主或 OFM 契约不受支持，未宣称接入完成。',
    next: error.next ?? '检查 OFM 是否已加载、账号有效性及宿主兼容版本，再运行 /bfy-ofm onboard。', notices: NOTICES });
  ctx.commands.register({ name: 'bfy-ofm', description: '保持 DeepSeek 和原思考档位，接入 OFM 并检查路由、账号轮换及官方兜底',
    input: { hint: 'onboard [free|qoder|qodercn|trae] | switch [provider[/model]] | status | doctor | fallback --confirm-official-billing' },
    handler: async ({ agent, rawInput, signal }) => {
      try {
        signal.throwIfAborted();
        const [action = 'onboard', provider = 'free'] = (rawInput.trim() || 'onboard').split(/\s+/);
        if (action === 'status') return { kind: 'success', text: JSON.stringify(await status(agent, { signal }), null, 2) };
        if (action === 'doctor') {
          const catalog = await guard(() => ctx.sessionController.modelCatalog(), { signal, ...ceiling(), label: '宿主模型目录读取' });
          return { kind: 'success', text: JSON.stringify({ ...await status(agent, { signal }), ofmProviders: catalog.groups.filter(g => OFM_PROVIDERS.includes(g.id)).map(g => ({ id: g.id, models: g.models.map(m => ({ id: m.id, name: m.name })) })) }, null, 2) };
        }
        if (action === 'switch') {
          const target = rawInput.trim().split(/\s+/).slice(1).filter(Boolean).join('/');
          return { kind: 'success', text: JSON.stringify(await switchLane(agent, target, { signal }), null, 2) };
        }
        if (action === 'fallback') {
          const route = officialFallback(await ctx.sessionController.modelCatalog(), store, provider === '--confirm-official-billing', agent.id);
          if (typeof agent.model?.select === 'function') await guard(() => agent.model.select(route), { signal, ...ceiling(), label: '宿主选模' });
          else if (typeof ctx.sessionController.agents?.selectForNextRequest === 'function') ctx.sessionController.agents.selectForNextRequest(agent, route);
          else throw fail('OFFICIAL_SELECTION_UNCONFIRMED', '宿主不支持不改全局默认值的会话级兜底', '保持 OFM，检查宿主版本。');
          store.update({ fallback: { active: true, sessionId: agent.id, confirmedAt: Date.now(), route, reason: store.read().failures[agent.id]?.code } });
          await store.flush();
          return { kind: 'success', text: '你已明确启用本会话的官方 DeepSeek 兜底：后续调用可能扣官方余额、套餐额度或 API 费用，不改其他或新会话的默认模型。未重放旧任务；本会话重新 onboard 恢复 OFM 并关闭此兜底。' };
        }
        if (!['onboard', 'setup', 'switch', 'chat', 'diary', 'selfReflection'].includes(action)
          && !/deepseek|\bds\b|大肥鱼|免费|ofm/i.test(rawInput)) throw fail('ACTION_INVALID', '使用 /bfy-ofm onboard 开始一句话接入', '明确官方兜底请单独执行 fallback 命令，不通过自然语言猜测授权。');
        const result = await configure(agent, ['onboard', 'setup'].includes(action) ? provider : 'free', { signal });
        return { kind: 'success', text: JSON.stringify(result, null, 2) };
      } catch (error) { return { kind: 'error', text: JSON.stringify(describeError(error), null, 2) }; }
    } });
  // A model can discover this tool from one ordinary sentence. Official
  // fallback is deliberately NOT exposed as a boolean an agent can self-approve.
  ctx.inject(['tools'], scoped => scoped.tools.register({
    name: 'bfy_ofm_onboard',
    description: '当用户要求大肥鱼/DSH 保持 DS(DeepSeek)、将消耗转到 OFM 免费池或已有账号并检查账号轮换时使用。接入分三条车道，按"先跑通、再求稳"引导：① 免费公开池（默认 free）无需账号，共享且不稳定，上游可能记录 prompt；② EAC 协付池需在 OFM 设置页完成 GitHub 授权（登录并 star 上游仓库）后解锁，仅桌面端宿主可见，Web/CLI 没有；③ 本人账号渠道（qoder/qodercn/trae/zcode/gemini/cline/loomy/raccoon/lobsterai/minimax）最可控，同渠道至少两个可用账号才构成账号轮换。低档更快只是建议，不主动改档；保留思考档位，不开启官方兜底。返回三项判据与未完成原因、下一步。不要把公开池叫作多账号池，不把等价金额当扣款。',
    parameters: { type: 'object', properties: { provider: { type: 'string', enum: ['free', 'qoder', 'qodercn', 'trae', 'trea', 'zcode', 'lobsterai', 'cline', 'loomy', 'raccoon', 'minimax', 'gemini'] } }, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async (args, exec) => {
      if (!exec.agent) return describeError(fail('SESSION_REQUIRED', '需要当前 DSH 会话', '在原会话执行 onboard，不新建会话规避公开池限流。'));
      try { return await configure(exec.agent, args.provider ?? 'free', { signal: exec.signal }); }
      // The host stopped listening: report the cancellation instead of inventing
      // a result, but never let one bad call hang the turn.
      catch (error) { if (exec.signal?.aborted) throw error; return describeError(error); }
    }
  }));
  // Switching is explicit-only: a tool for a lane the user named, never an
  // automatic failure response — automatic failover stays with OFM's account
  // pool, and manual or bridge selection is never overridden.
  ctx.inject(['tools'], scoped => scoped.tools.register({
    name: 'bfy_ofm_switch',
    description: '当用户明确要求大肥鱼/DSH 切换到另一条 OFM 渠道或车道（如"切到 trae"、"换 qodercn"、"先用免费池"）时使用。只执行用户点名的切换：保留原思考档位，不动官方兜底，不在失败后自动重试或自动换渠道——自动故障切换仍由 OFM 账号池处理。EAC 不是可切换车道：GitHub 授权后即目录普通条目，直接选即可。返回切换前后路由、确认结果与下一步；切换失败报告原因，不静默回跳。',
    parameters: { type: 'object', properties: { provider: { type: 'string', enum: ['free', 'qoder', 'qodercn', 'trae', 'trea', 'zcode', 'lobsterai', 'cline', 'loomy', 'raccoon', 'minimax', 'gemini'] }, model: { type: 'string', description: '可选，精确指定渠道内的模型 id（如 deepseek-v4.1-flash）；缺省时自动选该渠道的 DeepSeek' } }, additionalProperties: false, required: ['provider'] },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async (args, exec) => {
      if (!exec.agent) return describeError(fail('SESSION_REQUIRED', '需要当前 DSH 会话', '在用户要求切换的会话内执行。'));
      try { return await switchLane(exec.agent, [args.provider, args.model].filter(Boolean).join('/'), { signal: exec.signal }); }
      catch (error) { if (exec.signal?.aborted) throw error; return describeError(error); }
    }
  }));
}
