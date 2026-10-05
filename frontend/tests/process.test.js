import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulationEngine } from '../js/simulation/SimulationEngine.js';
import { ProcessManager } from '../js/process/ProcessManager.js';
import { ValidationError, InvalidTransitionError } from '../js/process/Process.js';

const setup = () => { const e = new SimulationEngine(); const pm = new ProcessManager(e); e.registerModule(pm); return { e, pm }; };
const ok = { name: 'init', burstTime: 5, priority: 2, memoryRequired: 100, arrivalTime: 0 };

test('creates processes with sequential PIDs', () => {
  const { pm } = setup();
  assert.equal(pm.create(ok).pid, 'P001');
  assert.equal(pm.create(ok).pid, 'P002');
  assert.equal(pm.list[0].remainingTime, 5);
  assert.equal(pm.list[0].state, 'NEW');
});

test('validation rejects bad input', () => {
  const { pm } = setup();
  for (const bad of [{ ...ok, name: '' }, { ...ok, burstTime: 0 }, { ...ok, priority: 99 },
    { ...ok, memoryRequired: -1 }, { ...ok, memoryRequired: 999999 }, { ...ok, arrivalTime: -2 }, { ...ok, burstTime: '' }])
    assert.throws(() => pm.create(bad), ValidationError);
  assert.equal(pm.list.length, 0);
});

test('valid and invalid state transitions', () => {
  const { pm } = setup();
  const p = pm.create(ok);
  assert.throws(() => pm.transition(p.pid, 'RUNNING'), InvalidTransitionError);
  pm.transition(p.pid, 'READY'); pm.transition(p.pid, 'RUNNING');
  pm.transition(p.pid, 'WAITING'); pm.transition(p.pid, 'READY');
  pm.transition(p.pid, 'RUNNING'); pm.terminate(p.pid);
  assert.equal(p.state, 'TERMINATED');
  assert.throws(() => pm.transition(p.pid, 'READY'), InvalidTransitionError);
});

test('termination records time; removal rules', () => {
  const { e, pm } = setup();
  const p = pm.create(ok);
  pm.transition(p.pid, 'READY');
  assert.throws(() => pm.remove(p.pid));
  e.step(); e.step();
  pm.terminate(p.pid);
  assert.equal(p.terminationTime, 2);
  pm.remove(p.pid);
  assert.equal(pm.list.length, 0);
});

test('arrival-time admission on tick', () => {
  const { e, pm } = setup();
  const p = pm.create({ ...ok, arrivalTime: 2 });
  e.step(); e.step(); assert.equal(p.state, 'NEW');
  e.step(); assert.equal(p.state, 'READY');
});

test('search, counts, and reset', () => {
  const { e, pm } = setup();
  pm.create({ ...ok, name: 'browser' }); pm.create({ ...ok, name: 'editor' });
  assert.equal(pm.search('brow').length, 1);
  assert.equal(pm.counts().total, 2);
  e.reset();
  assert.equal(pm.list.length, 0);
  assert.equal(pm.create(ok).pid, 'P001');
});
