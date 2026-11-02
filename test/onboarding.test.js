import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPolicyStore, chooseDeepSeek, onboard, streamGuard, rotationReadiness, officialFallback, observeAccountPool, assertRoute, noteFailure } from '../src/onboarding.js';
import { apply } from '../src/plugin.js';
import { resolveLaneEffort } from '../src/model-lanes.js';

const menu = { efforts: ['disabled', 'low', 'high', 'max'].map(id => ({ id })) };
const ds = { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash', reasoning: menu };
const catalog = () => ({ default: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }, groups: [
  { id: 'deepseek-official', models: [{ id: 'deepseek-flash', reasoning: menu }] },
  { id: 'our-free-model', models: [{ id: 'glm-fixture-free' }, { id: 'mimo-fixture-free' }, ds, { id: 'combo:recommended-free' }] },
  { id: 'qodercn', models: [{ id: 'qfmodel', name: 'Qwen' }, { id: 'dfmodel', name: 'DeepSeek-Flash', reasoning: menu }] },
  { id: 'trae', models: [{ id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4' }] }
] });
function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfy-onboard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, value: createPolicyStore(path.join(dir, 'onboarding-policy.json')) };
}
const select = async route => ({ selected: route });
const route = { provider: 'our-free-model', model: ds.id, reasoningEffort: 'max' };

test('default selection stays DeepSeek and preserves the exact max effort', () => {
  assert.deepEqual(chooseDeepSeek(catalog(), 'free', catalog().default), route);
  assert.equal(chooseDeepSeek(catalog(), 'qodercn', catalog().default).model, 'dfmodel');
  assert.equal(chooseDeepSeek(catalog(), 'trea', {}).provider, 'trae');
  assert.throws(() => chooseDeepSeek(catalog(), 'trae', catalog().default), { code: 'EFFORT_NOT_PRESERVED' });
  const absent = catalog(); absent.groups = absent.groups.filter(g => g.id !== 'our-free-model');
  assert.throws(() => chooseDeepSeek(absent, 'free', {}), { code: 'DEEPSEEK_UNAVAILABLE' });
});
test('public setup reports no account rotation and does not claim unexercised funding', async t => {
  const s = store(t).value;
  const result = await onboard({ catalog: catalog(), current: catalog().default, select, store: s });
  assert.equal(result.modelConfirmed, true);
  assert.equal(result.ofmRoutingConfirmed, false);
  assert.equal(result.rotation.available, false);
  assert.equal(result.rotation.reason, 'PUBLIC_POOL_HAS_NO_ACCOUNTS');
  assert.equal(result.status, 'needs-verification-or-action');
});
test('OFM account-pool exclusion selects a distinct backup without leaking identities or credentials', async () => {
  const account = id => ({ entry: { id }, credential: { token: 'secret-token-sentinel' } });
  const calls = [];
  const pool = { getAvailableAccount: async (_provider, _model, excluded) => {
    calls.push([...excluded]); return account(excluded.has('private-a') ? 'private-b' : 'private-a');
  } };
  const result = await rotationReadiness(pool, { provider: 'qodercn', model: 'dfmodel' });
  assert.equal(result.available, true); assert.equal(result.exercised, false);
  assert.deepEqual(calls, [[], ['private-a']]);
  assert.doesNotMatch(JSON.stringify(result), /private-a|private-b|secret-token-sentinel/);
  const single = { getAvailableAccount: async (_p, _m, excluded) => excluded.size ? null : account('one') };
  assert.equal((await rotationReadiness(single, { provider: 'qodercn', model: 'dfmodel' })).reason, 'SECOND_USABLE_ACCOUNT_REQUIRED');
});
test('guard blocks official and non-DS dispatch before the adapter, including auxiliary callers', async t => {
  const s = store(t).value; s.update({ route });
  const guard = streamGuard(s); let dispatched = 0;
  const next = async () => { dispatched++; return (async function* () {})(); };
  for (const request of [{ provider: 'deepseek-official', model: 'deepseek-flash' }, { provider: 'our-free-model', model: 'glm-fixture-free' }, { provider: 'our-free-model', model: 'combo:recommended-free' }]) {
    await assert.rejects(async () => { for await (const _ of guard({ ...request, source: { kind: 'session-title' } }, next)) {} }, { code: 'OFM_ROUTE_BLOCKED' });
  }
  assert.equal(dispatched, 0);
});
test('receipt confirms host routing only, not physical request count or actual charges', async t => {
  const { value: s, dir } = store(t); s.update({ route });
  const stream = await streamGuard(s)(route, async () => (async function* () {
    yield { type: 'text-delta', text: 'private-response-sentinel' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })());
  for await (const _ of stream) {}
  assert.equal(s.read().receipt.outcome, 'completed');
  assert.equal(s.read().receipt.physicalRequests, 'unknown');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'onboarding-policy.json'), 'utf8'), /private-response-sentinel/);
});
test('official fallback needs explicit confirmation and a recent unrecovered OFM funding/transport failure', async t => {
  const s = store(t).value; s.update({ route });
  assert.throws(() => officialFallback(catalog(), s, false), { code: 'OFFICIAL_CONFIRMATION_REQUIRED' });
  assert.throws(() => officialFallback(catalog(), s, true), { code: 'FALLBACK_TRIGGER_MISSING' });
  s.update({ failure: { code: 'INVALID_REQUEST', at: Date.now() } });
  assert.throws(() => officialFallback(catalog(), s, true), { code: 'FALLBACK_TRIGGER_MISSING' });
  s.update({ failure: { code: 'QUOTA_EXCEEDED', at: Date.now() } });
  const fallback = officialFallback(catalog(), s, true);
  assert.equal(fallback.provider, 'deepseek-official'); assert.equal(fallback.reasoningEffort, 'max');
  s.update({ receipt: { ...route, lane: 'ofm', outcome: 'completed', at: Date.now() + 1 } });
  assert.throws(() => officialFallback(catalog(), s, true), { code: 'FALLBACK_TRIGGER_MISSING' });
});
test('host sessionId receipts do not reuse another conversation or a title call as evidence', async t => {
  const s = store(t).value; s.update({ route });
  const run = async request => { for await (const _ of streamGuard(s)(request, async () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })())) {} };
  await run({ ...route, sessionId: 'original-session' });
  await run({ ...route }); // an auxiliary caller with no session
  assert.equal(s.read().receipts['original-session'].outcome, 'completed');
  const fresh = await onboard({ catalog: catalog(), current: catalog().default, select, store: s, sessionId: 'other-session' });
  assert.equal(fresh.ofmRoutingConfirmed, false);
});
test('models explicitly declaring no reasoning never receive guessed effort', () => {
  const lane = { provider: 'trae', model: 'DeepSeek-V4-Flash', reasoningEffort: 'max' };
  assert.equal(resolveLaneEffort({ lane, catalog: catalog(), globalEffort: 'max' }), undefined);
});
test('native plugin exposes one-sentence tool, uses safe creation-time selection and refuses forged fallback', async t => {
  const dir = store(t).dir; const events = new Map(); let command, tool; const selected = [];
  const ctx = { logger: { warn() {} }, on: (name, handler) => events.set(name, handler), get: () => undefined,
    commands: { register: value => { command = value; } },
    inject: (deps, fn) => deps.includes('tools') ? fn({ tools: { register: value => { tool = value; } } }) : undefined,
    sessionController: { modelCatalog: async () => catalog(), selectModel: async request => { selected.push(request); return { selected: request }; },
      agents: { selectForNextRequest: (_agent, value) => selected.push(value) } } };
  apply(ctx, { policyFile: path.join(dir, 'native-policy.json'), ofmControl: async () => ({ enabled: true }) });
  assert.equal(tool.name, 'bfy_ofm_onboard');
  const agent = { id: 'current-existing-session', session: { requestHeader: () => undefined } };
  await events.get('agent/created')({ agent });
  assert.equal(selected[0].model, ds.id); assert.equal(selected[0].reasoningEffort, 'max');
  const result = await tool.execute({ provider: 'free' }, { agent });
  assert.equal(result.ofmRoutingConfirmed, false);
  assert.equal(selected.at(-1).sessionId, agent.id);
  const rejected = await command.handler({ agent, rawInput: 'fallback', signal: new AbortController().signal });
  assert.equal(rejected.kind, 'error'); assert.match(rejected.text, /OFFICIAL_CONFIRMATION_REQUIRED/);
});
test('rotation observation uses only actual guarded selector calls and never saves account identities', async t => {
  const { value: s, dir } = store(t);
  const accountRoute = { provider: 'qodercn', model: 'dfmodel', reasoningEffort: 'max' };
  s.update({ route: accountRoute });
  const original = async (_p, _m, excluded) => ({ entry: { id: excluded.size ? 'private-second' : 'private-first' }, credential: { token: 'private-token' } });
  const pool = { getAvailableAccount: original };
  const cleanup = observeAccountPool(pool);
  await rotationReadiness(pool, accountRoute); // preflight is NOT live rotation evidence
  assert.equal(s.read().receipt, null);
  const chunks = streamGuard(s)({ ...accountRoute, sessionId: 'same-session' }, async () => (async function* () {
    const first = await pool.getAvailableAccount('qodercn', 'dfmodel', new Set());
    await pool.getAvailableAccount('qodercn', 'dfmodel', new Set([first.entry.id]));
    yield { type: 'finish', reason: { kind: 'stop' } };
  })());
  for await (const _ of chunks) {}
  assert.equal(s.read().receipts['same-session'].rotationObserved, true);
  assert.equal(s.read().receipts['same-session'].distinctAccounts, 2);
  const result = await onboard({ catalog: catalog(), current: catalog().default, provider: 'qodercn', select, store: s, pool, sessionId: 'same-session' });
  assert.equal(result.status, 'complete');
  assert.equal(result.rotation.verified, true); assert.equal(result.rotation.exercised, true);
  assert.equal(result.ofmAccountPoolConfirmed, true);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'onboarding-policy.json'), 'utf8'), /private-first|private-second|private-token/);
  cleanup(); assert.equal(pool.getAvailableAccount, original);
});
test('a session-specific failure and consent cannot authorize official charges for other callers', t => {
  const s = store(t).value; s.update({ route });
  noteFailure(s, { code: 'QUOTA_EXCEEDED' }, 'failing-session');
  assert.throws(() => officialFallback(catalog(), s, true, 'healthy-session'), { code: 'FALLBACK_TRIGGER_MISSING' });
  const official = officialFallback(catalog(), s, true, 'failing-session');
  s.update({ fallback: { active: true, sessionId: 'failing-session', confirmedAt: Date.now(), route: official } });
  assert.equal(assertRoute(s.read(), { ...official, sessionId: 'failing-session' }), 'official-explicit-fallback');
  for (const sessionId of ['healthy-session', undefined]) assert.throws(() => assertRoute(s.read(), { ...official, sessionId }), { code: 'OFM_ROUTE_BLOCKED' });
});
test('stream exceptions replace stale success with failed evidence and preserve upstream failure scope', async t => {
  const s = store(t).value; s.update({ route });
  const guard = streamGuard(s);
  await assert.rejects(async () => {
    for await (const _ of guard({ ...route, sessionId: 'one-session' }, async () => (async function* () { throw Object.assign(new Error('private-upstream-message'), { code: 'TIMEOUT' }); })())) {}
  });
  assert.equal(s.read().receipts['one-session'].outcome, 'failed');
  assert.equal(s.read().failures['one-session'].code, 'TIMEOUT');
  assert.equal(s.read().failures['other-session'], undefined);
  assert.doesNotMatch(JSON.stringify(s.read()), /private-upstream-message/);
});
test('closing a stream early records unknown rather than a successful model response', async t => {
  const s = store(t).value; s.update({ route });
  const stream = streamGuard(s)({ ...route, sessionId: 'cancelled' }, async () => (async function* () {
    yield { type: 'text-delta', text: 'partial' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })());
  await stream.next(); await stream.return();
  assert.equal(s.read().receipts.cancelled.outcome, 'unknown');
});
test('status does not reuse an old OFM receipt after the user changes the actual selection', async t => {
  const dir = store(t).dir; let command; let actual; const events = new Map();
  const ctx = { on: (name, handler) => events.set(name, handler), inject() {}, get() {},
    commands: { register: value => { command = value; } },
    sessionController: { modelCatalog: async () => catalog(), selectModel: async request => { actual = request; return { selected: request }; }, agents: { selectionFor: () => ({ current: actual }) } } };
  apply(ctx, { policyFile: path.join(dir, 'policy.json'), ofmControl: async () => ({ enabled: true }) });
  const agent = { id: 'same', session: { requestHeader: () => undefined } };
  const invoke = rawInput => command.handler({ agent, rawInput, signal: new AbortController().signal });
  await invoke('onboard');
  for await (const _ of events.get('llm/stream')({ ...route, sessionId: agent.id }, async () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })())) {}
  assert.equal(JSON.parse((await invoke('status')).text).ofmRoutingConfirmed, true);
  actual = { provider: 'deepseek-official', model: 'deepseek-flash' };
  const result = JSON.parse((await invoke('status')).text);
  assert.equal(result.modelConfirmed, true); assert.equal(result.ofmRoutingConfirmed, false);
  assert.notEqual(result.status, 'complete');
});

test('two sessions retain independent OFM routes when onboarding and restoring either conversation', async t => {
  const dir = store(t).dir;
  const file = path.join(dir, 'policy.json');
  const events = new Map(); const selections = new Map(); let command;
  const ctx = { on: (name, handler) => events.set(name, handler), inject() {}, get() {},
    commands: { register: value => { command = value; } },
    sessionController: { modelCatalog: async () => catalog(),
      selectModel: async request => { selections.set(request.sessionId, request); return { selected: request }; },
      agents: { selectionFor: agent => ({ current: selections.get(agent.id) ?? catalog().default }),
        selectForNextRequest: (agent, route) => selections.set(agent.id, route) } } };
  apply(ctx, { policyFile: file, ofmControl: async () => ({ enabled: true }) });
  const free = { id: 'free-conversation' }; const account = { id: 'account-conversation' };
  const invoke = async (agent, rawInput) => {
    const result = await command.handler({ agent, rawInput, signal: new AbortController().signal });
    assert.equal(result.kind, 'success', result.text); return JSON.parse(result.text);
  };
  await invoke(free, 'onboard');
  await invoke(account, 'onboard qodercn');
  const run = async agent => {
    for await (const _ of events.get('llm/stream')({ ...selections.get(agent.id), sessionId: agent.id }, async () => (async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } };
    })())) {}
  };
  await run(free); await run(account);
  for (const [agent, provider] of [[free, 'our-free-model'], [account, 'qodercn']]) {
    const result = await invoke(agent, 'status');
    assert.equal(result.configuredOfmRoute.provider, provider);
    assert.equal(result.ofmRoutingConfirmed, true);
  }
  await assert.rejects(async () => {
    for await (const _ of events.get('llm/stream')({ ...selections.get(account.id), sessionId: free.id }, async () => {
      throw new Error('must not dispatch a different session route');
    })) {}
  }, { code: 'OFM_ROUTE_BLOCKED' });
  await events.get('agent/created')({ agent: free });
  assert.equal(selections.get(free.id).provider, 'our-free-model');
  assert.equal(createPolicyStore(file).read().provider, 'qodercn');
  await run(free); await run(account);
});
