import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { selectSessionRoute } from './session-route.js';
import { createLaneLedger, classifyLaneFailure, laneKey } from './model-lanes.js';
import { createInferenceAudit } from './inference-audit.js';
import { createTurnStallGuard } from './turn-stall-guard.js';
import { acquireStateLock } from './configuration.js';
import { hostError, redact } from './dsh-client.js';

export async function selectWithFailover(options) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await selectSessionRoute(options); }
    catch (error) {
      const failure = classifyLaneFailure(error);
      if (!failure || !error.route || !options.ledger) throw error;
      options.ledger.cool(laneKey(error.route), { ...failure, reason: failure.kind });
      if (attempt === 1) throw error;
    }
  }
}

/** One owned, isolated session; no prompts or tool arguments in local metadata.
 * Selection failures may fail over before submission. After submission the
 * runner never replays, including lost replies and uncertain cancellation.
 */
export async function runOneTurn({ client, config, stateDir, prompt, task = 'chat', timeoutMs = 90000, agentPreset, signal } = {}) {
  if (config?.enabled !== true) throw hostError('请先运行 setup 并确认自己的渠道', 'ROUTING_DISABLED');
  if (typeof prompt !== 'string' || !prompt.trim()) throw hostError('提示词不能为空', 'EMPTY_PROMPT');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 600000) throw hostError('timeoutMs 必须在 100—600000 毫秒之间', 'INVALID_TIMEOUT');
  const unlock = acquireStateLock(stateDir);
  const runId = randomUUID();
  const workDir = path.join(stateDir, 'workspaces', runId);
  let audit, ledger;
  let sessionId, route, subscription, guard, timer, auditId, submitted = false, completed = false, terminal = false, hadToolCall = false;
  let previousDefault, restoreDefault = false;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const text = [];
  const seen = new Set();
  let requestProvider;
  const finish = value => { if (!terminal) { terminal = true; resolveDone(value); } };
  const pendingFile = path.join(stateDir, `${runId}.json`);
  const persist = status => fs.writeFileSync(pendingFile, JSON.stringify({ runId, sessionId, task, route, status, submitted, hadToolCall }, null, 2) + '\n', { mode: 0o600 });
  const abort = () => finish({ error: hostError('用户已停止本次任务', 'ABORTED') });
  try {
    fs.mkdirSync(workDir, { recursive: true });
    audit = createInferenceAudit({ file: path.join(stateDir, 'audit.jsonl') });
    ledger = createLaneLedger({ file: path.join(stateDir, 'model-lanes.json'), policy: () => config.dsh,
      log: message => { throw hostError(message, 'STATE_PERSISTENCE_FAILED'); } });
    const catalog = await client.catalog();
    previousDefault = catalog.default;
    const session = await client.rpc('session/create', { cwd: workDir, ...(agentPreset ? { agentPreset } : {}) }, signal);
    sessionId = session?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw hostError('DSH 未确认新会话创建成功', 'SESSION_CREATE_FAILED');
    // A user-pinned title suppresses DSH's automatic title LLM. Without this a
    // nominal one-prompt smoke test can silently cause an auxiliary model call.
    await client.rpc('session/rename', { sessionId, title: 'OFM text verification' }, signal);
    restoreDefault = true;
    const selectionApi = { callUnary: (method, payload) => {
      route = { provider: payload.provider, model: payload.model, ...(payload.reasoningEffort ? { reasoningEffort: payload.reasoningEffort } : {}) };
      return client.callUnary(method, payload);
    } };
    route = await selectWithFailover({ api: selectionApi, sessionId, config, catalog, ledger, task });
    // DSH's public selectModel endpoint also saves the deployment default.
    // Restore only if it still names our route; never overwrite a later user choice.
    persist('selected');
    guard = createTurnStallGuard({ stallMs: 45000, maxModelMs: timeoutMs,
      onStall: () => finish({ error: hostError('模型阶段无有效输出', 'TURN_STALL') }) });
    subscription = await client.follow(sessionId, event => {
      if (!submitted || terminal) return;
      if (event?.seq != null) {
        if (seen.has(event.seq)) return;
        seen.add(event.seq);
      }
      guard.observe(sessionId, event);
      const data = event.data ?? {};
      if (event.type === 'request/header') requestProvider = data.header?.config?.provider;
      if (event.type === 'tool/call') {
        hadToolCall = true;
        finish({ error: hostError('发现工具调用，已请求停止；可能已产生副作用，不会自动重放', 'TOOL_CALL_BLOCKED') });
      } else if (event.type === 'assistant/message') {
        for (const block of data.message?.content ?? []) if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
      } else if (event.type === 'turn/end') {
        if (data.reason?.kind === 'completed') finish({ ok: true });
        else finish({ error: hostError(redact(data.reason?.error?.message ?? 'DSH 回合未完成'), data.reason?.error?.code ?? 'TURN_FAILED', { status: data.reason?.error?.status }), definiteFailure: true });
      } else if (['stream/error', 'session/error', 'turn/error'].includes(event.type)) {
        finish({ error: hostError('事件流断开或回合异常；结果未知，不自动重试', 'STREAM_CLOSED') });
      }
    }, { signal });
    signal?.addEventListener('abort', abort, { once: true });
    signal?.throwIfAborted();
    timer = setTimeout(() => finish({ error: hostError('已达到本回合总等待期限', 'TURN_STALL') }), timeoutMs);
    auditId = audit.begin({ sessionId, task, provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort });
    // A lost RPC acknowledgement is still a potentially accepted prompt.
    submitted = true;
    persist('pending');
    guard.expect(sessionId);
    const accepted = await client.rpc('session/prompt', { sessionId, mode: 'queue', requestId: runId, content: [{ type: 'text', text: prompt }] }, signal);
    if (accepted?.accepted !== true) throw hostError('DSH 未明确确认提示词接收；不会自动重放', 'PROMPT_UNCONFIRMED');
    const result = await done;
    if (result.error) {
      if (result.definiteFailure) audit.finish(auditId, { ok: false, code: result.error.code });
      throw result.error;
    }
    const body = text.join('').trim();
    if (!body) throw hostError('回合结束但没有正文；不能判为接入成功', 'EMPTY_RESPONSE');
    if (requestProvider && requestProvider !== route.provider) throw hostError('回合实际渠道与选路不一致', 'ROUTE_MISMATCH');
    completed = true;
    audit.finish(auditId, { ok: true });
    persist('completed');
    return { ok: true, status: 'completed', runId, sessionId, provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort, hadToolCall, text: body };
  } catch (error) {
    if (route) {
      const failure = classifyLaneFailure(error);
      if (failure) ledger.cool(laneKey(route), { ...failure, reason: failure.kind });
    }
    if (sessionId) persist(submitted ? 'unknown' : 'not-submitted');
    error.runId = runId;
    throw error;
  } finally {
    clearTimeout(timer);
    guard?.clearAll();
    subscription?.close();
    signal?.removeEventListener('abort', abort);
    if (sessionId && !completed) await client.stopOwnedSession(sessionId).catch(() => false);
    if (sessionId && route && restoreDefault && previousDefault?.provider && previousDefault?.model) {
      try {
        const current = (await client.catalog()).default;
        if (current?.provider === route.provider && current?.model === route.model && current.reasoningEffort === route.reasoningEffort) {
          await client.rpc('session/selectModel', { sessionId, ...previousDefault });
        }
      } catch {
        // Make incomplete restoration visible without masking the model result.
        fs.writeFileSync(path.join(stateDir, `${runId}.cleanup.json`), JSON.stringify({ code: 'DEFAULT_RESTORE_UNCONFIRMED', sessionId }) + '\n');
      }
    }
    if (sessionId && completed) await client.rpc('workspace/archiveSession', { sessionId }).catch(() => {
      fs.writeFileSync(path.join(stateDir, `${runId}.cleanup.json`), JSON.stringify({ code: 'SESSION_ARCHIVE_UNCONFIRMED', sessionId }) + '\n');
    });
    // Keep the empty owned directory while DSH references it. No user files are removed.
    unlock();
  }
}
