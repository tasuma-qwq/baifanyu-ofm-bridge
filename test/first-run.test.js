import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { DshClient, localBase, redact } from '../src/dsh-client.js';
import { makeConfiguration, saveConfiguration, acquireStateLock, publicPoolLanes } from '../src/configuration.js';
import { runOneTurn } from '../src/runner.js';
import { apply } from '../src/plugin.js';
import { createInferenceAudit } from '../src/inference-audit.js';

const catalog = { default: { provider: 'trae', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' }, groups: [
  { id: 'our-free-model', models: [{ id: 'fixture-free', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }] },
  { id: 'trae', models: [{ id: 'deepseek-v4.1-flash' }] }
] };
const config = () => makeConfiguration(catalog, ['our-free-model/fixture-free', 'trae/deepseek-v4.1-flash']);
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfy-first-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function host(t, { selectFail = false, mode = 'ok', noSnapshot = false } = {}) {
  let followed = false;
  let sink;
  let selected = { ...catalog.default };
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const endpoint = req.url.slice(5);
    const payload = body.payload.args.request;
    calls.push({ endpoint, payload, cookie: req.headers.cookie });
    let value = {}, error;
    switch (endpoint) {
      case 'session/modelCatalog': value = { ...catalog, default: selected }; break;
      case 'session/create': value = { sessionId: 'new-owned-session' }; break;
      case 'session/selectModel':
        if (selectFail && payload.provider === 'our-free-model') error = { code: 'SERVER', status: 503, message: 'synthetic upstream failed' };
        else { selected = { provider: payload.provider, model: payload.model, reasoningEffort: payload.reasoningEffort }; value = { selected }; }
        break;
      case 'session/prompt':
        assert.equal(followed, true, 'prompt must follow a confirmed subscription baseline');
        assert.ok(calls.some(c => c.endpoint === 'session/rename' && c.payload.title), 'pin a human title before prompt to suppress auxiliary title LLM');
        assert.equal(typeof payload.requestId, 'string');
        value = { accepted: true };
        setTimeout(() => {
          sink({ type: 'turn/start', seq: 1, data: { turn: 1 } });
          if (mode === 'disconnect') { for (const socket of ws.clients) socket.close(); return; }
          if (mode === 'tool') { sink({ type: 'tool/call', seq: 2, data: { turn: 1, callId: 'unsafe' } }); return; }
          if (mode === 'silent') return;
          const event = { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text: 'BFY_OK' }] } } };
          sink(event); sink(event); // replayed transport frame must not duplicate the answer
          sink({ type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } });
        }, 5);
        break;
      case 'session/projections': value = { values: { agent: { status: 'idle' }, inbox: { 'next-turn': [], 'next-step': [] } } }; break;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: error ? { ok: false, error } : { ok: true, value } }));
  });
  const ws = new WebSocketServer({ server });
  ws.on('connection', socket => socket.on('message', bytes => {
    const open = JSON.parse(bytes);
    assert.equal(open.endpoint, 'session/follow');
    assert.ok(open.payload.args.request.maxMessages > 0, 'DSH rejects zero maxMessages');
    sink = event => socket.readyState === 1 && socket.send(JSON.stringify({ type: 'item', streamId: open.streamId, value: { type: 'event', event } }));
    if (!noSnapshot) {
      followed = true;
      socket.send(JSON.stringify({ type: 'item', streamId: open.streamId, value: { type: 'snapshot', records: [
        { type: 'turn/end', data: { reason: { kind: 'completed' } } }
      ] } }));
    }
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of ws.clients) socket.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  return { client: new DshClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, cookie: 'fixture=authorized', timeoutMs: 300 }), calls };
}

test('setup supports a discovered OFM lane, is idempotent and preserves different existing configuration', t => {
  const file = path.join(temp(t), 'config.local.json');
  const value = config();
  assert.equal(saveConfiguration(file, value).changed, true);
  assert.equal(saveConfiguration(file, value).changed, false);
  assert.throws(() => saveConfiguration(file, { ...value, enabled: false }), { code: 'CONFIG_EXISTS' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), value);
  assert.throws(() => makeConfiguration(catalog, ['deepseek-official/whatever']), { code: 'INVALID_LANE' });
});
test('remote hosts and URLs containing secrets are rejected before authentication', () => {
  for (const url of ['https://example.com', 'http://127.0.0.1/?token=secret', 'http://u:p@127.0.0.1', 'http://127.0.0.1/path']) {
    assert.throws(() => localBase(url));
  }
});
test('default setup selects public pool only, excluding accounts, EAC prefixes and editable combos', () => {
  const mixed = { groups: [
    { id: 'trae', models: [{ id: 'deepseek-v4.1-flash' }] },
    { id: 'our-free-model', models: ['combo:recommended-free', 'opencode/deepseek-v4.1-flash-free', 'deepseek-v4.1-flash-free', 'glm-5.3-flash-free'].map(id => ({ id })) }
  ] };
  assert.deepEqual(publicPoolLanes(mixed), ['our-free-model/deepseek-v4.1-flash-free']);
  assert.deepEqual(makeConfiguration(mixed).dsh.allowedProviders, ['our-free-model']);
  assert.equal(makeConfiguration(mixed).dsh.reasoningEffort, 'preserve');
  assert.throws(() => makeConfiguration({ groups: [{ id: 'trae', models: [{ id: 'deepseek-v4.1-flash' }] }] }), { code: 'PUBLIC_POOL_UNAVAILABLE' });
});
test('local credential access is opt-in even when a DSH home is provided', async t => {
  const client = new DshClient({ dshHome: temp(t), cookie: '', token: '' });
  await assert.rejects(client.authenticate(), { code: 'AUTH_REQUIRED' });
});
test('credential-bearing upstream diagnostics are redacted before display', () => {
  const message = 'Authorization: Bearer credential-sentinel\nCookie: first=secret-one; second=secret-two\nhttps://localhost/?token=url-secret';
  assert.doesNotMatch(redact(message), /credential-sentinel|secret-one|secret-two|url-secret/);
});
test('real HTTP/WS transport completes one turn after baseline and ignores duplicates/history', async t => {
  const { client, calls } = await host(t);
  const dir = temp(t);
  const result = await runOneTurn({ client, config: config(), stateDir: dir, prompt: 'private-prompt-sentinel', timeoutMs: 1000 });
  assert.equal(result.text, 'BFY_OK');
  assert.equal(result.status, 'completed');
  assert.equal(calls.filter(c => c.endpoint === 'session/prompt').length, 1);
  assert.ok(calls.every(c => c.cookie === 'fixture=authorized'));
  const auditText = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8');
  assert.doesNotMatch(auditText, /private-prompt-sentinel|fixture=authorized/);
  assert.equal(createInferenceAudit({ file: path.join(dir, 'audit.jsonl') }).snapshot().byTask.chat.completed, 1);
  assert.equal(calls.filter(c => c.endpoint === 'session/selectModel').at(-1).payload.reasoningEffort, 'high', 'previous deployment default restored');
  assert.equal(fs.existsSync(path.join(dir, 'writer.lock')), false);
});
test('selection failure cools the first lane and uses backup before the only prompt', async t => {
  const { client, calls } = await host(t, { selectFail: true });
  const dir = temp(t);
  const result = await runOneTurn({ client, config: config(), stateDir: dir, prompt: 'synthetic', timeoutMs: 1000 });
  assert.equal(result.provider, 'trae');
  assert.equal(calls.filter(c => c.endpoint === 'session/prompt').length, 1);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'model-lanes.json'))).lanes['our-free-model/fixture-free']);
});
for (const mode of ['disconnect', 'tool', 'silent']) test(`${mode}: never replay an accepted or uncertain prompt; retain unknown evidence`, async t => {
  const { client, calls } = await host(t, { mode });
  const dir = temp(t);
  await assert.rejects(runOneTurn({ client, config: config(), stateDir: dir, prompt: 'synthetic', timeoutMs: 100 }));
  assert.equal(calls.filter(c => c.endpoint === 'session/prompt').length, 1);
  const files = fs.readdirSync(dir).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, files[0])));
  assert.equal(saved.status, 'unknown');
  assert.equal(saved.hadToolCall, mode === 'tool');
  assert.equal(createInferenceAudit({ file: path.join(dir, 'audit.jsonl') }).snapshot().byTask.chat.unknown, 1);
});
test('missing follow baseline never submits a prompt', async t => {
  const { client, calls } = await host(t, { noSnapshot: true });
  await assert.rejects(runOneTurn({ client, config: config(), stateDir: temp(t), prompt: 'synthetic', timeoutMs: 1000 }), { code: 'FOLLOW_TIMEOUT' });
  assert.equal(calls.filter(c => c.endpoint === 'session/prompt').length, 0);
});
test('a second writer cannot corrupt state while a task is running', t => {
  const dir = temp(t);
  const unlock = acquireStateLock(dir);
  assert.throws(() => acquireStateLock(dir), { code: 'STATE_BUSY' });
  unlock();
  acquireStateLock(dir)();
});
test('startup failure releases the writer lock and preserves a corrupt audit file', async t => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'audit.jsonl'), 'damaged');
  await assert.rejects(runOneTurn({ client: {}, config: config(), stateDir: dir, prompt: 'synthetic' }));
  assert.equal(fs.existsSync(path.join(dir, 'writer.lock')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8'), 'damaged');
});
test('native plugin registers a useful command; doctor/setup never invoke inference', async t => {
  let definition;
  const calls = [];
  const file = path.join(temp(t), 'native-config.json');
  const ctx = { commands: { register: d => { definition = d; } }, sessionController: {
    modelCatalog: async () => ({ ...catalog, groups: [{ id: 'our-free-model', models: [{ id: 'deepseek-fixture-free', reasoning: { efforts: [{ id: 'high' }] } }] }] }),
    selectModel: async route => { calls.push(route); return { selected: route }; }
  }, on() {}, inject() {}, get() {} };
  apply(ctx, { configFile: file, ofmControl: async () => ({ enabled: true }) });
  assert.equal(definition.name, 'bfy-ofm');
  const invoke = rawInput => definition.handler({ agent: { id: 'invoking-session' }, rawInput, signal: new AbortController().signal });
  assert.equal((await invoke('doctor')).kind, 'success');
  assert.equal((await invoke('onboard')).kind, 'success');
  assert.equal(calls.length, 1);
  assert.equal((await invoke('chat')).kind, 'success');
  assert.equal(calls[0].sessionId, 'invoking-session');
  assert.equal(calls[0].provider, 'our-free-model');
});
