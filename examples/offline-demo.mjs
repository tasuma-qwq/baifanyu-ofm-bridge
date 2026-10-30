// No network, no accounts, no QQ. All data is synthetic.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLaneLedger, classifyLaneFailure, createInferenceAudit,
  selectSessionRoute, mayReplayTurn } from '../src/index.js';
import { catalog } from './catalog.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baifanyu-ofm-demo-'));
// Fixed historical clock demonstrates logic; it does not extend real benefits.
const now = () => Date.parse('2026-10-30T12:00:00+08:00');
const config = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
config.enabled = true;
config.dsh.qoderCnFreeUntil = '2026-10-31T00:00:00+08:00';
const api = { callUnary: async () => ({ result: { ok: true, value: {} } }) };
try {
  console.log('白饭鱼 · OFM 接入演示');
  console.log('【离线模拟】不连接模型、不读取账号、不发送消息。\n');
  const ledger = createLaneLedger({ file: path.join(dir, 'lanes.json'), now, policy: () => config.dsh });
  const audit = createInferenceAudit({ file: path.join(dir, 'audit.jsonl'), now });
  const select = task => selectSessionRoute({ api, sessionId: 'demo-session', config, catalog, ledger, task, now: now() });
  let route = await select('chat');
  console.log(`1. 日常聊天 → ${route.provider}/${route.model} · ${route.reasoningEffort}`);
  route = await select('selfReflection');
  console.log(`2. 反思任务 → 同一渠道，档位 ${route.reasoningEffort}`);
  const error = { status: 402, message: 'Daily quota exceeded' };
  ledger.cool('qodercn/dfmodel', classifyLaneFailure(error));
  console.log('3. 模拟主渠道日额度用尽 → 单独冷却至 UTC+8 次日零点');
  route = await select('chat');
  console.log(`4. 新的聊天任务 → ${route.provider}/${route.model} · ${route.reasoningEffort}`);
  const id = audit.begin({ sessionId: 'demo-session', task: 'chat', ...route });
  // Synthetic completion, not a real model response.
  audit.finish(id, { ok: true });
  console.log('5. 模拟完成 → 本地只记渠道、任务、状态；不记正文或账号密钥');
  const safe = mayReplayTurn({ error, cancelConfirmed: true, hadToolCall: false, externalActionState: 'none' });
  const unknown = mayReplayTurn({ error, cancelConfirmed: true, hadToolCall: true, externalActionState: 'unknown' });
  console.log(`6. 取消已确认且没有行动 → 可重试：${safe}`);
  console.log(`   工具已调用、发出结果未知 → 可重试：${unknown}`);
  console.log('\n模型换了，长期记忆仍由原来的存储层管理。');
  console.log('本演示不包含记忆系统，也不证明当前渠道免费或可用。');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
