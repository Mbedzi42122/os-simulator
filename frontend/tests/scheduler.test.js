import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulationEngine } from '../js/simulation/SimulationEngine.js';
import { ProcessManager } from '../js/process/ProcessManager.js';
import { Scheduler } from '../js/cpu/Scheduler.js';

function setup(cfg = {}) {
  const e = new SimulationEngine(cfg);
  const pm = e.registerModule(new ProcessManager(e));
  const s = e.registerModule(new Scheduler(e, pm));
  return { e, pm, s };
}
const add = (pm, bursts, { pri = [], arr = [] } = {}) =>
  bursts.map((b, i) => pm.create({ name: 'p' + (i + 1), burstTime: b, priority: pri[i] ?? 5, memoryRequired: 10, arrivalTime: arr[i] ?? 0 }));
const runAll = (e, pm, max = 300) => { for (let i = 0; i < max && pm.list.some((p) => p.state !== 'TERMINATED'); i++) e.step(); };
const wait = (pm) => pm.list.map((p) => p.waitingTime);

test('FCFS', () => {
  const { e, pm, s } = setup();
  add(pm, [5, 3, 1]); runAll(e, pm);
  assert.deepEqual(pm.list.map((p) => p.completionTime), [5, 8, 9]);
  assert.deepEqual(wait(pm), [0, 5, 8]);
  assert.equal(s.stats().avgWaiting, 4.33);
  assert.equal(s.stats().cpuUtilisation, 100);
});

test('SJF picks shortest burst first', () => {
  const { e, pm, s } = setup({ schedulingAlgorithm: 'SJF' });
  add(pm, [6, 8, 7, 3]); runAll(e, pm);
  assert.deepEqual(wait(pm), [3, 16, 9, 0]);
  assert.equal(s.stats().avgWaiting, 7);
});

test('Priority: lower number runs first', () => {
  const { e, pm, s } = setup({ schedulingAlgorithm: 'PRIORITY' });
  add(pm, [10, 1, 2, 1, 5], { pri: [3, 1, 4, 5, 2] }); runAll(e, pm);
  assert.deepEqual(wait(pm), [6, 0, 16, 18, 1]);
  assert.equal(s.stats().avgWaiting, 8.2);
});

test('Round Robin with quantum 4 and Gantt chart', () => {
  const { e, pm, s } = setup({ schedulingAlgorithm: 'RR', timeQuantum: 4 });
  add(pm, [24, 3, 3]); runAll(e, pm);
  assert.deepEqual(wait(pm), [6, 4, 7]);
  assert.deepEqual(e.state.gantt.map((g) => [g.pid, g.start, g.end]),
    [['P001', 0, 4], ['P002', 4, 7], ['P003', 7, 10], ['P001', 10, 30]]);
  assert.equal(s.stats().avgWaiting, 5.67);
});

test('idle gap before a late arrival', () => {
  const { e, pm, s } = setup();
  add(pm, [2], { arr: [3] }); runAll(e, pm);
  assert.deepEqual(e.state.gantt.map((g) => [g.pid, g.start, g.end]), [[null, 0, 3], ['P001', 3, 5]]);
  assert.equal(s.stats().cpuUtilisation, 40);
  assert.equal(pm.list[0].waitingTime, 0);
});

test('uniprocessor: only one process runs at a time', () => {
  const { e, pm } = setup();
  add(pm, [4, 4]); e.step();
  assert.equal(pm.list.filter((p) => p.state === 'RUNNING').length, 1);
  runAll(e, pm);
  assert.equal(e.state.clock, 8);
  assert.equal(e.state.cpu.id, 0);
  assert.equal('cpus' in e.state, false);
});

test('config validation', () => {
  const { s } = setup();
  assert.throws(() => s.configure({ schedulingAlgorithm: 'NOPE' }));
  assert.throws(() => s.configure({ timeQuantum: 0 }));
});

test('terminating a running process frees the CPU', () => {
  const { e, pm } = setup();
  const [p] = add(pm, [10]);
  e.step();
  assert.equal(e.state.cpu.current, p.pid);
  pm.terminate(p.pid);
  e.step();
  assert.equal(e.state.cpu.current, null);
  assert.equal(e.state.cpu.state, 'IDLE');
});

test('reset clears scheduler state', () => {
  const { e, pm } = setup();
  add(pm, [5, 5]); e.step(); e.reset();
  assert.equal(e.state.cpu.busyTime, 0);
  assert.equal(e.state.cpu.current, null);
  assert.deepEqual(e.state.readyQueue, []);
  assert.deepEqual(e.state.gantt, []);
});

test('SJF is preemptive (SRTF): a shorter arrival takes the CPU', () => {
  const { e, pm, s } = setup({ schedulingAlgorithm: 'SJF' });
  add(pm, [8, 4, 9, 5], { arr: [0, 1, 2, 3] }); runAll(e, pm);
  assert.deepEqual(e.state.gantt.map((g) => [g.pid, g.start, g.end]),
    [['P001', 0, 1], ['P002', 1, 5], ['P004', 5, 10], ['P001', 10, 17], ['P003', 17, 26]]);
  assert.deepEqual(pm.list.map((p) => p.completionTime), [17, 5, 26, 10]);
  assert.deepEqual(wait(pm), [9, 0, 15, 2]);
  assert.equal(s.stats().avgWaiting, 6.5);
});

test('SJF does not preempt on a tie in remaining time', () => {
  const { e, pm } = setup({ schedulingAlgorithm: 'SJF' });
  add(pm, [4, 3], { arr: [0, 1] }); runAll(e, pm);
  assert.deepEqual(e.state.gantt.map((g) => [g.pid, g.start, g.end]), [['P001', 0, 4], ['P002', 4, 7]]);
});

test('Priority is preemptive: a higher-priority arrival takes the CPU', () => {
  const { e, pm, s } = setup({ schedulingAlgorithm: 'PRIORITY' });
  add(pm, [6, 3, 4], { pri: [3, 1, 2], arr: [0, 2, 3] }); runAll(e, pm);
  assert.deepEqual(e.state.gantt.map((g) => [g.pid, g.start, g.end]),
    [['P001', 0, 2], ['P002', 2, 5], ['P003', 5, 9], ['P001', 9, 13]]);
  assert.deepEqual(wait(pm), [7, 0, 2]);
  assert.ok(e.state.events.some((ev) => ev.type === 'CPU_PREEMPT' && /P001 preempted by P002/.test(ev.message)));
});

test('Priority does not preempt for an equal priority', () => {
  const { e, pm } = setup({ schedulingAlgorithm: 'PRIORITY' });
  add(pm, [4, 2], { pri: [2, 2], arr: [0, 1] }); runAll(e, pm);
  assert.deepEqual(e.state.gantt.map((g) => [g.pid, g.start, g.end]), [['P001', 0, 4], ['P002', 4, 6]]);
});
