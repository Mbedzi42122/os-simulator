import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulationEngine } from '../js/simulation/SimulationEngine.js';
import { SimulationClock } from '../js/simulation/SimulationClock.js';

test('step advances exactly one tick', () => {
  const e = new SimulationEngine();
  e.step();
  assert.equal(e.state.clock, 1);
  e.step();
  assert.equal(e.state.clock, 2);
});

test('start/pause/resume control the clock', async () => {
  const e = new SimulationEngine();
  e.setSpeed(10);
  e.start();
  await new Promise((r) => setTimeout(r, 350));
  e.pause();
  const t = e.state.clock;
  assert.ok(t >= 2, `expected clock to advance, got ${t}`);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(e.state.clock, t);
  assert.equal(e.step(), true);
});

test('step is refused while running', () => {
  const e = new SimulationEngine();
  e.start();
  assert.equal(e.step(), false);
  e.pause();
});

test('reset restores initial state and keeps shared reference', () => {
  const e = new SimulationEngine();
  const ref = e.state;
  e.step(); e.step();
  e.reset();
  assert.equal(e.state, ref);
  assert.equal(e.state.clock, 0);
  assert.equal(e.state.status, 'STOPPED');
  assert.equal(e.state.events.length, 1); // only SIMULATION_RESET
});

test('invalid speed rejected', () => {
  assert.throws(() => new SimulationEngine().setSpeed(3));
});

test('modules receive ticks and events are pub/sub', () => {
  const e = new SimulationEngine();
  let ticks = 0, seen = 0;
  e.registerModule({ onTick: () => ticks++ });
  e.bus.on('TICK', () => seen++);
  e.step(); e.step();
  assert.equal(ticks, 2); assert.equal(seen, 2);
});

test('clock formatting', () => assert.equal(SimulationClock.format(84), '00:01:24'));
