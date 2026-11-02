import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { selectSessionRoute, mayReplayTurn, runLaneAttempts } from '../src/index.js';
import { catalog } from '../examples/catalog.mjs';

const readConfig = () => {
  const config = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  config.enabled = true;
  config.dsh.qoderCnFreeUntil = '2030-01-01T00:00:00+08:00';
  return config;
};
const now = Date.parse('2026-10-30T12:00:00+08:00');

test('default config blocks integration before any host operation', async () => {
  const config = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  let called = false;
  await assert.rejects(selectSessionRoute({ config, api: { callUnary: async () => { called = true; } } }), { code: 'ROUTING_DISABLED' });
  assert.equal(called, false);
});

test('requires current catalog; missing catalog never selects an implicit model', async () => {
  await assert.rejects(selectSessionRoute({ config: readConfig(), sessionId: 'fixture', api: { callUnary() {} } }), { code: 'CATALOG_REQUIRED' });
});

test('selection follows cooldown and task effort; no prompt is submitted', async () => {
  const calls = [];
  const api = { callUnary: async (...args) => { calls.push(args); return { result: { ok: true, value: {} } }; } };
  const options = { config: readConfig(), sessionId: 'fixture', api, catalog, now };
  const first = await selectSessionRoute(options);
  assert.equal(first.provider, 'qodercn');
  assert.equal(first.reasoningEffort, 'none');
  const ledger = { cooling: key => key.startsWith('qodercn/') ? { retryAt: now + 10000 } : null };
  const backup = await selectSessionRoute({ ...options, ledger });
  assert.equal(backup.provider, 'trae');
  assert.equal(backup.reasoningEffort, 'light');
  assert.equal((await selectSessionRoute({ ...options, ledger, task: 'selfReflection' })).reasoningEffort, 'high');
  assert.ok(calls.every(([method]) => method === 'session/selectModel'));
});

test('missing or expired promotion skips CN even if it is catalogued', async () => {
  for (const expiry of [undefined, 'not-a-date', '1970-01-01T00:00:00Z']) {
    const config = readConfig();
    config.dsh.qoderCnFreeUntil = expiry;
    const route = await selectSessionRoute({ config, sessionId: 'fixture', catalog, now,
      api: { callUnary: async () => ({ result: { ok: true } }) } });
    assert.equal(route.provider, 'trae');
  }
});

test('failed or ambiguous selectModel response aborts instead of claiming success', async () => {
  for (const response of [undefined, {}, { result: { ok: false, error: { code: 'fixture-error' } } }]) {
    await assert.rejects(selectSessionRoute({ config: readConfig(), sessionId: 'fixture', catalog, now,
      api: { callUnary: async () => response } }));
  }
});

test('both lanes unavailable leaves the task pending without another provider', async () => {
  let calls = 0;
  await assert.rejects(selectSessionRoute({ config: readConfig(), sessionId: 'fixture', catalog, now,
    ledger: { cooling: () => ({ retryAt: now + 1000 }) },
    api: { callUnary: async () => { calls++; } } }), { code: 'LANE_EXHAUSTED' });
  assert.equal(calls, 0);
});
test('selection reports host-resolved default effort and rejects a mismatched provider acknowledgement', async () => {
  const config = readConfig(); config.dsh.reasoningEffort = 'preserve'; config.dsh.taskReasoningEfforts = {};
  const options = { config, sessionId: 'fixture', catalog, now };
  const route = await selectSessionRoute({ ...options, api: { callUnary: async (_method, request) => ({ result: { ok: true, value: { selected: { ...request, reasoningEffort: 'max' } } } }) } });
  assert.equal(route.reasoningEffort, 'max');
  await assert.rejects(selectSessionRoute({ ...options, api: { callUnary: async () => ({ result: { ok: true, value: { selected: { provider: 'wrong', model: 'wrong' } } } }) } }), { code: 'MODEL_SELECTION_MISMATCH' });
});

test('replay requires confirmed cancellation, no tool call and no external action', () => {
  const safe = { error: { status: 503 }, cancelConfirmed: true, hadToolCall: false, externalActionState: 'none' };
  assert.equal(mayReplayTurn(safe), true);
  for (const unsafe of [
    { cancelConfirmed: false }, { cancelConfirmed: undefined },
    { hadToolCall: true }, { hadToolCall: undefined },
    { externalActionState: 'unknown' }, { externalActionState: 'success' },
    { externalActionState: undefined }, { error: { message: 'content policy violation' } }
  ]) assert.equal(mayReplayTurn({ ...safe, ...unsafe }), false);
});

test('bounded attempts never retry an unknown send and never exceed two attempts', async () => {
  let calls = 0;
  const error = Object.assign(new Error('transport failed'), { status: 503 });
  await assert.rejects(runLaneAttempts({
    run: async () => { calls++; throw error; },
    canRetry: e => mayReplayTurn({ error: e, cancelConfirmed: true, hadToolCall: true, externalActionState: 'unknown' })
  }));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(runLaneAttempts({ maxAttempts: 100,
    run: async () => { calls++; throw error; },
    canRetry: e => mayReplayTurn({ error: e, cancelConfirmed: true, hadToolCall: false, externalActionState: 'none' })
  }));
  assert.equal(calls, 2);
});
