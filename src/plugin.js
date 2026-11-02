import path from 'node:path';
import { defaultConfigFile } from './configuration.js';
import { DshClient } from './dsh-client.js';
import { createPolicyStore, configuredRoute, onboard, streamGuard, rotationReadiness, officialFallback, fail, NOTICES, OFM_PROVIDERS, observeAccountPool, noteFailure, isDeepSeek, failureNext } from './onboarding.js';

export const name = 'baifanyu-ofm';
export const inject = ['commands', 'sessionController', 'llm'];
export function apply(ctx, options = {}) {
  const profile = ctx.get?.('profileContext')?.name ?? 'unscoped';
  if (!options.policyFile && !/^[A-Za-z0-9_-]+$/.test(profile)) throw fail('PROFILE_NAME_UNSUPPORTED', 'profile 名称不受支持，未启用守卫', '显式指定独立 policyFile 路径后重试。');
  const file = options.policyFile ?? path.join(path.dirname(options.configFile ?? defaultConfigFile()), 'profiles', profile, 'onboarding-policy.json');
  const store = createPolicyStore(file);
  // Middleware covers conversation requests AND auxiliary LLM consumers such
  // as automatic titles. It rejects before adapter streaming, never rewrites
  // a model mid-stream and never replays an uncertain turn.
  ctx.on('llm/stream', streamGuard(store), { prepend: true });
  ctx.inject(['accountPool'], scoped => scoped.effect(() => observeAccountPool(scoped.accountPool)));
  const pool = () => ctx.get?.('accountPool');
  async function ensureOfmEnabled() {
    if (options.ofmControl) return options.ofmControl();
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
      if (!response.ok) throw fail('OFM_API_UNAVAILABLE', 'OFM 设置接口不可用', '检查 OFM 版本与装载日志；不导入或覆盖账号凭据。');
      return response.json();
    }
    let summary = await request('summary');
    if (summary.settings?.enabled === false) {
      await request('settings', { enabled: true });
      summary = await request('summary');
    }
    if (summary.settings?.enabled !== true) throw fail('OFM_ENABLE_UNCONFIRMED', 'OFM 总开关未确认启用', '在 OFM 设置中启用并刷新，然后重新 onboard。');
    return { version: summary.version, enabled: true, channels: summary.channels?.state };
  }
  const currentSelection = (agent, catalog) => ctx.sessionController.agents?.selectionFor?.(agent)?.current
    ?? agent?.model?.current ?? agent?.session?.requestHeader?.()?.config ?? catalog.default ?? {};
  async function configure(agent, provider, automatic = false) {
    let ofm;
    try { ofm = await ensureOfmEnabled(); }
    catch (error) { noteFailure(store, error, agent.id); throw error; }
    if (provider !== 'free' && ofm.channels && ofm.channels !== 'ready') throw fail('OFM_CHANNELS_NOT_READY', 'OFM 账号渠道包尚未就绪；不能据此判断账号未登录', '等待渠道包就绪并检查 OFM 日志，然后重试。');
    const catalog = await ctx.sessionController.modelCatalog();
    const current = currentSelection(agent, catalog);
    return onboard({ catalog, current, provider, store, pool: pool(), sessionId: agent.id, makeDefault: !automatic,
      select: async route => {
        if (automatic) {
          // 0.2.1 uses the Session Controller's existing model-selection owner.
          // Newer kernels may expose that operation on the Agent itself. Avoid
          // resolveAgent during the awaited agent/created event (self-deadlock).
          if (typeof agent.model?.select === 'function') { await agent.model.select(route); return { selected: route }; }
          const controller = ctx.sessionController.agents;
          if (typeof controller?.selectForNextRequest !== 'function') throw fail('HOST_AUTO_SELECTION_UNSUPPORTED', '宿主不支持安全的创建期选模', '使用 /bfy-ofm onboard 显式完成选模。');
          controller.selectForNextRequest(agent, route);
          return { selected: route };
        }
        return ctx.sessionController.selectModel({ sessionId: agent.id, ...route });
      } });
  }
  ctx.on('agent/created', async ({ agent }) => {
    try {
      const state = store.read();
      if (state.fallback?.active && state.fallback.sessionId === agent.id) return;
      await configure(agent, state.sessionRoutes?.[agent.id]?.provider ?? state.provider ?? 'free', true);
    } catch (error) {
      // Do not make directory/network failure look like a successful switch.
      // The stream guard remains closed; human slash commands still work.
      ctx.logger?.warn?.(`baifanyu-ofm: ${error.code ?? 'ONBOARD_REQUIRED'}; run /bfy-ofm onboard`);
    }
  });
  async function status(agent) {
    const state = store.read();
    const route = configuredRoute(state, agent.id);
    const rotation = route ? await rotationReadiness(pool(), route) : { available: false, reason: 'ONBOARD_REQUIRED' };
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
      modelConfirmed: Boolean(actual && isDeepSeek(actual.provider, actual.model)), ofmRouteSelected: Boolean(selected), ofmRoutingConfirmed: Boolean(routed), ofmAccountPoolConfirmed: Boolean(routed && receipt?.accountPoolObserved), route: actual ?? null, configuredOfmRoute: route,
      rotation, officialFallback: state.fallback?.sessionId === agent.id ? state.fallback : { active: false }, lastHostCall: receipt ?? null, lastFailure: state.failures?.[agent.id] ?? null,
      next: failureNext(state.failures?.[agent.id]) ?? (rotation.available && !rotation.verified ? '账号池已可选择备用，但尚无当前会话的实际轮换证据；OFM 发生切换后再查 status，不人为耗尽配额。'
        : rotation.next ?? '运行 /bfy-ofm onboard。'), notices: NOTICES };
  }
  const describeError = error => ({ status: 'needs-action', code: error.code ?? 'OFM_ONBOARD_FAILED',
    reason: error.userSafe ? error.message : '宿主或 OFM 契约不受支持，未宣称接入完成。',
    next: error.next ?? '检查 OFM 是否已加载、账号有效性及宿主兼容版本，再运行 /bfy-ofm onboard。', notices: NOTICES });
  ctx.commands.register({ name: 'bfy-ofm', description: '保持 DeepSeek 和原思考档位，接入 OFM 并检查路由、账号轮换及官方兜底',
    input: { hint: 'onboard [free|qoder|qodercn|trae] | status | fallback --confirm-official-billing' },
    handler: async ({ agent, rawInput, signal }) => {
      try {
        signal.throwIfAborted();
        const [action = 'onboard', provider = 'free'] = (rawInput.trim() || 'onboard').split(/\s+/);
        if (action === 'status') return { kind: 'success', text: JSON.stringify(await status(agent), null, 2) };
        if (action === 'doctor') {
          const catalog = await ctx.sessionController.modelCatalog();
          return { kind: 'success', text: JSON.stringify({ ...await status(agent), ofmProviders: catalog.groups.filter(g => OFM_PROVIDERS.includes(g.id)).map(g => ({ id: g.id, models: g.models.map(m => ({ id: m.id, name: m.name })) })) }, null, 2) };
        }
        if (action === 'fallback') {
          const route = officialFallback(await ctx.sessionController.modelCatalog(), store, provider === '--confirm-official-billing', agent.id);
          if (typeof agent.model?.select === 'function') await agent.model.select(route);
          else if (typeof ctx.sessionController.agents?.selectForNextRequest === 'function') ctx.sessionController.agents.selectForNextRequest(agent, route);
          else throw fail('OFFICIAL_SELECTION_UNCONFIRMED', '宿主不支持不改全局默认值的会话级兜底', '保持 OFM，检查宿主版本。');
          store.update({ fallback: { active: true, sessionId: agent.id, confirmedAt: Date.now(), route, reason: store.read().failures[agent.id].code } });
          return { kind: 'success', text: '你已明确启用本会话的官方 DeepSeek 兜底：后续调用可能扣官方余额、套餐额度或 API 费用，不改其他或新会话的默认模型。未重放旧任务；本会话重新 onboard 恢复 OFM 并关闭此兜底。' };
        }
        if (!['onboard', 'setup', 'chat', 'diary', 'selfReflection'].includes(action)
          && !/deepseek|\bds\b|大肥鱼|免费|ofm/i.test(rawInput)) throw fail('ACTION_INVALID', '使用 /bfy-ofm onboard 开始一句话接入', '明确官方兜底请单独执行 fallback 命令，不通过自然语言猜测授权。');
        const result = await configure(agent, ['onboard', 'setup'].includes(action) ? provider : 'free');
        return { kind: 'success', text: JSON.stringify(result, null, 2) };
      } catch (error) { return { kind: 'error', text: JSON.stringify(describeError(error), null, 2) }; }
    } });
  // A model can discover this tool from one ordinary sentence. Official
  // fallback is deliberately NOT exposed as a boolean an agent can self-approve.
  ctx.inject(['tools'], scoped => scoped.tools.register({
    name: 'bfy_ofm_onboard',
    description: '当用户要求大肥鱼/DSH 保持 DS(DeepSeek)、将消耗转到 OFM 免费池或已有账号并检查账号轮换时使用。调用前先说明免费池无门槛但不稳定；推荐本人已有账号，低档更快只是建议，不主动改档。默认 free，保留思考档位，不开启官方兜底。返回三项判据与未完成原因、下一步。不要把公开池叫作多账号池，不把等价金额当扣款。',
    parameters: { type: 'object', properties: { provider: { type: 'string', enum: ['free', 'qoder', 'qodercn', 'trae', 'trea', 'zcode', 'lobsterai', 'cline', 'loomy', 'raccoon', 'minimax', 'gemini'] } }, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async (args, exec) => {
      if (!exec.agent) return describeError(fail('SESSION_REQUIRED', '需要当前 DSH 会话', '在原会话执行 onboard，不新建会话规避公开池限流。'));
      try { return await configure(exec.agent, args.provider ?? 'free'); } catch (error) { return describeError(error); }
    }
  }));
}
