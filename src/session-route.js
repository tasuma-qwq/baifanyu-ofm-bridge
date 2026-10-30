// Public host adapter. The three other modules are production extracts;
// this adapter adds a small, explicit integration contract for this release.
import {
  resolveLaneChain, pickLane, resolveLaneEffort, classifyLaneFailure
} from './model-lanes.js';

function failure(message, code) {
  return Object.assign(new Error(message), { code });
}

/** Select only. This function never submits prompts or replays a turn. */
export async function selectSessionRoute({
  api, sessionId, config, catalog, ledger, task = 'chat', now = Date.now()
} = {}) {
  if (config?.enabled !== true) throw failure('请先核对渠道权益并显式启用接入', 'ROUTING_DISABLED');
  if (!sessionId || typeof api?.callUnary !== 'function') {
    throw failure('缺少有效 sessionId 或 DSH callUnary 接口', 'INVALID_HOST');
  }
  if (!Array.isArray(catalog?.groups)) {
    throw failure('必须从当前 DSH 会话取得模型目录', 'CATALOG_REQUIRED');
  }
  const policy = config.dsh ?? {};
  const chain = resolveLaneChain(policy, now);
  // Expired or unconfirmed promotions do not become an implicit default.
  const usable = chain.filter(lane => {
    if (`${lane.provider}/${lane.model}` !== 'qodercn/dfmodel') return true;
    const expiry = Date.parse(String(policy.qoderCnFreeUntil ?? ''));
    return Number.isFinite(expiry) && expiry > now;
  });
  const { lane, skipped } = pickLane({ chain: usable, catalog, ledger });
  if (!lane) throw failure('没有可用渠道，保留任务等待恢复', 'LANE_EXHAUSTED');
  const globalEffort = policy.taskReasoningEfforts?.[task] ?? policy.reasoningEffort ?? 'lowest';
  const reasoningEffort = resolveLaneEffort({ lane, catalog, globalEffort });
  const route = { ...lane, ...(reasoningEffort ? { reasoningEffort } : {}) };
  // Await this result before prompt submission. Never ignore ok:false.
  const envelope = await api.callUnary('session/selectModel', { sessionId, ...route });
  const result = envelope?.result ?? envelope;
  if (result?.ok !== true) {
    throw failure('DSH 未确认模型选择成功，未提交生成', result?.error?.code ?? 'MODEL_SELECTION_FAILED');
  }
  return { ...route, skipped };
}

/** Conservative host-side decision, for use with runLaneAttempts(). */
export function mayReplayTurn({
  error, cancelConfirmed, hadToolCall, externalActionState
} = {}) {
  return cancelConfirmed === true
    && hadToolCall === false
    && externalActionState === 'none'
    && classifyLaneFailure(error) !== null;
}
