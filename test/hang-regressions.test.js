// Regression cover for the two failure classes reported after 0.3.1: a bundle
// patch that could abort the desktop boot, and host calls that could keep a
// turn (or the whole process) waiting forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { createPolicyStore, observeAccountPool, observeStream, guard } from '../src/onboarding.js';
import { acquireStateLock } from '../src/configuration.js';
import { apply } from '../src/plugin.js';

const ds = { id: 'deepseek-fixture-free', reasoning: { efforts: [{ id: 'max' }] } };
const catalog = () => ({ default: { provider: 'our-free-model', model: ds.id, reasoningEffort: 'max' },
  groups: [{ id: 'our-free-model', models: [ds] }, { id: 'qodercn', models: [{ id: 'dfmodel', name: 'DeepSeek-Flash', reasoning: { efforts: [{ id: 'max' }] } }] }] });
const tempDir = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfy-hang-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
// A host context that owns one mounted OFM, where a test decides whether the
// host answers, stalls, or cancels. The ceiling is short so the assertions prove
// the deadline rather than waiting on the production one.
function harness(t, { select = async route => ({ selected: route }), ofm = true } = {}) {
  const dir = tempDir(t);
  const calls = [];
  const pool = { getAvailableAccount: async () => null };
  let command, tool;
  const ctx = { logger: { warn() {} }, on() {}, get: key => (key === 'accountPool' && ofm ? pool : undefined),
    llm: { listProviders: () => (ofm ? [{ id: 'our-free-model' }] : []) },
    inject(deps, fn) { if (deps.includes('tools')) fn({ tools: { register: value => { tool = value; } }, effect: () => {} }); },
    commands: { register: value => { command = value; } },
    sessionController: { modelCatalog: async () => { calls.push('catalog'); return catalog(); },
      selectModel: async request => { calls.push('select'); return select(request); },
      agents: { selectionFor: () => ({ current: undefined }) } } };
  apply(ctx, { policyFile: path.join(dir, 'policy.json'), hostTimeoutMs: 200, ofmControl: async () => ({ enabled: true }) });
  const agent = { id: 'session-1', session: { requestHeader: () => undefined } };
  return { dir, calls, agent,
    invoke: rawInput => command.handler({ agent, rawInput, signal: new AbortController().signal }),
    run: (signal = new AbortController().signal) => tool.execute({ provider: 'free' }, { agent, signal }) };
}

test('the bundle patch owns only its own rows and carries no expression gates', () => {
  const layers = yaml.load(fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'));
  const rows = layers.flatMap(layer => layer.insert ?? []);
  assert.deepEqual(rows.map(row => row.id), ['baifanyu-ofm']);
  for (const row of rows) {
    // A bare package name would also carry that plugin's browser half, and a
    // second half can fail the merged client bundle and abort the whole boot.
    assert.match(row.name, /^baifanyu-ofm\//, 'only sub-path rows of this bundle may be inserted');
    assert.equal(row.disabled, undefined, 'no conditional mount gate');
  }
});
test('the manifest states its host requirement and no longer ships a copy of OFM', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.engines.dsh, '>=0.2.0-rc.1', 'the host compatibility gate needs a range to read');
  assert.equal(manifest.dependencies['@ebony-vinyl/dsh-our-free-model'], undefined);
});
test('a stalled host selection ends as an error instead of an endless turn', async t => {
  const { run, calls } = harness(t, { select: () => new Promise(() => {}) });
  const result = await run();
  assert.equal(result.status, 'needs-action');
  assert.equal(result.code, 'HOST_CALL_STALLED');
  assert.ok(calls.includes('select'));
});
test('a cancelled turn stops waiting and reports the cancellation', async t => {
  const controller = new AbortController();
  const { run } = harness(t, { select: () => new Promise(() => {}) });
  const pending = run(controller.signal);
  controller.abort(new Error('host cancelled'));
  await assert.rejects(pending, { code: 'HOST_CALL_CANCELLED' });
});
test('onboarding without a mounted OFM asks for installation and never probes the host', async t => {
  const { run, calls } = harness(t, { ofm: false });
  const result = await run();
  assert.equal(result.code, 'OFM_NOT_MOUNTED');
  assert.match(result.next, /dsh-our-free-model/);
  assert.deepEqual(calls, [], 'no model catalog or selection call is attempted');
});
test('the status command reports the missing OFM instead of a routing problem', async t => {
  const { invoke } = harness(t, { ofm: false });
  const status = JSON.parse((await invoke('status')).text);
  assert.equal(status.ofmMounted, false);
  assert.match(status.next, /插件管理器/);
});
test('observation state stays in memory and persists off the event loop', async t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'nested', 'onboarding-policy.json');
  const store = createPolicyStore(file);
  for await (const _ of observeStream(store)({ provider: 'our-free-model', model: ds.id, sessionId: 's' }, async () => (async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } };
  })())) {}
  assert.equal(store.read().receipts.s.outcome, 'completed');
  // Deterministic: no disk completion can be observed inside the same tick, so a
  // marker that is still missing on disk proves the stream path never blocked.
  store.update({ marker: 'in-memory-only' });
  const onDisk = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  assert.equal(onDisk.marker, undefined, 'a model call must not wait for a synchronous write');
  await store.flush();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).marker, 'in-memory-only');
});
test('an unwritable policy file is reported and leaves no temporary files behind', async t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'blocked'), 'not a directory');
  const warnings = [];
  const store = createPolicyStore(path.join(dir, 'blocked', 'policy.json'), { onWriteError: error => warnings.push(error.code) });
  store.update({ route: { provider: 'qodercn', model: 'dfmodel' } });
  await assert.rejects(store.flush(), { code: 'POLICY_UNWRITABLE' });
  assert.deepEqual(fs.readdirSync(dir), ['blocked'], 'a failed write must not accumulate *.tmp files');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^E(EXIST|NOTDIR|PERM)$/, 'the rejected path is reported once, with its real cause');
});
test('a second observer shares one account-pool wrapper instead of chaining', () => {
  const original = async () => null;
  const pool = { getAvailableAccount: original };
  const first = observeAccountPool(pool);
  const wrapper = pool.getAvailableAccount;
  const second = observeAccountPool(pool);
  assert.equal(pool.getAvailableAccount, wrapper, 'the wrapper must not wrap itself');
  first();
  assert.equal(pool.getAvailableAccount, wrapper, 'one released holder must not un-patch the other');
  second();
  assert.equal(pool.getAvailableAccount, original);
});
test('a guarded host call always settles, on answer, deadline or cancellation', async () => {
  assert.equal(await guard(() => 'value', { timeoutMs: 1000 }), 'value');
  await assert.rejects(guard(() => new Promise(() => {}), { timeoutMs: 60 }), { code: 'HOST_CALL_STALLED' });
  const controller = new AbortController();
  const pending = guard(() => new Promise(() => {}), { signal: controller.signal, timeoutMs: 60000 });
  controller.abort();
  await assert.rejects(pending, { code: 'HOST_CALL_CANCELLED' });
});
test('a lock left behind by a killed run is replaced, a live owner is not', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'writer.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, id: 'dead-run', at: new Date(Date.now() - 600000).toISOString() }));
  fs.utimesSync(file, new Date(Date.now() - 600000), new Date(Date.now() - 600000));
  const unlock = acquireStateLock(dir, { staleAfterMs: 120000 });
  assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).id, 'dead-run');
  assert.throws(() => acquireStateLock(dir), { code: 'STATE_BUSY' }, 'this process still owns it');
  unlock();
  assert.equal(fs.existsSync(file), false);
  unlock();
});
test('a damaged lock without a live owner stays untouched until it goes quiet', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'writer.lock');
  fs.writeFileSync(file, '{');
  assert.throws(() => acquireStateLock(dir, { staleAfterMs: 120000 }), { code: 'STATE_BUSY' });
  fs.utimesSync(file, new Date(), new Date(Date.now() - 600000));
  acquireStateLock(dir)();
});
