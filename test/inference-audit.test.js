import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInferenceAudit } from '../src/inference-audit.js';
import { createLaneLedger, classifyLaneFailure } from '../src/model-lanes.js';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-audit-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('submission audit omits prompt and credential fields, and retains unknown after restart', t => {
  const file = path.join(temp(t), 'audit.jsonl');
  const audit = createInferenceAudit({ file });
  const id = audit.begin({ sessionId: 'fixture', task: 'chat', sources: ['synthetic-scene'],
    provider: 'trae', model: 'fixture-model', prompt: 'private-prompt-sentinel', token: 'credential-sentinel' });
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /private-prompt-sentinel|credential-sentinel/);
  assert.equal(createInferenceAudit({ file }).snapshot().byProvider.trae.unknown, 1);
  audit.finish(id, { ok: true });
  audit.finish(id, { ok: false });
  assert.equal(createInferenceAudit({ file }).snapshot().byTask.chat.completed, 1);
});

test('corrupt audit file is preserved and fails visibly', t => {
  const file = path.join(temp(t), 'audit.jsonl');
  fs.writeFileSync(file, 'invalid-json');
  assert.throws(() => createInferenceAudit({ file }), /不可读/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'invalid-json');
});

test('daily quota survives restart and expires at next service day in UTC+8', t => {
  let at = Date.parse('2026-10-30T23:59:30+08:00');
  const options = { file: path.join(temp(t), 'lanes.json'), now: () => at,
    policy: () => ({ dailyQuotaResetUtcOffset: 8 }) };
  const ledger = createLaneLedger(options);
  ledger.cool('qodercn/dfmodel', classifyLaneFailure({ status: 402, message: 'Daily quota exceeded' }));
  assert.equal(ledger.cooling('qodercn/dfmodel').retryAt, Date.parse('2026-10-31T00:00:00+08:00'));
  assert.equal(createLaneLedger(options).isCooling('qodercn/dfmodel'), true);
  at += 31000;
  assert.equal(createLaneLedger(options).isCooling('qodercn/dfmodel'), false);
});
