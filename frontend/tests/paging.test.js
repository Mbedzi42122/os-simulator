import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulationEngine } from '../js/simulation/SimulationEngine.js';
import { ProcessManager } from '../js/process/ProcessManager.js';
import { MemoryManager } from '../js/memory/MemoryManager.js';
import { VirtualMemory, parseReferenceString, simulateReplacement } from '../js/memory/VirtualMemory.js';
import { Scheduler } from '../js/cpu/Scheduler.js';

function system(cfg = {}) {
  const e = new SimulationEngine(cfg);
  const pm = e.registerModule(new ProcessManager(e));
  const mm = e.registerModule(new MemoryManager(e));
  const vm = e.registerModule(new VirtualMemory(e, pm, mm));
  const sched = e.registerModule(new Scheduler(e, pm, vm));
  return { e, pm, mm, vm, sched };
}
const mk = (pm, burst, mem, extra = {}) => pm.create({ name: 'p', burstTime: burst, priority: 5, memoryRequired: mem, arrivalTime: 0, ...extra });
const runAll = (e, pm, max = 500) => { for (let i = 0; i < max && pm.list.some((p) => p.state !== 'TERMINATED'); i++) e.step(); };

// --- scheduling and virtual memory working together -----------------------------------------
test('a page fault blocks the process, the CPU runs another one, then the faulting process resumes', () => {
  const { e, pm, vm, mm } = system({ pageFaultTime: 2 });
  const a = mk(pm, 3, 8), b = mk(pm, 3, 8);
  e.step();                                          // tick 1: A dispatched, its first reference faults
  assert.equal(a.state, 'WAITING');
  assert.equal(a.pageFaults, 1);
  assert.equal(a.remainingTime, 3);                  // the faulting instruction did not complete
  assert.equal(e.state.cpu.current, null);
  assert.equal(mm.stats().used, 1);                  // ...but the page is already being loaded into a frame
  e.step();                                          // tick 2: B runs
  assert.equal(b.state === 'RUNNING' || b.state === 'WAITING', true);
  runAll(e, pm);
  assert.ok(pm.list.every((p) => p.state === 'TERMINATED'));
  assert.ok(a.pageFaults >= 1 && b.pageFaults >= 1);
  assert.equal(a.cpuTimeUsed, 3); assert.equal(b.cpuTimeUsed, 3);   // every unit of burst eventually executed
  assert.equal(mm.stats().used, 0);                  // all frames freed at termination
});

test('page-fault wake-up time follows pageFaultTime', () => {
  for (const t of [1, 3]) {
    const { e, pm } = system({ pageFaultTime: t });
    const a = mk(pm, 1, 4);                          // one page: exactly one fault
    e.step();                                        // tick 1: fault in slot [0,1]
    assert.equal(a.state, 'WAITING');
    for (let i = 0; i < t; i++) { e.step(); assert.equal(a.state, 'WAITING'); }   // blocked for exactly t more slots
    e.step();                                        // tick t+2: woken, dispatched, retry hits, instruction completes
    assert.equal(a.state, 'TERMINATED');
    assert.equal(a.completionTime, t + 2);
  }
});

test('faults only exceed the page count when frames are scarce (replacement happens)', () => {
  const roomy = system({ memorySize: 128, virtualMemorySize: 256 });
  const tight = system({ memorySize: 8, virtualMemorySize: 256 });
  for (const s of [roomy, tight]) { mk(s.pm, 60, 32); runAll(s.e, s.pm, 2000); }   // 8 pages
  assert.equal(roomy.vm.stats().faults <= 8, true);
  assert.equal(roomy.vm.stats().replacements, 0);
  assert.equal(tight.vm.stats().replacements > 0, true);
  assert.equal(tight.vm.stats().faults > roomy.vm.stats().faults, true);
});

test('reference stream is deterministic and always inside the process', () => {
  const trace = () => { const s = system(); mk(s.pm, 20, 40); mk(s.pm, 20, 24); runAll(s.e, s.pm, 1000); return s.e.state.virtualMemory.trace.map((x) => [x.pid, x.page, x.fault]); };
  const t1 = trace(), t2 = trace();
  assert.deepEqual(t1, t2);
  assert.ok(t1.every(([pid, page]) => page >= 0 && page < (pid === 'P001' ? 10 : 6)));
});

test('counters stay consistent with per-process statistics and the page tables', () => {
  const { e, pm, vm, mm } = system({ schedulingAlgorithm: 'RR', timeQuantum: 2 });
  mk(pm, 12, 40); mk(pm, 9, 28); mk(pm, 7, 20);
  for (let i = 0; i < 25; i++) {
    e.step();
    const resident = Object.values(e.state.memory.tables).reduce((a, t) => a + t.filter((f) => f !== null).length, 0);
    assert.equal(resident, mm.stats().used);          // page tables and frame table agree
    for (const f of e.state.memory.frames) if (f.pid) assert.equal(mm.table(f.pid)[f.page], e.state.memory.frames.indexOf(f));
  }
  runAll(e, pm, 1000);
  const s = vm.stats();
  assert.equal(s.faults, pm.list.reduce((a, p) => a + p.pageFaults, 0));
  assert.equal(s.hits, pm.list.reduce((a, p) => a + p.pageHits, 0));
  assert.equal(s.faults + s.hits, e.state.virtualMemory.trace.length);   // trace is shorter than the cap here
});

// --- replay of the live trace through the lab ---------------------------------------------------
test('live trace replay reproduces the real FIFO fault count', () => {
  const { e, pm, vm } = system({ replacementAlgorithm: 'FIFO', memorySize: 16 });
  mk(pm, 8, 24); mk(pm, 8, 20);
  runAll(e, pm, 1000);
  assert.ok(vm.stats().references <= 100);
  const r = vm.runTrace('FIFO', 100);
  assert.equal(r.faults, vm.stats().faults);
  assert.equal(e.state.virtualMemory.lab.frames, 4);
  assert.ok(e.state.virtualMemory.lab.labels.length > 0);
  const opt = simulateReplacement(e.state.virtualMemory.lab.refs, 4, 'OPTIMAL');
  assert.ok(opt.faults <= r.faults);
});

test('trace replay needs recorded references', () => {
  const { vm } = system();
  assert.throws(() => vm.runTrace('FIFO'), /No page references/);
});

// --- page replacement lab (pure algorithms) -----------------------------------------------------
const S = '7 0 1 2 0 3 0 4 2 3 0 3 2 1 2 0 1 7 0 1';
const faults = (str, n, alg) => simulateReplacement(parseReferenceString(str), n, alg).faults;

test('classic textbook results (3 frames)', () => {
  assert.equal(faults(S, 3, 'FIFO'), 15);
  assert.equal(faults(S, 3, 'LRU'), 12);
  assert.equal(faults(S, 3, 'OPTIMAL'), 9);
});

test('spec example: 4 frames', () => {
  const r = simulateReplacement(parseReferenceString('1 2 3 4 1 2 5 1'), 4, 'OPTIMAL');
  assert.equal(r.faults, 5); assert.equal(r.hits, 3);
  assert.equal(faults('1 2 3 4 1 2 5 1', 4, 'LRU'), 5);
  assert.equal(faults('1 2 3 4 1 2 5 1', 4, 'FIFO'), 6);
});

test("Belady's anomaly under FIFO", () => {
  const b = '1 2 3 4 1 2 5 1 2 3 4 5';
  assert.equal(faults(b, 3, 'FIFO'), 9);
  assert.equal(faults(b, 4, 'FIFO'), 10);
});

test('result is internally consistent', () => {
  const r = simulateReplacement(parseReferenceString(S), 3, 'LRU');
  assert.equal(r.faults + r.hits, 20);
  assert.equal(r.steps.length, 20);
  assert.equal(r.steps.filter((s) => s.fault).length, r.faults);
  assert.ok(r.steps.every((s) => s.frames.length === 3));
  assert.equal(r.faultRatio + r.hitRatio, 1);
});

test('lab run stores its result and validates input', () => {
  const { vm, e } = system();
  vm.run({ refString: S, frames: 3, algorithm: 'LRU' });
  assert.equal(e.state.virtualMemory.lab.result.faults, 12);
  assert.throws(() => vm.run({ refString: S, frames: 11, algorithm: 'FIFO' }));
  assert.deepEqual(parseReferenceString('1, 2,3  4'), [1, 2, 3, 4]);
  assert.throws(() => parseReferenceString(''));
  assert.throws(() => parseReferenceString('1 x 3'));
  assert.throws(() => parseReferenceString('1 -2'));
  assert.throws(() => simulateReplacement([1], 2, 'MRU'));
});
