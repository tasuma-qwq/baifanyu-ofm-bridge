import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ALLOWED_PROVIDERS,
  DEFAULT_LANE_CHAIN,
  FORBIDDEN_PROVIDERS,
  classifyLaneFailure,
  createLaneLedger,
  laneEffortVocab,
  laneKey,
  lanePresent,
  pickLane,
  readLaneCooldowns,
  resolveLaneChain,
  resolveLaneEffort
} from '../src/model-lanes.js';

test('今日额度用完只走 TRAE；到期恢复 CN 优先，正常顺序不永久改写', () => {
  const until='2026-10-28T00:00:00+08:00';
  const dsh={laneHolds:{
    'qodercn/dfmodel':{until,reason:'今日免费额度已用尽'},
    'qodercn/qfmodel':{until,reason:'今日仅由 TRAE 承接'}
  }};
  const today=resolveLaneChain(dsh,Date.parse('2026-10-27T23:59:59+08:00'));
  assert.deepEqual(today.map(laneKey),['trae/deepseek-v4.1-flash']);
  const tomorrow=resolveLaneChain(dsh,Date.parse(until));
  assert.deepEqual(tomorrow.map(laneKey),DEFAULT_LANE_CHAIN.map(laneKey));
  assert.equal(dsh.laneHolds['qodercn/dfmodel'].until,until);
});

test('所有候选暂时停用时不给默认链绕过；允许集仍然生效', () => {
  const until='2026-10-28T00:00:00+08:00';
  const now=Date.parse('2026-10-27T22:00:00+08:00');
  const laneHolds=Object.fromEntries(DEFAULT_LANE_CHAIN.map(l=>[laneKey(l),{until}]));
  assert.deepEqual(resolveLaneChain({laneHolds},now),[]);
  assert.deepEqual(resolveLaneChain({allowedProviders:['qodercn'],laneHolds},now),[]);
});

const catalog = {
  groups: [
    { id: 'deepseek-official', models: [{ id: 'deepseek-flash' }] },
    { id: 'deepseek-account', models: [{ id: 'deepseek-flash' }] },
    {
      id: 'qoder',
      models: [
        { id: 'qfmodel', reasoning: { efforts: [{ id: 'none' }, { id: 'low' }, { id: 'medium' }, { id: 'xhigh' }], defaultEffort: 'medium' } },
        { id: 'dfmodel', reasoning: { efforts: [{ id: 'none' }, { id: 'low' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'max' } }
      ]
    },
    {
      id: 'qodercn',
      models: [
        { id: 'qfmodel', reasoning: { efforts: [{ id: 'none' }, { id: 'low' }, { id: 'medium' }, { id: 'xhigh' }], defaultEffort: 'medium' } },
        { id: 'dfmodel', reasoning: { efforts: [{ id: 'none' }, { id: 'low' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'max' } }
      ]
    },
    {
      id: 'trae',
      models: [
        { id: 'deepseek-v4.1-flash', reasoning: { efforts: [{ id: 'light' }, { id: 'high' }, { id: 'extra_high' }], defaultEffort: 'high' } }
      ]
    },
    { id: 'our-free-model', models: [{ id: 'deepseek-v4.1-flash-free' }] }
  ]
};

function tempFile(t, name = 'model-lanes.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfy-lanes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

test('官方 API 与官方账号车道在代码级禁用，改 config 也拉不回来', (t) => {
  const chain = resolveLaneChain({ provider: 'deepseek-official', model: 'deepseek-flash' });
  assert.ok(chain.length > 0, '车道链不允许为空');
  for (const lane of chain) assert.ok(!FORBIDDEN_PROVIDERS.includes(lane.provider), `混入了禁用车道 ${laneKey(lane)}`);
  assert.equal(laneKey(chain[0]), 'qodercn/dfmodel', '默认车道是 Qoder CN 的 DeepSeek-Flash');
  const explicit = resolveLaneChain({ laneChain: [{ provider: 'deepseek-account', model: 'deepseek-flash' }, { provider: 'trae', model: 'deepseek-v4.1-flash' }] });
  assert.equal(laneKey(explicit[0]), 'trae/deepseek-v4.1-flash');
  assert.ok(!explicit.some((l) => l.provider === 'deepseek-account'));
});

test('默认只允许 qodercn / trae：国际版 Qoder 与免费车道都不进链', () => {
  const chain = resolveLaneChain({ laneChain: [{ provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' }] });
  assert.ok(!chain.some((l) => l.provider === 'our-free-model'), JSON.stringify(chain.map(laneKey)));
  assert.ok(!chain.some((l) => l.provider === 'qoder'), `${JSON.stringify(chain.map(laneKey))}：默认不选择该渠道`);
  assert.deepEqual(Array.from(DEFAULT_ALLOWED_PROVIDERS), ['qodercn', 'trae']);
  const narrowed = resolveLaneChain({ allowedProviders: ['trae'] });
  assert.deepEqual(narrowed.map(laneKey), ['trae/deepseek-v4.1-flash']);
});

test('国际版是「默认不用」而不是硬禁：显式允许 + 显式配置就能捡回来', () => {
  const configured = { laneChain: [{ provider: 'qoder', model: 'dfmodel' }] };
  assert.deepEqual(resolveLaneChain(configured).map(laneKey), [
    'qodercn/dfmodel',
    'trae/deepseek-v4.1-flash'
  ], JSON.stringify(resolveLaneChain(configured).map(laneKey)));
  const back = resolveLaneChain({ ...configured, allowedProviders: ['qoder', 'qodercn', 'trae'] });
  assert.deepEqual(back.map(laneKey), ['qoder/dfmodel', 'qodercn/dfmodel', 'trae/deepseek-v4.1-flash']);
  const official = resolveLaneChain({ laneChain: [{ provider: 'deepseek-official', model: 'deepseek-flash' }], allowedProviders: ['deepseek-official', 'qodercn'] });
  assert.ok(!official.some((lane) => FORBIDDEN_PROVIDERS.includes(lane.provider)), JSON.stringify(official.map(laneKey)));
});

test('渠道包把模型关掉后（目录里查不到）自动跳到下一条车道', () => {
  const pruned = { groups: [{ id: 'trae', models: [{ id: 'deepseek-v4.1-flash' }] }] };
  assert.equal(lanePresent(catalog, 'qodercn', 'dfmodel'), true);
  assert.equal(lanePresent(pruned, 'qodercn', 'dfmodel'), false);
  assert.equal(lanePresent(pruned, 'gemini', 'whatever'), false);
  const { lane, skipped } = pickLane({ chain: resolveLaneChain({}), catalog: pruned });
  assert.equal(lanePresent(pruned, lane.provider, lane.model), true, '选中的车道必须在目录里');
  assert.ok(skipped.some((s) => s.lane === 'qodercn/dfmodel'), JSON.stringify(skipped));
  assert.ok(!skipped.some((s) => s.lane === 'trae/deepseek-v4.1-flash'), JSON.stringify(skipped));
  assert.equal(laneKey(lane), 'trae/deepseek-v4.1-flash');
  assert.equal(laneKey(pickLane({ chain: resolveLaneChain({}), catalog: null }).lane), 'qodercn/dfmodel');
});

test('CN 超时 → 落 TRAE 保底：冷却只凉当前车道，下一条顶上；全部凉了才判无车道', (t) => {
  const file = tempFile(t);
  const ledger = createLaneLedger({ file });
  let picked = pickLane({ chain: resolveLaneChain({}), catalog, ledger });
  assert.equal(laneKey(picked.lane), 'qodercn/dfmodel', '默认车道是 Qoder CN');
  ledger.cool('qodercn/dfmodel', { kind: 'stall', reason: '回合静默 240s 零输出', ms: 10 * 60000 });
  picked = pickLane({ chain: resolveLaneChain({}), catalog, ledger });
  assert.equal(laneKey(picked.lane), 'trae/deepseek-v4.1-flash', 'CN 冷却后选择备用渠道');
  assert.ok(picked.skipped.some((s) => /qodercn\/dfmodel/.test(s.lane)), JSON.stringify(picked.skipped));
  ledger.cool('trae/deepseek-v4.1-flash', classifyLaneFailure({ status: 402, message: 'Insufficient Balance' }));
  picked = pickLane({ chain: resolveLaneChain({}), catalog, ledger });
  assert.equal(picked.lane, null, '两条额度都不可用时保留任务，不隐式增加别的计费模型');
  const seen = readLaneCooldowns(file);
  assert.deepEqual(Object.keys(seen).sort(), ['qodercn/dfmodel', 'trae/deepseek-v4.1-flash'], JSON.stringify(seen));
  ledger.cool('qodercn/qfmodel', { kind: 'transport', ms: 10 * 60000 });
  assert.equal(pickLane({ chain: resolveLaneChain({}), catalog, ledger }).lane, null, '全凉时必须明确给出"无车道"');
  ledger.clear();
  assert.equal(laneKey(pickLane({ chain: resolveLaneChain({}), catalog, ledger }).lane), 'qodercn/dfmodel', '手动解除后回到链首');
});

test('冷却持久化：进程重启不会把凉掉的车道又当成可用的', (t) => {
  const file = tempFile(t);
  const first = createLaneLedger({ file });
  first.cool('qodercn/dfmodel', { kind: 'auth', reason: '401', ms: 30 * 60000 });
  const restored = createLaneLedger({ file });
  assert.ok(restored.isCooling('qodercn/dfmodel'), '冷却必须跨进程生效');
  assert.equal(laneKey(pickLane({ chain: resolveLaneChain({}), catalog, ledger: restored }).lane), 'trae/deepseek-v4.1-flash');
  const expired = createLaneLedger({ file, now: () => Date.now() + 31 * 60000 });
  assert.ok(!expired.isCooling('qodercn/dfmodel'), '冷却到期必须放行');
});

test('冷却文件损坏时保留原件并继续退避（不静默清库）', (t) => {
  const file = tempFile(t);
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  const messages = [];
  const ledger = createLaneLedger({ file, log: (m) => messages.push(m) });
  assert.ok(messages.length > 0, '损坏必须告警');
  ledger.cool('qodercn/dfmodel', { kind: 'auth', ms: 60000 });
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json', '不得覆盖原件');
  assert.ok(ledger.isCooling('qodercn/dfmodel'), '本进程仍要退避');
});

test('失败分类：只有车道级原因才冷却，业务错误不牵连车道', () => {
  assert.equal(classifyLaneFailure({ status: 402, message: 'Insufficient Balance' }).kind, 'quota');
  assert.equal(classifyLaneFailure({ status: 401 }).kind, 'auth');
  assert.equal(classifyLaneFailure({ code: 'QUOTA_EXCEEDED' }).kind, 'quota');
  assert.equal(classifyLaneFailure({ message: 'request timed out' }).kind, 'transport');
  assert.equal(classifyLaneFailure({ status: 503 }).kind, 'transport');
  assert.equal(classifyLaneFailure({ message: 'unknown model zzz' }).kind, 'route');
  assert.equal(classifyLaneFailure({ message: 'session not found' }), null);
  assert.equal(classifyLaneFailure({ message: 'content policy violation' }), null);
});

test('默认链仅含 Qoder CN 免费模型与 TRAE 保底', () => {
  assert.deepEqual(DEFAULT_LANE_CHAIN.map(laneKey), [
    'qodercn/dfmodel',
    'trae/deepseek-v4.1-flash'
  ]);
});

test('强度代号按车道词表翻译：绝不把该车道不支持的值交给 selectModel', () => {
  const trae = { provider: 'trae', model: 'deepseek-v4.1-flash' };
  const df = { provider: 'qodercn', model: 'dfmodel' };
  const qf = { provider: 'qodercn', model: 'qfmodel' };
  assert.equal(resolveLaneEffort({ lane: trae, catalog, globalEffort: 'low' }), 'light');
  assert.equal(resolveLaneEffort({ lane: trae, catalog, globalEffort: 'high' }), 'high');
  assert.equal(resolveLaneEffort({ lane: trae, catalog, globalEffort: 'max' }), 'extra_high');
  assert.equal(resolveLaneEffort({ lane: df, catalog, globalEffort: 'low' }), 'low');
  assert.equal(resolveLaneEffort({ lane: df, catalog, globalEffort: 'max' }), 'max');
  assert.equal(resolveLaneEffort({ lane: qf, catalog, globalEffort: 'low' }), 'low');
  assert.equal(resolveLaneEffort({ lane: qf, catalog, globalEffort: 'high' }), 'medium', 'qfmodel 没有 high，取最接近的一档');
  assert.equal(resolveLaneEffort({ lane: qf, catalog, globalEffort: 'max' }), 'xhigh');
  for (const lane of [trae, df, qf]) {
    for (const global of ['low', 'high', 'max']) {
      const value = resolveLaneEffort({ lane, catalog, globalEffort: global });
      assert.ok(laneEffortVocab(catalog, lane.provider, lane.model).includes(value), `${laneKey(lane)} ← ${global} 得到非法值 ${value}`);
    }
  }
});

test('目录读不到时用内置词表兜底；链上显式钉档优先；钉了个非法值则退回翻译', () => {
  const trae = { provider: 'trae', model: 'deepseek-v4.1-flash' };
  assert.equal(resolveLaneEffort({ lane: trae, catalog: null, globalEffort: 'low' }), 'light', '无目录也要给合法值');
  assert.equal(resolveLaneEffort({ lane: { ...trae, reasoningEffort: 'extra_high' }, catalog, globalEffort: 'low' }), 'extra_high', '人工钉档优先');
  assert.equal(resolveLaneEffort({ lane: { ...trae, reasoningEffort: 'low' }, catalog, globalEffort: 'max' }), 'extra_high', '钉了车道不认的值不能原样送出去');
  assert.equal(resolveLaneEffort({ lane: { provider: 'qoder', model: 'brand-new-model' }, catalog, globalEffort: 'low' }), undefined);
  assert.equal(resolveLaneEffort({ lane: trae, catalog, globalEffort: '' }), undefined);
});

test('public-pool reasoning vocab maps disabled and balanced/deep without inventing effort ids', () => {
  const lane = { provider: 'our-free-model', model: 'public-fixture' };
  const directory = efforts => ({ groups: [{ id: lane.provider, models: [{ id: lane.model, reasoning: { efforts: efforts.map(id => ({ id })) } }] }] });
  assert.equal(resolveLaneEffort({ lane, catalog: directory(['disabled', 'low', 'high', 'max']), globalEffort: 'lowest' }), 'disabled');
  assert.equal(resolveLaneEffort({ lane, catalog: directory(['light', 'balanced', 'deep']), globalEffort: 'high' }), 'deep');
});
