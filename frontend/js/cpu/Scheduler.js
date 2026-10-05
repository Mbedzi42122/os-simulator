import { CPU } from './CPU.js';

/**
 * Pluggable algorithms. select(queue, get) returns the PID to run next.
 * `queue` is the ready queue in arrival-into-READY order; ties go to the earliest entry.
 * Lower priority number = higher priority. SJF and Priority are NON-preemptive.
 */
const minBy = (queue, get, key) => {
  let best = null;
  for (const pid of queue) if (best === null || key(get(pid)) < key(get(best))) best = pid;
  return best;
};
export const ALGORITHMS = {
  FCFS: { label: 'First-Come, First-Served', usesQuantum: false, select: (q) => q[0] ?? null,
    description: 'Processes run in the order they became ready. Simple, but short jobs can wait behind long ones (convoy effect).' },
  SJF: { label: 'Shortest Job First (non-preemptive)', usesQuantum: false, select: (q, get) => minBy(q, get, (p) => p.remainingTime),
    description: 'The ready process with the smallest burst time runs next, to completion. Minimises average waiting time but can starve long jobs.' },
  PRIORITY: { label: 'Priority (non-preemptive)', usesQuantum: false, select: (q, get) => minBy(q, get, (p) => p.priority),
    description: 'The ready process with the highest priority runs next. Here a LOWER number means HIGHER priority. Low-priority jobs can starve.' },
  RR: { label: 'Round Robin', usesQuantum: true, select: (q) => q[0] ?? null,
    description: 'Each process gets at most one time quantum, then goes to the back of the queue. Fair and responsive; the quantum controls the trade-off with context switching.' },
};

/**
 * Uniprocessor scheduler (one CPU: state.cpu).
 * Time model: tick N simulates the slot [N-1, N]. Within a tick the scheduler
 * (0) wakes processes whose page fault has been served, (1) dispatches if the CPU is idle, (2) counts waiting,
 * (3) executes one unit (the instruction references a page; a page fault blocks the process instead),
 * (4) handles completion/preemption.
 * `vm` (VirtualMemory) is optional; without it processes run without paging.
 */
export class Scheduler {
  constructor(engine, pm, vm = null) {
    this.name = 'scheduler';
    this.engine = engine;
    this.pm = pm;
    this.vm = vm;
    engine.bus.on('PROCESS_READY', (e) => this._enqueue(e.pid));
    this.state.cpu = new CPU(0);
  }
  get state() { return this.engine.state; }
  get algorithm() { return ALGORITHMS[this.state.config.schedulingAlgorithm]; }

  configure(patch) {
    const errs = [];
    if ('schedulingAlgorithm' in patch && !ALGORITHMS[patch.schedulingAlgorithm]) errs.push('Unknown scheduling algorithm.');
    if ('timeQuantum' in patch && !(Number.isInteger(patch.timeQuantum) && patch.timeQuantum > 0)) errs.push('Time quantum must be a whole number greater than zero.');
    if (errs.length) throw new Error(errs.join(' '));
    this.engine.updateConfig(patch);
  }

  onReset() { this.state.cpu = new CPU(0); }

  _enqueue(pid) { const q = this.state.readyQueue; if (!q.includes(pid)) q.push(pid); }
  _prune() {
    const q = this.state.readyQueue;
    for (let i = q.length - 1; i >= 0; i--) if (this.pm.get(q[i])?.state !== 'READY') q.splice(i, 1);
  }

  /** Keep the CPU consistent if a process was changed manually from the UI. */
  _reconcile() {
    const cpu = this.state.cpu;
    if (cpu.current && this.pm.get(cpu.current)?.state !== 'RUNNING') cpu.release();
    for (const p of this.pm.list) {
      if (p.state !== 'RUNNING' || cpu.current === p.pid) continue;
      if (!cpu.current) cpu.assign(p.pid, this.state.config.timeQuantum);
      else this.pm.transition(p.pid, 'READY');
    }
  }

  /** Processes blocked on a page fault become READY once the page has been read from the backing store. */
  _wake(t) {
    for (const p of this.pm.list) {
      if (p.wakeAt === null) continue;
      if (p.state !== 'WAITING') p.wakeAt = null; // changed manually in the meantime
      else if (p.wakeAt <= t - 1) { p.wakeAt = null; this.pm.transition(p.pid, 'READY'); }
    }
  }

  onTick(state) {
    const t = state.clock, get = (pid) => this.pm.get(pid), algo = this.algorithm, cpu = state.cpu;
    this._wake(t);
    this._reconcile();
    // 1. dispatch
    this._prune();
    if (!cpu.current) {
      const pid = algo.select(state.readyQueue, get);
      if (pid) {
        state.readyQueue.splice(state.readyQueue.indexOf(pid), 1);
        this.pm.transition(pid, 'RUNNING');
        cpu.assign(pid, state.config.timeQuantum);
        const p = get(pid);
        if (p.startTime === null) p.startTime = t - 1;
        this.engine.log('CPU_DISPATCH', `${pid} dispatched to the CPU`, { pid });
      }
    }
    // 2. waiting time for everything still READY during this slot
    for (const p of state.processes) if (p.state === 'READY') p.waitingTime++;
    // 3. execute one time unit
    const p = cpu.current && get(cpu.current);
    let faulted = false;
    if (p) {
      cpu.busyTime++; cpu.quantumLeft--;
      const ref = this.vm ? this.vm.reference(p) : null;
      if (ref && ref.ioError) {
        // The page could not be read from the backing store (RAID array failed): the process cannot continue.
        faulted = true;
        p.abortReason = `Page ${ref.page} unreadable from the backing store: ${ref.io.reason}`;
        this.engine.log('PROCESS_ABORTED', `${p.pid} aborted: ${p.abortReason}`, { pid: p.pid });
        this.pm.terminate(p.pid);
        cpu.release();
      } else if (ref && ref.fault) {
        // Page fault: the instruction did not complete. The process blocks while the page is read in
        // (longer when the RAID array has to reconstruct the block from the surviving disks).
        faulted = true;
        p.wakeAt = t + (ref.serviceTime ?? state.config.pageFaultTime);
        this.pm.transition(p.pid, 'WAITING');
        cpu.release();
      } else { p.remainingTime--; p.cpuTimeUsed++; }
    } else cpu.idleTime++;
    this._gantt(p ? p.pid : null, t);
    // 4. completion / preemption
    if (!p || faulted) return;
    if (p.remainingTime === 0) { p.completionTime = t; this.pm.terminate(p.pid); cpu.release(); }
    else if (algo.usesQuantum && cpu.quantumLeft <= 0) {
      this._prune();
      if (state.readyQueue.length) {
        this.engine.log('CPU_PREEMPT', `${p.pid} preempted (quantum expired)`, { pid: p.pid });
        this.pm.transition(p.pid, 'READY');
        cpu.release();
      } else cpu.quantumLeft = state.config.timeQuantum;
    }
  }

  _gantt(pid, t) {
    const g = this.state.gantt, last = g[g.length - 1];
    if (last && last.pid === pid && last.end === t - 1) last.end = t;
    else g.push({ pid, start: t - 1, end: t });
  }

  stats() {
    const s = this.state, cpu = s.cpu;
    const done = s.processes.filter((p) => p.state === 'TERMINATED' && p.completionTime !== null);
    const avg = (f) => (done.length ? +(done.reduce((a, p) => a + f(p), 0) / done.length).toFixed(2) : 0);
    const busy = cpu.busyTime, idle = cpu.idleTime;
    return {
      completed: done.length,
      avgWaiting: avg((p) => p.waitingTime),
      avgTurnaround: avg((p) => p.completionTime - p.arrivalTime),
      avgResponse: avg((p) => p.startTime - p.arrivalTime),
      throughput: s.clock ? +(done.length / s.clock).toFixed(3) : 0,
      cpuUtilisation: busy + idle ? Math.round((100 * busy) / (busy + idle)) : 0,
      busy, idle,
      rows: done.map((p) => ({ pid: p.pid, completion: p.completionTime, waiting: p.waitingTime,
        turnaround: p.completionTime - p.arrivalTime, response: p.startTime - p.arrivalTime })),
    };
  }
}
