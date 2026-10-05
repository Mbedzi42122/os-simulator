import { Process, STATES, TRANSITIONS, InvalidTransitionError, ValidationError } from './Process.js';

/** Priority convention: LOWER number = HIGHER priority (0 highest, 10 lowest). */
export const PRIORITY_RANGE = [0, 10];

export class ProcessManager {
  constructor(engine) {
    this.engine = engine;
    this.name = 'processes';
    this.admissionGate = null; // optional (process) => boolean; set by the virtual memory manager
    this.limitProvider = null; // optional () => KB: largest address space the backing store can hold
  }
  get state() { return this.engine.state; }
  get list() { return this.state.processes; }

  validate(input, memoryLimit = this.limitProvider ? this.limitProvider() : this.state.config.virtualMemorySize) {
    const e = [];
    const name = String(input.name ?? '').trim();
    const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
    const burst = num(input.burstTime), pri = num(input.priority);
    const mem = num(input.memoryRequired), arr = num(input.arrivalTime ?? 0);
    if (!name) e.push('Process name is required.');
    if (name.length > 30) e.push('Process name must be 30 characters or fewer.');
    if (!Number.isInteger(burst) || burst <= 0) e.push('Burst time must be a whole number greater than zero.');
    if (!Number.isInteger(pri) || pri < PRIORITY_RANGE[0] || pri > PRIORITY_RANGE[1])
      e.push(`Priority must be a whole number from ${PRIORITY_RANGE[0]} to ${PRIORITY_RANGE[1]}.`);
    if (!Number.isInteger(mem) || mem <= 0) e.push('Memory required must be a whole number (KB) greater than zero.');
    else if (mem > memoryLimit) e.push(`Memory required cannot exceed the virtual memory size (${memoryLimit} KB).`);
    if (!Number.isInteger(arr) || arr < 0) e.push('Arrival time cannot be negative.');
    if (input.parentPid && !this.get(input.parentPid)) e.push(`Parent ${input.parentPid} does not exist.`);
    if (e.length) throw new ValidationError(e);
    return { name, burstTime: burst, priority: pri, memoryRequired: mem, arrivalTime: arr, parentPid: input.parentPid || null };
  }

  create(input) {
    const v = this.validate(input);
    const n = this.state.nextPid++;
    const pid = 'P' + String(n).padStart(3, '0');
    const pages = Math.ceil(v.memoryRequired / this.state.config.pageSize); // the process is divided into pages
    const p = new Process({ pid, ...v, pages, seed: n * 7919 + 17, creationTime: this.state.clock });
    this.list.push(p);
    this.engine.log('PROCESS_CREATED', `${pid} (${p.name}) created`, { pid });
    return p;
  }

  get(pid) { return this.list.find((p) => p.pid === pid) || null; }

  search(q) {
    const s = String(q || '').trim().toLowerCase();
    if (!s) return [...this.list];
    return this.list.filter((p) => p.pid.toLowerCase().includes(s) || p.name.toLowerCase().includes(s) || p.state.toLowerCase() === s);
  }

  transition(pid, next) {
    const p = this.get(pid);
    if (!p) throw new Error(`Process ${pid} not found.`);
    if (!STATES.includes(next)) throw new InvalidTransitionError(`Unknown state ${next}.`);
    if (p.state === 'NEW' && next === 'READY' && this.admissionGate && !this.admissionGate(p))
      throw new Error(`${pid} cannot become READY yet: not enough virtual memory (backing store) for its ${p.pages} page(s).`);
    if (!p.canTransitionTo(next))
      throw new InvalidTransitionError(`Invalid transition for ${pid}: ${p.state} → ${next}. Allowed: ${TRANSITIONS[p.state].join(', ') || 'none'}.`);
    const prev = p.state;
    p.state = next;
    p.ioState = next === 'WAITING' ? 'WAITING_IO' : 'NONE';
    const t = this.state.clock;
    if (next === 'TERMINATED') { p.terminationTime = t; p.turnaroundTime = t - p.arrivalTime; }
    const evt = { READY: 'PROCESS_READY', RUNNING: 'PROCESS_STARTED', WAITING: 'PROCESS_BLOCKED',
      SUSPENDED: 'PROCESS_SUSPENDED', TERMINATED: 'PROCESS_TERMINATED' }[next];
    this.engine.log(evt, `${pid} ${prev} → ${next}`, { pid, from: prev, to: next });
    return p;
  }

  terminate(pid) { return this.transition(pid, 'TERMINATED'); }

  /** Remove a process from the table. Active processes must be terminated first. */
  remove(pid) {
    const p = this.get(pid);
    if (!p) throw new Error(`Process ${pid} not found.`);
    if (p.state !== 'TERMINATED' && p.state !== 'NEW')
      throw new Error(`${pid} is ${p.state}; terminate it before removing.`);
    this.state.processes = this.list.filter((x) => x.pid !== pid);
    this.engine.log('PROCESS_REMOVED', `${pid} removed`, { pid });
  }

  counts() {
    const c = Object.fromEntries(STATES.map((s) => [s, 0]));
    for (const p of this.list) c[p.state]++;
    return { total: this.list.length, ...c };
  }

  // Engine hooks ------------------------------------------------------------
  /** Tick N simulates slot [N-1, N]: admit NEW processes that have arrived by the start of that slot. */
  onTick(state) {
    for (const p of [...this.list]) {
      if (p.state === 'NEW' && p.arrivalTime <= state.clock - 1 && (!this.admissionGate || this.admissionGate(p))) this.transition(p.pid, 'READY');
    }
  }
}
