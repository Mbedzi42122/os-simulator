import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulationEngine } from '../js/simulation/SimulationEngine.js';
import { ProcessManager } from '../js/process/ProcessManager.js';
import { MemoryManager } from '../js/memory/MemoryManager.js';
import { VirtualMemory } from '../js/memory/VirtualMemory.js';

// 32 KB physical memory, 4 KB pages -> 8 frames; 128 KB virtual memory -> 32 pages
function setup(cfg = {}) {
  const e = new SimulationEngine(cfg);
  const pm = e.registerModule(new ProcessManager(e));
  const mm = e.registerModule(new MemoryManager(e));
  const vm = e.registerModule(new VirtualMemory(e, pm, mm));
  return { e, pm, mm, vm };
}
const mk = (pm, mem, name = 'p') => pm.create({ name, burstTime: 5, priority: 1, memoryRequired: mem, arrivalTime: 0 });

test('a process is divided into pages and gets a page table with nothing loaded', () => {
  const { e, pm, mm } = setup();
  const p = mk(pm, 10);                      // 10 KB / 4 KB -> 3 pages
  assert.equal(p.pages, 3);
  assert.deepEqual(mm.table(p.pid), [null, null, null]);
  assert.equal(mm.stats().used, 0);
  assert.equal(mm.stats().internalFragmentation, 2); // 3*4 - 10
  assert.equal(e.state.memory.frames.length, 8);
});

test('demand paging: first reference faults, the page lands in the lowest free frame, then hits', () => {
  const { pm, mm, vm } = setup();
  const p = mk(pm, 12);
  p.lastPage = 0;
  vm.nextPage = () => 1;                     // force the reference stream
  assert.equal(vm.reference(p).fault, true);
  assert.deepEqual(mm.table(p.pid), [null, 0, null]);
  assert.equal(mm.frames[0].pid, p.pid);
  assert.equal(vm.reference(p).fault, false);        // retry of the pending reference: hit, not counted
  assert.equal(p.pageHits, 0);
  assert.equal(vm.reference(p).fault, false);        // a fresh reference to the same page: counted hit
  assert.equal(p.pageHits, 1);
  assert.deepEqual([p.pageFaults, vm.stats().faults, vm.stats().hits], [1, 1, 1]);
});

test('pages of one process need not be contiguous, and translation uses the page table', () => {
  const { pm, mm, vm } = setup();
  const a = mk(pm, 8), b = mk(pm, 8);
  const refs = [[a, 0], [b, 0], [a, 1], [b, 1]];
  for (const [p, page] of refs) { vm.nextPage = () => page; vm.reference(p); p.pendingPage = null; }
  assert.deepEqual(mm.table(a.pid), [0, 2]);
  assert.deepEqual(mm.table(b.pid), [1, 3]);
  const x = mm.translate(a.pid, 5);                  // page 1, offset 1 -> frame 2 -> 2*4+1
  assert.deepEqual([x.page, x.offset, x.frame, x.physical, x.resident], [1, 1, 2, 9, true]);
  const miss = mk(pm, 8);
  const y = mm.translate(miss.pid, 0);
  assert.equal(y.resident, false); assert.equal(y.physical, null);
  assert.throws(() => mm.translate(a.pid, 8)); assert.throws(() => mm.translate(a.pid, -1)); assert.throws(() => mm.translate('P999', 0));
});

test('when memory is full a victim is replaced: FIFO evicts the oldest load, LRU the least recently used', () => {
  for (const [alg, victim] of [['FIFO', 0], ['LRU', 1]]) {
    const { pm, mm, vm } = setup({ replacementAlgorithm: alg });
    const p = mk(pm, 36), q = mk(pm, 8);             // p has 9 pages, 8 frames
    const touch = (proc, page) => { vm.nextPage = () => page; proc.pendingPage = null; return vm.reference(proc); };
    for (let i = 0; i < 8; i++) touch(p, i);          // fills frames 0..7 with p0..p7
    touch(p, 0);                                       // p0 becomes most recently used (hit)
    const r = touch(q, 0);                             // needs a frame -> replacement
    assert.equal(r.fault, true);
    assert.equal(r.frame, victim, alg);
    assert.equal(r.evicted.pid, p.pid);
    assert.equal(mm.table(p.pid)[r.evicted.page], null);   // victim's page table entry is cleared
    assert.equal(vm.stats().replacements, 1);
  }
});

test('a process larger than physical memory is allowed (virtual memory) but not larger than the backing store', () => {
  const { pm } = setup();
  const big = mk(pm, 100);                           // 25 pages, only 8 frames
  assert.equal(big.pages, 25);
  assert.throws(() => mk(pm, 200), /virtual memory size/);
});

test('admission waits for backing-store space, then proceeds after a process ends', () => {
  const { e, pm, mm, vm } = setup({ virtualMemorySize: 64 });
  const a = mk(pm, 48), b = mk(pm, 32);              // 12 + 8 pages > 16 pages
  assert.deepEqual(vm.stats().waiting, [b.pid]);
  assert.throws(() => pm.transition(b.pid, 'READY'), /not enough virtual memory/);
  e.step(); e.step();
  assert.equal(a.state, 'READY'); assert.equal(b.state, 'NEW');
  pm.transition(a.pid, 'RUNNING'); pm.terminate(a.pid);
  assert.equal(mm.hasTable(a.pid), false);
  e.step();
  assert.equal(b.state, 'READY'); assert.ok(mm.hasTable(b.pid));
  assert.deepEqual(vm.stats().waiting, []);
});

test('terminating or removing a process frees its frames and page table', () => {
  const { pm, mm, vm } = setup();
  const p = mk(pm, 16);
  vm.nextPage = () => 0; vm.reference(p); p.pendingPage = null;
  vm.nextPage = () => 2; vm.reference(p);
  assert.equal(mm.stats().used, 2);
  pm.transition(p.pid, 'TERMINATED');
  assert.equal(mm.stats().used, 0);
  assert.equal(mm.table(p.pid), null);
  const n = mk(pm, 8);
  pm.remove(n.pid);
  assert.equal(mm.hasTable(n.pid), false);
});

test('memory configuration: validation, rebuild of frames, and limits while in use', () => {
  const { e, pm, mm, vm } = setup();
  assert.throws(() => mm.configure({ memorySize: 30 }));                 // not a multiple of 4
  assert.throws(() => mm.configure({ memorySize: 0 }));
  assert.throws(() => mm.configure({ memorySize: 4096, pageSize: 4 }));  // > 256 frames
  assert.throws(() => mm.configure({ memorySize: 256 }), /virtual memory size/);
  mm.configure({ memorySize: 64 });
  assert.equal(mm.stats().frames, 16);
  const p = mk(pm, 8);
  assert.throws(() => mm.configure({ pageSize: 8 }), /live processes/);
  vm.nextPage = () => 0; vm.reference(p);
  assert.throws(() => mm.configure({ memorySize: 32 }), /no pages are loaded/);
  e.reset();
  assert.equal(mm.stats().frames, 16);
  assert.equal(vm.stats().faults, 0);
});

test('virtual memory configuration is validated', () => {
  const { pm, vm } = setup();
  assert.throws(() => vm.configure({ replacementAlgorithm: 'MRU' }));          // unknown algorithm
  vm.configure({ replacementAlgorithm: 'OPTIMAL' });                        // Optimal is a live algorithm
  assert.throws(() => vm.configure({ pageFaultTime: 0 }));
  assert.throws(() => vm.configure({ virtualMemorySize: 30 }));          // not a multiple of the page size
  assert.throws(() => vm.configure({ virtualMemorySize: 16 }));          // smaller than physical memory
  mk(pm, 60);
  assert.throws(() => vm.configure({ virtualMemorySize: 32 }));          // already in use / below physical
  vm.configure({ virtualMemorySize: 256, replacementAlgorithm: 'LRU', pageFaultTime: 3 });
  assert.equal(vm.state.config.virtualMemorySize, 256);
});

test('memory must be a whole positive number of KB', () => {
  const { pm } = setup();
  assert.throws(() => mk(pm, 10.5));
  assert.throws(() => mk(pm, 0));
});

test('checkConfig validates RAM, page size and virtual memory together', async () => {
  const { SimulationEngine } = await import('../js/simulation/SimulationEngine.js');
  const { ProcessManager } = await import('../js/process/ProcessManager.js');
  const { MemoryManager } = await import('../js/memory/MemoryManager.js');
  const e = new SimulationEngine();
  e.registerModule(new ProcessManager(e));
  const mm = e.registerModule(new MemoryManager(e));
  assert.deepEqual(mm.checkConfig(32, 4, 128), []);
  assert.deepEqual(mm.checkConfig(1048576, 8192, 2097152), []);          // 1 GB RAM, 8 MB pages, 2 GB virtual: valid in one step
  assert.ok(mm.checkConfig(1048576, 1024, 2097152).some((m) => /256 frames/.test(m)));
  assert.ok(mm.checkConfig(64, 4, 32).some((m) => /cannot exceed the virtual memory/.test(m)));
  assert.ok(mm.checkConfig(30, 4, 128).some((m) => /multiple of the page size/.test(m)));
  assert.ok(mm.checkConfig(32, 5, 100).length > 0);
  assert.ok(mm.checkConfig(32.5, 4, 128).length > 0);
  mm.applyConfig(1048576, 8192, 2097152);
  assert.equal(e.state.config.memorySize, 1048576);
  assert.equal(mm.frames.length, 128);
  assert.throws(() => mm.applyConfig(10, 4, 128), /multiple/);
  assert.equal(e.state.config.memorySize, 1048576, 'a failed apply changes nothing');
});

test('page size cannot change while a live process exists', async () => {
  const { SimulationEngine } = await import('../js/simulation/SimulationEngine.js');
  const { ProcessManager } = await import('../js/process/ProcessManager.js');
  const { MemoryManager } = await import('../js/memory/MemoryManager.js');
  const e = new SimulationEngine();
  const pm = e.registerModule(new ProcessManager(e));
  const mm = e.registerModule(new MemoryManager(e));
  pm.create({ name: 'a', burstTime: 3, priority: 1, memoryRequired: 8, arrivalTime: 0 });
  assert.ok(mm.checkConfig(32, 8, 128).some((m) => /no live processes/.test(m)));
  assert.deepEqual(mm.checkConfig(64, 4, 256).length, 0);                // RAM / virtual size may change, page size stays
});

test('OPTIMAL (live) evicts the page whose next use is farthest away, or that is never used again', () => {
  const { pm, mm, vm } = setup({ replacementAlgorithm: 'OPTIMAL' });
  const p = pm.create({ name: 'p', burstTime: 5, priority: 1, memoryRequired: 36, arrivalTime: 0 });   // 9 pages, 8 frames
  for (let pg = 0; pg < 8; pg++) { p.pendingPage = null; vm.reference(p, pg); }                       // frames 0..7 hold p0..p7
  // the process will reference 8, 3, 2, 1, 0 (its 5 remaining instructions): p4..p7 are never used again
  const script = [8, 3, 2, 1, 0]; p.lastPage = 0;
  vm.nextPage = (o) => script[o.lastPage++];          // the stream position lives on the object, so a look-ahead copy cannot disturb it
  p.pendingPage = null;
  const r = vm.reference(p);                              // reference 8 -> fault, memory is full
  assert.equal(r.fault, true);
  assert.equal(r.evicted.page, 4);                        // never used again; ties -> lowest frame
  assert.equal(r.frame, 4);
  assert.equal(p.lastPage, 1);                            // looking ahead did not consume the real stream
});

test('OPTIMAL (live) picks the page used last when every page is used again', () => {
  const { pm, vm } = setup({ replacementAlgorithm: 'OPTIMAL' });
  const p = pm.create({ name: 'p', burstTime: 20, priority: 1, memoryRequired: 36, arrivalTime: 0 });
  for (let pg = 0; pg < 8; pg++) { p.pendingPage = null; vm.reference(p, pg); }
  p.remainingTime = 9;
  const script = [8, 0, 1, 2, 3, 4, 5, 6, 7]; p.lastPage = 0;   // p7 is needed last
  vm.nextPage = (o) => script[o.lastPage++];
  p.pendingPage = null;
  const r = vm.reference(p);
  assert.equal(r.evicted.page, 7);
  const v = vm.vm.trace[vm.vm.trace.length - 1].victim;
  assert.equal(v.policy, 'OPTIMAL'); assert.equal(v.pick, 'largest');
  assert.equal(v.candidates.find((c) => c.page === 7).key, 8);   // 8 references before p7 is used
});

test('OPTIMAL (live) never causes more page faults than FIFO or LRU on the same workload', () => {
  const run = (alg) => {
    const { e, pm, vm } = setup({ replacementAlgorithm: alg, memorySize: 16, virtualMemorySize: 128 });
    pm.create({ name: 'a', burstTime: 40, priority: 1, memoryRequired: 32, arrivalTime: 0 });
    pm.create({ name: 'b', burstTime: 40, priority: 1, memoryRequired: 28, arrivalTime: 0 });
    const ps = pm.list;
    // execute every instruction of every process one after the other (round robin by hand, no scheduler needed)
    for (let step = 0; step < 400 && ps.some((q) => q.remainingTime > 0); step++) {
      for (const q of ps) {
        if (q.remainingTime <= 0) continue;
        const r = vm.reference(q);
        if (!r.fault) { q.remainingTime--; q.cpuTimeUsed++; }
      }
    }
    return vm.stats().faults;
  };
  const [f, l, o] = [run('FIFO'), run('LRU'), run('OPTIMAL')];
  assert.ok(o <= f && o <= l, `optimal ${o}, fifo ${f}, lru ${l}`);
});
