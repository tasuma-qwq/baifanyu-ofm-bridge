# 接到自己的 DSH 宿主

前提：你已经有 DSH 会话、已加载 OFM 并授权自己的渠道。此文不提供登录态提取、凭据导入或账号池。

## 1. 选择模型后才提交

```js
import fs from 'node:fs';
import { createLaneLedger, selectSessionRoute } from '../src/index.js';

const config = JSON.parse(fs.readFileSync('config.local.json', 'utf8'));
const ledger = createLaneLedger({
  file: './state/model-lanes.json',
  policy: () => config.dsh,
  log: message => console.error(message)
});

// api 由你已有的 DSH 客户端提供。不得从本示例猜测认证方式。
// sessionId 是你创建或恢复的真实会话。
// catalog 是从该宿主当前 session.modelCatalog 能力取得并解包后的目录。
const route = await selectSessionRoute({
  api, sessionId, config, catalog, ledger, task: 'chat'
});
// 到这里才允许调用已有的 prompt 提交逻辑。
// 先建立事件订阅，再提交；不要忽略任何选模异常。
```

`api.callUnary('session/selectModel', { sessionId, provider, model, reasoningEffort })` 必须返回显式成功的 `{ result: { ok: true, value: ... } }`，或已解包的 `{ ok: true, value: ... }`。如果你的客户端返回值不同，先在自己的适配器转换并检查失败，不要直接假定成功。

每次新任务重新读取目录、策略与冷却状态，避免把曾经选中的备用渠道永久缓存。模型 ID、能力方法与事件格式应以你安装的 DSH/OFM 版本为准。

## 2. 接收事件并处理卡死

```js
import { createTurnStallGuard } from '../src/index.js';

const guard = createTurnStallGuard({
  onStall: async (sessionId, info) => {
    // 由宿主校验 info.turnId，撤销旧行动权限，停止旧回合并清理 inbox。
    // 核对取消回执和是否调用过工具；不要在这里直接重发聊天内容。
    await handleStallInYourHost(sessionId, info);
  }
});

// 提交成功后：guard.expect(sessionId)
// 事件流：guard.observe(sessionId, event)
// 回合结束或取消后：guard.forget(sessionId)
// 进程退出前：guard.clearAll()
```

把 `turn/start`、`turn/end`、有效 assistant 文本、`tool/call`、`tool/result` 等原始事件传入。丢失事件或只传文本会破坏阶段判断。工具与用户确认的期限由宿主独立处理。

某些 DSH 版本的 `session/cancel` 保留队列。因此“取消接口返回成功”不足以确认旧任务完全停止；需要宿主验证不再有旧的活动回合、排队输入或仍有效的行动权限。不要把归档会话当作取消。

## 3. 故障后是否允许重新提交

```js
import { classifyLaneFailure, mayReplayTurn, runLaneAttempts, laneKey } from '../src/index.js';

await runLaneAttempts({
  run: async attempt => {
    // 每一次都重新选路；第一次的失败需要在宿主中冷却对应 route。
    return await runOneTurnInYourHost(attempt);
  },
  canRetry: error => mayReplayTurn({
    error,
    cancelConfirmed: error.cancelConfirmed,
    hadToolCall: error.hadToolCall,
    externalActionState: error.externalActionState
  })
});

// 在 runOneTurnInYourHost 的错误处理里：
// const failure = classifyLaneFailure(error);
// if (failure) ledger.cool(laneKey(route), failure);
// 按真实状态填入安全标记后再抛出；未知值保持未知。
```

这些 `runOneTurnInYourHost` / `handleStallInYourHost` 是你自己的宿主逻辑，占位名称不代表本包导出了完整机器人运行器。选模失败时不提交；所有渠道不可用时保留任务；曾调用任何工具时，公开示例采取不重放的保守规则。

## 4. 区分三本账

- 提交审计：逻辑任务由哪个渠道承接、宿主是否确认完成。
- 上游用量：实际模型步骤、token 与重试；以真实响应或 OFM 记录为准。
- 账户费用：剩余额度、Credits 或账单；上游不提供时保持未知。

只在真实回合完成时调用 `audit.finish(id, { ok: true })`。它既不是消息投递回执，也不会自动证明零扣费。
