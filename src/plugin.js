// Native DSH bundle. A slash command acts only on the invoking session.
import fs from 'node:fs';
import path from 'node:path';
import { discoverLanes, makeConfiguration, saveConfiguration, acquireStateLock, defaultConfigFile, PUBLIC_POOL_NOTICE, ACCOUNT_SETUP_GUIDE } from './configuration.js';
import { selectSessionRoute } from './session-route.js';
import { createLaneLedger, classifyLaneFailure, laneKey } from './model-lanes.js';

export const name = 'baifanyu-ofm';
export const inject = ['commands', 'sessionController'];
export function apply(ctx, options = {}) {
  const file = options.configFile ?? defaultConfigFile();
  ctx.commands.register({
    name: 'bfy-ofm', description: '检查 OFM 目录、配置允许渠道或切换当前会话的任务档位',
    input: { hint: 'doctor | setup（默认公开池）| setup provider/model[,provider/model] | chat | diary | selfReflection' },
    handler: async ({ agent, rawInput, signal }) => {
      try {
        const [action = 'doctor', lanes, cnUntil] = (rawInput.trim() || 'doctor').split(/\s+/);
        signal.throwIfAborted();
        const catalog = await ctx.sessionController.modelCatalog();
        if (action === 'doctor') return { kind: 'success', text: JSON.stringify({
          configFile: file, configured: fs.existsSync(file), candidates: discoverLanes(catalog),
          note: '目录存在不证明账号可用或免费；setup 默认公开池且不发起推理，切换后发送普通消息验证。', limitations: PUBLIC_POOL_NOTICE, accountSetup: ACCOUNT_SETUP_GUIDE
        }, null, 2) };
        if (action === 'setup') {
          const config = makeConfiguration(catalog, (lanes ?? '').split(',').filter(Boolean), { qoderCnFreeUntil: cnUntil });
          return { kind: 'success', text: JSON.stringify({ ...saveConfiguration(file, config), lanes: config.dsh.allowedLanes,
            limitations: PUBLIC_POOL_NOTICE, accountSetup: ACCOUNT_SETUP_GUIDE }) };
        }
        if (!['chat', 'diary', 'selfReflection'].includes(action)) return { kind: 'error', text: '使用 /bfy-ofm doctor 查看用法和当前候选。' };
        const config = JSON.parse(fs.readFileSync(file, 'utf8'));
        const stateDir = path.join(path.dirname(file), 'state');
        const unlock = acquireStateLock(stateDir);
        try {
          const ledger = createLaneLedger({ file: path.join(stateDir, 'model-lanes.json'), policy: () => config.dsh });
          const api = { callUnary: async (_method, request) => ({ result: { ok: true, value: await ctx.sessionController.selectModel(request) } }) };
          let route;
          for (let attempt = 0; attempt < 2; attempt++) {
            try { route = await selectSessionRoute({ api, sessionId: agent.id, config, catalog, ledger, task: action }); break; }
            catch (error) {
              const failure = classifyLaneFailure(error);
              if (!failure || !error.route || attempt === 1) throw error;
              ledger.cool(laneKey(error.route), { ...failure, reason: failure.kind });
            }
          }
          return { kind: 'success', text: `当前会话已选择 ${route.provider}/${route.model} · ${route.reasoningEffort ?? '默认档位'}。尚未调用模型；发送普通消息开始验证。DSH 同时保存该选择为新会话默认值。` };
        } finally { unlock(); }
      } catch (error) {
        // Do not expose raw upstream errors or any credential-bearing strings in chat.
        return { kind: 'error', text: `${error.code ?? 'OFM_SETUP_FAILED'}：请运行 /bfy-ofm doctor；核对配置路径、渠道授权与模型目录。` };
      }
    }
  });
}
