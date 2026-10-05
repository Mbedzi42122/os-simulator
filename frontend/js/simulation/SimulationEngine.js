import { EventBus } from './EventBus.js';
import { SimulationClock } from './SimulationClock.js';
import { createInitialState, SPEEDS } from './SimulationState.js';

/**
 * Central engine. Modules register as { name, onTick(state, engine), onReset(state, engine) }
 * and are updated in registration order on every tick.
 */
export class SimulationEngine {
  constructor(config = {}) {
    this.bus = new EventBus();
    this.state = createInitialState(config);
    this.clock = new SimulationClock(this.state);
    this.modules = [];
    this.timer = null;
    // Record every event into the shared log.
    this.bus.on('*', (e) => {
      if (e.type === 'TICK' || e.type === 'STATE_CHANGED') return;
      this.state.events.push({ time: this.state.clock, type: e.type, message: e.message || e.type });
    });
  }

  registerModule(mod) { this.modules.push(mod); return mod; }
  log(type, message, extra = {}) { return this.bus.emit(type, { message, ...extra }); }
  get running() { return this.state.status === 'RUNNING'; }

  start() {
    if (this.state.status !== 'STOPPED') return this.resume();
    this.state.status = 'RUNNING';
    this.log('SIMULATION_STARTED', 'Simulation started');
    this._schedule();
    this._changed();
  }
  pause() {
    if (!this.running) return;
    this._unschedule();
    this.state.status = 'PAUSED';
    this.log('SIMULATION_PAUSED', 'Simulation paused');
    this._changed();
  }
  resume() {
    if (this.state.status !== 'PAUSED') return;
    this.state.status = 'RUNNING';
    this.log('SIMULATION_RESUMED', 'Simulation resumed');
    this._schedule();
    this._changed();
  }
  /** Advance exactly one tick (only while not running automatically). */
  step() {
    if (this.running) return false;
    if (this.state.status === 'STOPPED') this.state.status = 'PAUSED';
    this.tick();
    return true;
  }
  tick() {
    this.clock.advance(1);
    for (const m of this.modules) m.onTick?.(this.state, this);
    this.bus.emit('TICK', { time: this.state.clock });
    this._changed();
  }
  setSpeed(speed) {
    if (!SPEEDS.includes(speed)) throw new Error(`Invalid speed ${speed}. Allowed: ${SPEEDS.join(', ')}`);
    this.state.speed = speed;
    if (this.running) { this._unschedule(); this._schedule(); }
    this._changed();
  }
  reset() {
    this._unschedule();
    const speed = this.state.speed;
    // Mutate in place so every module keeps its reference to the same state object.
    const fresh = createInitialState({ ...this.state.config });
    for (const k of Object.keys(this.state)) delete this.state[k];
    Object.assign(this.state, fresh, { speed });
    for (const m of this.modules) m.onReset?.(this.state, this);
    this.bus.emit('SIMULATION_RESET', { message: 'Simulation reset' });
    this._changed();
  }
  updateConfig(patch) {
    Object.assign(this.state.config, patch);
    this.bus.emit('CONFIG_CHANGED', { message: 'Configuration updated', patch });
    this._changed();
  }

  /** Temporarily stop the timer without changing the status (the visualisation uses it to let an animation finish). */
  holdClock() { if (this.running) this._unschedule(); }
  /** Undo holdClock(); does nothing if the simulation was paused/reset or restarted meanwhile. */
  releaseClock() { if (this.running && !this.timer) this._schedule(); }

  _schedule() { this.timer = setInterval(() => this.tick(), 1000 / this.state.speed); }
  _unschedule() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  _changed() { this.bus.emit('STATE_CHANGED'); }
}
