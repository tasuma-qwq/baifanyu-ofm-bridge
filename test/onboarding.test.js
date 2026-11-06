import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPolicyStore, chooseDeepSeek, onboard, observeStream, rotationReadiness, officialFallback, observeAccountPool, noteFailure } from '../src/onboarding.js';
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
test('observation permits manual official, non-DS, account and combo models unchanged', async t => {
  const s = store(t).value; s.update({ route });
  let dispatched = 0;
  for (const request of [{ provider: 'deepseek-official', model: 'deepseek-flash' },
    { provider: 'qodercn', model: 'dfmodel' }, { provider: 'our-free-model', model: 'glm-fixture-free' },
    { provider: 'our-free-model', model: 'combo:recommended-free' }, { provider: 'custom', model: 'other' }]) {
    const expected = { type: 'finish', reason: { kind: 'stop' } };
    const chunks = [];
    for await (const chunk of observeStream(s)(request, async () => {
      dispatched++; return (async function* () { yield expected; })();
    })) chunks.push(chunk);
    assert.equal(chunks[0], expected);
  }
  assert.equal(dispatched, 5);
  assert.deepEqual(s.read().route, route);
});

test('unreadable or unwritable observation state never blocks model dispatch', async () => {
  let dispatched = 0; let warnings = 0;
  const broken = { read() { throw new Error('bad state'); }, update() { throw new Error('disk full'); } };
  for await (const _ of observeStream(broken, { onError: () => warnings++ })({ provider: 'custom', model: 'manual' }, async () => {
    dispatched++; return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })();
  })) {}
  assert.equal(dispatched, 1); assert.ok(warnings > 0);
});
test('receipt confirms host routing only, not physical request count or actual charges', async t => {
  const { value: s, dir } = store(t); s.update({ route });
  const stream = await observeStream(s)(route, async () => (async function* () {
    yield { type: 'text-delta', text: 'private-response-sentinel' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })());
  for await (const _ of stream) {}
  assert.equal(s.read().receipt.outcome, 'completed');
  assert.equal(s.read().receipt.physicalRequests, 'unknown');
  await s.flush();
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
  const run = async request => { for await (const _ of observeStream(s)(request, async () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })())) {} };
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
test('native plugin exposes explicit onboarding without overriding new or resumed sessions', async t => {
  const dir = store(t).dir; const events = new Map(); let command; const tools = []; const selected = [];
  const ctx = { logger: { warn() {} }, on: (name, handler) => events.set(name, handler), get: () => undefined,
    llm: { listProviders: () => [{ id: 'our-free-model' }, { id: 'our-free-model-region' }] },
    commands: { register: value => { command = value; } },
    inject: (deps, fn) => deps.includes('tools') ? fn({ tools: { register: value => { tools.push(value); } } }) : undefined,
    sessionController: { modelCatalog: async () => catalog(), selectModel: async request => { selected.push(request); return { selected: request }; },
      agents: { selectForNextRequest: (_agent, value) => selected.push(value) } } };
  apply(ctx, { policyFile: path.join(dir, 'native-policy.json'), ofmControl: async () => ({ enabled: true }) });
  const tool = tools.find(value => value.name === 'bfy_ofm_onboard');
  const agent = { id: 'current-existing-session', session: { requestHeader: () => undefined } };
  assert.equal(events.has('agent/created'), false);
  assert.equal(selected.length, 0);
  const result = await tool.execute({ provider: 'free' }, { agent });
  assert.equal(result.ofmRoutingConfirmed, false);
  assert.equal(selected.at(-1).sessionId, agent.id);
  const rejected = await command.handler({ agent, rawInput: 'fallback', signal: new AbortController().signal });
  assert.equal(rejected.kind, 'error'); assert.match(rejected.text, /OFFICIAL_CONFIRMATION_REQUIRED/);
});
test('rotation observation uses only actual observed selector calls and never saves account identities', async t => {
  const { value: s, dir } = store(t);
  const accountRoute = { provider: 'qodercn', model: 'dfmodel', reasoningEffort: 'max' };
  s.update({ route: accountRoute });
  const original = async (_p, _m, excluded) => ({ entry: { id: excluded.size ? 'private-second' : 'private-first' }, credential: { token: 'private-token' } });
  const pool = { getAvailableAccount: original };
  const cleanup = observeAccountPool(pool);
  await rotationReadiness(pool, accountRoute); // preflight is NOT live rotation evidence
  assert.equal(s.read().receipt, null);
  const chunks = observeStream(s)({ ...accountRoute, sessionId: 'same-session' }, async () => (async function* () {
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
test('explicit model picks the exact lane and unknown models fail with LANE_NOT_IN_CATALOG', async t => {
  const s = store(t).value;
  const result = await onboard({ catalog: catalog(), current: catalog().default, provider: 'qodercn', model: 'dfmodel', select, store: s });
  assert.equal(result.route.provider, 'qodercn');
  assert.equal(result.route.model, 'dfmodel');
  assert.equal(result.route.reasoningEffort, 'max');
  await assert.rejects(onboard({ catalog: catalog(), current: {}, provider: 'qodercn', model: 'not-in-catalog', select, store: s }), { code: 'LANE_NOT_IN_CATALOG' });
});
test('the switch surface is agent-readable and only executes a lane the user named', async t => {
  const dir = store(t).dir;
  const events = new Map(); const tools = []; const selected = []; let command;
  const ctx = { logger: { warn() {} }, on: (name, handler) => events.set(name, handler), get: () => undefined,
    llm: { listProviders: () => [{ id: 'our-free-model' }] },
    commands: { register: value => { command = value; } },
    inject: (deps, fn) => deps.includes('tools') ? fn({ tools: { register: value => { tools.push(value); } } }) : undefined,
    sessionController: { modelCatalog: async () => catalog(), selectModel: async request => { selected.push(request); return { selected: request }; },
      agents: { selectionFor: () => ({ current: catalog().default }) } } };
  apply(ctx, { policyFile: path.join(dir, 'policy.json'), ofmControl: async () => ({ enabled: true }) });
  // What another AI must be able to restate: the three lanes, the EAC boundary,
  // and that switching never happens without the user naming the lane.
  const switchTool = tools.find(x => x.name === 'bfy_ofm_switch');
  assert.ok(switchTool);
  assert.match(switchTool.description, /点名的切换/);
  assert.match(switchTool.description, /EAC 不是可切换车道/);
  assert.match(switchTool.description, /OFM 账号池/);
  assert.equal(switchTool.parameters.required.includes('provider'), true);
  const agent = { id: 'switch-session', session: { requestHeader: () => undefined } };
  const invoke = rawInput => command.handler({ agent, rawInput, signal: new AbortController().signal });
  const first = JSON.parse((await invoke('switch qodercn')).text);
  assert.equal(first.route.provider, 'qodercn');
  assert.equal(first.route.model, 'dfmodel');
  assert.equal(first.route.reasoningEffort, 'max'); // the effort the session already had
  assert.equal(first.switchedFrom, null);
  assert.equal(selected.at(-1).sessionId, agent.id);
  const second = JSON.parse((await invoke('switch free')).text);
  assert.equal(second.switchedFrom.provider, 'qodercn');
  assert.equal(second.route.model, 'deepseek-v4.1-flash-free');
  const refused = await invoke('switch eac');
  assert.equal(refused.kind, 'error');
  assert.match(refused.text, /EAC_NOT_A_LANE/);
  const miss = await switchTool.execute({ provider: 'qodercn', model: 'not-in-catalog' }, { agent });
  assert.equal(miss.code, 'LANE_NOT_IN_CATALOG');
});
test('a session-specific failure and consent cannot authorize official charges for other callers', t => {
  const s = store(t).value; s.update({ route });
  noteFailure(s, { code: 'QUOTA_EXCEEDED' }, 'failing-session');
  assert.throws(() => officialFallback(catalog(), s, true, 'healthy-session'), { code: 'FALLBACK_TRIGGER_MISSING' });
  const official = officialFallback(catalog(), s, true, 'failing-session');
  assert.equal(official.provider, 'deepseek-official');
});
test('stream exceptions replace stale success with failed evidence and preserve upstream failure scope', async t => {
  const s = store(t).value; s.update({ route });
  const guard = observeStream(s);
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
  const stream = observeStream(s)({ ...route, sessionId: 'cancelled' }, async () => (async function* () {
    yield { type: 'text-delta', text: 'partial' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })());
  await stream.next(); await stream.return();
  assert.equal(s.read().receipts.cancelled.outcome, 'unknown');
});
test('status does not reuse an old OFM receipt after the user changes the actual selection', async t => {
  const dir = store(t).dir; let command; let actual; const events = new Map();
  const ctx = { on: (name, handler) => events.set(name, handler), inject() {}, get() {},
    llm: { listProviders: () => [{ id: 'our-free-model' }] },
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

test('session receipts remain independent without enforcing their saved routes', async t => {
  const dir = store(t).dir;
  const file = path.join(dir, 'policy.json');
  const events = new Map(); const selections = new Map(); let command;
  const ctx = { on: (name, handler) => events.set(name, handler), inject() {}, get() {},
    llm: { listProviders: () => [{ id: 'our-free-model' }] },
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
  // A bridge may select another OFM route after onboarding; observation accepts it.
  for await (const _ of events.get('llm/stream')({ ...selections.get(account.id), sessionId: free.id }, async () => (async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } };
  })())) {}
  assert.equal(events.has('agent/created'), false);
  assert.equal(selections.get(free.id).provider, 'our-free-model');
  await run(free); await run(account);
});
