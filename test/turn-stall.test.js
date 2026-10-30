import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TURN_STALL_MS, SUBSTANTIVE_EVENTS, createTurnStallGuard } from '../src/turn-stall-guard.js';

const SESSION = 'session-fixture';

/** 假时钟：记录挂起的定时器，由测试决定什么时候"到点"。 */
function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    /** 到期全部回调（模拟"到点了还没输出"）。 */
    runDue() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, task] of due) task.fn();
      return due.length;
    },
    scheduled() {
      return [...pending.values()].map((task) => task.ms);
    }
  };
}

function harness({ stallMs = DEFAULT_TURN_STALL_MS, onStall, log } = {}) {
  const timers = fakeTimers();
  const events = [];
  const stalls = [];
  const guard = createTurnStallGuard({
    stallMs,
    timers,
    log: log ?? ((message) => events.push(message)),
    onStall: onStall ?? ((sessionId, info) => stalls.push({ sessionId, ...info }))
  });
  return { guard, timers, events, stalls };
}

const turnStart = (turn = 1) => ({ type: 'turn/start', data: { turn } });
const turnEnd = (turn = 1) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });

test('静默到点：零输出的回合被开火一次，并带上回合号', () => {
  const { guard, timers, stalls } = harness();
  assert.equal(guard.enabled, true);
  assert.equal(guard.limit, DEFAULT_TURN_STALL_MS);
  guard.observe(SESSION, turnStart(3));
  assert.deepEqual(timers.scheduled(), [DEFAULT_TURN_STALL_MS], '定时器必须按上限挂上');
  assert.equal(timers.runDue(), 1, '到点应触发一次');
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].sessionId, SESSION);
  assert.equal(stalls[0].turnId, 3, '回调要能知道是哪一代回合，处置侧才不会掐错');
  assert.ok(stalls[0].waitedMs >= 0);
  // 开火后自己解除武装：同一回合不能反复判死（否则每次都凉一次车道、发一条道歉）
  assert.deepEqual(guard.snapshot(), {});
  assert.equal(timers.runDue(), 0, '不会留下第二次到期');
  assert.equal(stalls.length, 1);
});

test('有效输出刷新模型阶段等待，但不永久豁免后续卡死', () => {
  for (const type of SUBSTANTIVE_EVENTS) {
    const {guard,timers,stalls}=harness();
    guard.observe(SESSION,turnStart(1));
    guard.observe(SESSION,{type,data:{turn:1,text:'正在回答'}});
    assert.equal(timers.scheduled().length,1,'有效输出之后仍保留阶段看门狗');
    assert.equal(timers.runDue(),1);
    assert.equal(stalls.length,1);
  }
});

test('长工具执行暂停模型计时，全部工具返回后重新计时',()=>{
  const {guard,timers,stalls}=harness();
  guard.observe(SESSION,turnStart(1));
  guard.observe(SESSION,{type:'tool/call',data:{turn:1,callId:'a',name:'qq_wait_for_messages'}});
  guard.observe(SESSION,{type:'tool/call',data:{turn:1,callId:'b'}});
  assert.equal(timers.runDue(),0);
  guard.observe(SESSION,{type:'tool/result',data:{turn:1,callId:'a'}});
  assert.equal(timers.runDue(),0);
  guard.observe(SESSION,{type:'tool/result',data:{turn:1,callId:'b'}});
  assert.equal(timers.runDue(),1);
  assert.equal(stalls[0][1]?.hadToolCall??stalls[0].hadToolCall,true);
});

test('重试类事件不算输出：挂死的车道正是靠重试把时间耗掉的', () => {
  for (const type of ['assistant/attempt', 'llm/retry-started', 'system/message', 'request/header', 'request/context', 'session/title', 'step/start']) {
    const { guard, timers, stalls } = harness({ stallMs: 1000 });
    guard.observe(SESSION, turnStart(1));
    guard.observe(SESSION, { type, data: {} });
    assert.equal(timers.runDue(), 1, `${type} 不能当心跳`);
    assert.equal(stalls.length, 1, `${type} 之后仍要判死`);
  }
});

test('回合正常结束就撤销：跑完的回合不能被事后判死', () => {
  const { guard, timers, stalls } = harness();
  guard.observe(SESSION, turnStart(1));
  guard.observe(SESSION, turnEnd(1));
  assert.deepEqual(guard.snapshot(), {});
  assert.equal(timers.runDue(), 0);
  assert.equal(stalls.length, 0);
});

test('请求提交后没有 turn/start 也会被监测，不能静默等到旧总时限',()=>{
  const {guard,timers,stalls}=harness();guard.expect(SESSION);guard.expect(SESSION);
  assert.equal(timers.scheduled().length,1);timers.runDue();assert.equal(stalls.length,1);
  assert.equal(stalls[0].hadToolCall,false);
});

test('新一代回合重新计时；同一代重复 turn/start 不漂移', () => {
  const { guard, timers } = harness({ stallMs: 5000 });
  guard.observe(SESSION, turnStart(1));
  guard.observe(SESSION, turnStart(1));
  assert.deepEqual(timers.scheduled(), [5000], '同一代 turn/start（重连补发/快照重复）不该叠加定时器');
  guard.observe(SESSION, turnStart(2));
  assert.deepEqual(timers.scheduled(), [5000], '新一代回合仍然只有一个定时器');
  assert.equal(guard.snapshot()[SESSION].turnId, 2);
});

test('工具等待期间同代 turn/start 不会重新启动模型计时', () => {
  const { guard, timers, stalls } = harness({ stallMs: 2000 });
  guard.observe(SESSION, turnStart(7));
  guard.observe(SESSION, { type: 'tool/call', data: { name: 'qq_wait_for_messages' } });
  guard.observe(SESSION, turnStart(7));
  assert.equal(timers.runDue(), 0, '长工具调用期间的重复 turn/start 不能把它判死');
  assert.equal(stalls.length, 0);
});

test('多会话互不干扰；forget/clearAll 清掉悬挂定时器', () => {
  const { guard, timers, stalls } = harness({ stallMs: 1000 });
  guard.observe('session-a', turnStart(1));
  guard.observe('session-b', turnStart(1));
  assert.deepEqual(Object.keys(guard.snapshot()).sort(), ['session-a', 'session-b']);
  guard.forget('session-a');
  assert.deepEqual(guard.snapshot(), { 'session-b': guard.snapshot()['session-b'] });
  assert.equal(timers.runDue(), 1, '只有还挂着的会话开火');
  assert.deepEqual(stalls.map((s) => s.sessionId), ['session-b']);
  guard.observe('session-c', turnStart(1));
  guard.clearAll();
  assert.deepEqual(guard.snapshot(), {});
  assert.equal(timers.runDue(), 0, 'clearAll 之后不留定时器');
});

test('stallMs<=0 关闭看门狗（保留旧的"等上游报错"行为）；配置没给则用默认上限', () => {
  const off = harness({ stallMs: 0 });
  off.guard.observe(SESSION, turnStart(1));
  assert.equal(off.guard.enabled, false);
  assert.deepEqual(off.timers.scheduled(), []);
  assert.equal(off.timers.runDue(), 0);
  assert.equal(off.stalls.length, 0);

  const nonsense = createTurnStallGuard({ stallMs: NaN, timers: fakeTimers(), onStall: () => {} });
  assert.equal(nonsense.enabled, false, 'NaN 不该武装出一个永不合法的定时器');

  const unset = createTurnStallGuard({ timers: fakeTimers(), onStall: () => {} });
  assert.equal(unset.limit, DEFAULT_TURN_STALL_MS, '不传就用默认上限');
  assert.equal(unset.enabled, true);
});

test('处置回调炸了也不影响看门狗本身（异步 reject 也不能变成 unhandled）', async () => {
  const messages = [];
  const sync = harness({
    stallMs: 500,
    log: (m) => messages.push(m),
    onStall: () => { throw new Error('fixture 同步炸'); }
  });
  sync.guard.observe(SESSION, turnStart(1));
  sync.timers.runDue();
  assert.equal(messages.length, 1, '异常要落到日志，不能静默吞掉');
  assert.deepEqual(sync.guard.snapshot(), {}, '开火后仍然解除武装');

  const asyncHarness = harness({
    stallMs: 500,
    log: (m) => messages.push(m),
    onStall: () => Promise.reject(new Error('fixture 异步炸'))
  });
  asyncHarness.guard.observe(SESSION, turnStart(1));
  asyncHarness.timers.runDue();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(messages.some((m) => /静默处置失败/.test(m)), JSON.stringify(messages));
});

test('没有 sessionId 的事件不参与记账（事件流中混着全局快照）', () => {
  const { guard, timers } = harness({ stallMs: 1000 });
  guard.observe(undefined, turnStart(1));
  guard.observe('', turnStart(1));
  assert.deepEqual(timers.scheduled(), []);
  assert.deepEqual(guard.snapshot(), {});
});

test('current and legacy nested tool-result identities rearm the model timer', () => {
  for (const data of [{ toolCallId: 'a' }, { message: { toolCallId: 'a' } }, { message: { source: { callId: 'a' } } }]) {
    const { guard, timers } = harness();
    guard.observe(SESSION, turnStart(1));
    guard.observe(SESSION, { type: 'tool/call', data: { turn: 1, callId: 'a' } });
    guard.observe(SESSION, { type: 'tool/result', data: { turn: 1, ...data } });
    assert.equal(guard.snapshot()[SESSION].phase, 'model');
    assert.equal(timers.scheduled().length, 1);
  }
});
