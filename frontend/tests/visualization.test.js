import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulationEngine } from '../js/simulation/SimulationEngine.js';
import { ProcessManager } from '../js/process/ProcessManager.js';
import { MemoryManager } from '../js/memory/MemoryManager.js';
import { VirtualMemory } from '../js/memory/VirtualMemory.js';
import { Scheduler } from '../js/cpu/Scheduler.js';
import { RaidManager } from '../js/raid/RaidManager.js';
import { Visualizer, buildSteps, hex } from '../js/visualization/Visualizer.js';

function system(cfg = {}) {
  const e = new SimulationEngine(cfg);
  const pm = e.registerModule(new ProcessManager(e));
  const mm = e.registerModule(new MemoryManager(e));
  const raid = e.registerModule(new RaidManager(e));
  const vm = e.registerModule(new VirtualMemory(e, pm, mm, raid));
  const sched = e.registerModule(new Scheduler(e, pm, vm));
  const viz = new Visualizer(e, { pm, mm, vm, raid, colour: () => '#000', esc: String });
  return { e, pm, mm, vm, raid, sched, viz };
}
const mk = (pm, burst, mem) => pm.create({ name: 'p', burstTime: burst, priority: 5, memoryRequired: mem, arrivalTime: 0 });
const ids = (rec) => buildSteps(rec).map((s) => s.id);

// --- step sequences (the story of one memory access) -----------------------------------------------------
const base = { pid: 'P001', page: 3, instr: 7, write: false, offset: 10, frame: 2, serviceTime: 2 };
test('a hit is: request, lookup, page present, access', () => {
  assert.deepEqual(ids({ ...base, fault: false }), ['request', 'lookup', 'hit', 'access']);
});
test('a page fault into a free frame follows the specified sequence', () => {
  assert.deepEqual(ids({ ...base, fault: true, evicted: null, victim: null }),
    ['request', 'lookup', 'fault', 'io', 'transfer', 'place', 'ptupdate', 'resume']);
});
test('a page fault with no free frame selects and evicts a victim before loading', () => {
  const rec = { ...base, fault: true, evicted: { pid: 'P002', page: 1, dirty: true }, victim: { frame: 2, policy: 'FIFO', keyName: 'loaded' } };
  const s = buildSteps(rec);
  assert.deepEqual(s.map((x) => x.id), ['request', 'lookup', 'fault', 'victim', 'evict', 'io', 'transfer', 'place', 'ptupdate', 'resume']);
  assert.match(s.find((x) => x.id === 'victim').text, /FIFO.*"loaded".*Frame 2/);
  assert.match(s.find((x) => x.id === 'evict').text, /MODIFIED.*written back/);
  assert.match(buildSteps({ ...rec, evicted: { ...rec.evicted, dirty: false } }).find((x) => x.id === 'evict').text, /nothing to write/);
});
test('an unreadable page stops after the I/O error: nothing is loaded', () => {
  assert.deepEqual(ids({ ...base, fault: true, ioError: true, io: { reason: 'the array is FAILED (offline)' } }), ['request', 'lookup', 'fault', 'io', 'ioerror']);
});
test('hex helper', () => assert.equal(hex(255, 4), '0x00FF'));

// --- richer trace records from the core ------------------------------------------------------------------
test('every reference is recorded with a sequence number, instruction, offset and store flag', () => {
  const { e, pm, vm } = system({ pageFaultTime: 1 });
  mk(pm, 20, 16);
  for (let i = 0; i < 30; i++) e.step();
  const tr = e.state.virtualMemory.trace;
  assert.ok(tr.length > 5);
  tr.forEach((r, i) => { assert.equal(r.seq, i + 1); assert.ok(Number.isInteger(r.instr) && r.instr >= 1); assert.ok(r.offset >= 0 && r.offset < 4096); assert.equal(typeof r.write, 'boolean'); });
  assert.equal(e.state.virtualMemory.refSeq, tr.length);
  assert.ok(tr.some((r) => r.write) && tr.some((r) => !r.write));   // loads and stores both occur
});
test('instruction facts are deterministic: same run, same offsets', () => {
  const run = () => { const s = system({ pageFaultTime: 1 }); mk(s.pm, 10, 16); for (let i = 0; i < 20; i++) s.e.step(); return s.e.state.virtualMemory.trace.map((r) => [r.page, r.offset, r.write]); };
  assert.deepEqual(run(), run());
});
test('a replacement records the candidates the algorithm compared and the chosen victim', () => {
  const { e, pm, vm } = system({ memorySize: 8, virtualMemorySize: 64, pageFaultTime: 1 });   // 2 frames
  const p = mk(pm, 40, 32);                                                                    // 8 pages
  for (let i = 0; i < 80 && !e.state.virtualMemory.trace.some((r) => r.victim); i++) e.step();
  const r = e.state.virtualMemory.trace.find((x) => x.victim);
  assert.ok(r, 'a replacement happened');
  assert.equal(r.victim.policy, 'FIFO');
  assert.equal(r.victim.candidates.length, 2);
  const smallest = r.victim.candidates.reduce((a, b) => (b.key < a.key ? b : a));
  assert.equal(r.victim.frame, smallest.frame);               // FIFO: smallest loaded number
  assert.equal(r.frame, r.victim.frame);                      // the new page goes into the victim's frame
  assert.deepEqual([r.evicted.pid, r.evicted.page], [smallest.pid, smallest.page]);
});
test('LRU selection compares last-used numbers', () => {
  const { e, pm } = system({ memorySize: 8, virtualMemorySize: 64, pageFaultTime: 1, replacementAlgorithm: 'LRU' });
  mk(pm, 60, 32);
  for (let i = 0; i < 120 && !e.state.virtualMemory.trace.some((r) => r.victim); i++) e.step();
  const v = e.state.virtualMemory.trace.find((x) => x.victim).victim;
  assert.equal(v.keyName, 'last used');
  assert.equal(v.frame, v.candidates.reduce((a, b) => (b.key < a.key ? b : a)).frame);
});
test('store instructions mark the page modified; evicting a modified page is a write-back', () => {
  const { e, pm, mm, vm } = system({ memorySize: 8, virtualMemorySize: 128, pageFaultTime: 1 });
  mk(pm, 150, 64);
  for (let i = 0; i < 700 && pm.list.some((p) => p.state !== 'TERMINATED'); i++) e.step();
  const tr = e.state.virtualMemory.trace, c = e.state.virtualMemory.counters;
  assert.ok(c.replacements > 0);
  const dirtyEvictions = tr.filter((r) => r.evicted && r.evicted.dirty).length;
  assert.ok(dirtyEvictions > 0 && dirtyEvictions < c.replacements);               // some, but not all, pages were modified
  assert.ok(e.state.events.some((x) => x.type === 'PAGE_WRITEBACK'));
});
test('a frame that was just loaded for a load instruction is clean', () => {
  const { e, pm, mm } = system();
  mk(pm, 3, 4);
  for (let i = 0; i < 6; i++) e.step();
  const r = e.state.virtualMemory.trace[0];
  assert.equal(mm.frames[r.frame].dirty, r.write);
});

// --- manual request from the visualisation ---------------------------------------------------------------------
test('requestPage performs a real access: fault first, then hit, without blocking the process', () => {
  const { e, pm, vm, mm } = system();
  const p = mk(pm, 5, 16);
  const before = p.state;
  const r1 = vm.requestPage(p.pid, 2);
  assert.equal(r1.fault, true); assert.equal(r1.page, 2); assert.equal(r1.manual, true);
  assert.equal(mm.table(p.pid)[2], r1.frame);
  const r2 = vm.requestPage(p.pid, 2);
  assert.equal(r2.fault, false);
  assert.equal(p.state, before); assert.equal(p.pendingPage, null); assert.equal(p.wakeAt, null);
  assert.ok(e.state.events.some((x) => x.type === 'MANUAL_PAGE_REQUEST'));
});
test('requestPage can force a replacement when memory is full', () => {
  const { pm, vm, e } = system({ memorySize: 8, virtualMemorySize: 64 });      // 2 frames
  const p = mk(pm, 5, 16);
  vm.requestPage(p.pid, 0); vm.requestPage(p.pid, 1);
  const r = vm.requestPage(p.pid, 2);
  assert.ok(r.victim && r.evicted);
  assert.equal(e.state.virtualMemory.counters.replacements, 1);
});
test('requestPage validates its input', () => {
  const { pm, vm } = system();
  const p = mk(pm, 5, 8);
  assert.throws(() => vm.requestPage(p.pid, 9), /no page 9/);
  assert.throws(() => vm.requestPage('P999', 0), /address space/);
  p.pendingPage = 1;
  assert.throws(() => vm.requestPage(p.pid, 0), /waiting/);
});
test('manual request on a failed array reports an I/O error and does not kill the process', () => {
  const { pm, vm, raid } = system();
  const p = mk(pm, 5, 16);
  raid.failDisk(0); raid.failDisk(1);                                         // RAID 5: array FAILED
  const r = vm.requestPage(p.pid, 0);
  assert.equal(r.ioError, true);
  assert.notEqual(p.state, 'TERMINATED');
});

// --- engine clock hold ---------------------------------------------------------------------------------------------
test('holdClock stops ticks without changing status; releaseClock continues', async () => {
  const e = new SimulationEngine(); e.setSpeed(10); e.start();
  await new Promise((r) => setTimeout(r, 250));
  e.holdClock();
  const t = e.state.clock;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(e.state.clock, t); assert.equal(e.state.status, 'RUNNING');
  e.releaseClock();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(e.state.clock > t);
  e.pause();
  e.releaseClock();                                    // no effect while paused
  assert.equal(e.timer, null);
});

// --- the display masks: the screen tells the story in order -------------------------------------------------------------
test('while a fault is queued the frame, page table and chip still show the old state', () => {
  const { e, pm, mm, vm, viz } = system({ memorySize: 8, virtualMemorySize: 64, pageFaultTime: 1 });
  const p = mk(pm, 5, 24);
  vm.requestPage(p.pid, 0); vm.requestPage(p.pid, 1);                         // fill both frames (viz inactive: instant)
  viz.active = true; viz.playing = true;                                       // records are queued; playback is held so the test drives the flags
  vm.requestPage(p.pid, 2);                                                    // evicts page 0 (FIFO) into frame 0
  assert.equal(viz.queue.length, 1);
  const q = viz.queue[0];
  assert.equal(mm.table(p.pid)[2], 0);                                         // live: page 2 is already in frame 0
  assert.deepEqual([viz.dispFrame(0).pid, viz.dispFrame(0).page], [p.pid, 0]); // screen: still page 0
  assert.equal(viz.dispEntry(p.pid, 2), null);                                 // screen: page 2 NOT PRESENT
  assert.equal(viz.dispEntry(p.pid, 0), 0);                                    // screen: page 0 still in frame 0
  assert.equal(viz._status(p.pid, 2), 'loading');
  q.evictDone = true; q.evictPtDone = true;                                    // victim has left
  assert.equal(viz.dispFrame(0), null);                                        // frame shown empty
  assert.equal(viz.dispEntry(p.pid, 0), null);
  q.placed = true;                                                             // page arrived
  assert.equal(viz.dispFrame(0).page, 2);
  assert.equal(viz.dispEntry(p.pid, 2), null);                                 // table not updated yet
  q.ptDone = true;
  assert.equal(viz.dispEntry(p.pid, 2), 0);
  assert.equal(viz._status(p.pid, 2), 'mem');
  assert.equal(viz._status(p.pid, 0), 'disk');                                 // (evicted flag is set by the animation step)
});
test('when the page is hidden records are applied instantly and evictions are remembered', () => {
  const { pm, vm, viz } = system({ memorySize: 8, virtualMemorySize: 64, pageFaultTime: 1 });
  const p = mk(pm, 5, 24);
  vm.requestPage(p.pid, 0); vm.requestPage(p.pid, 1); vm.requestPage(p.pid, 2);
  assert.equal(viz.queue.length, 0);
  assert.equal(viz._status(p.pid, 0), 'evicted');
  assert.equal(viz._status(p.pid, 2), 'mem');
  assert.equal(viz._status(p.pid, 1), 'mem');
  vm.requestPage(p.pid, 0);                                                    // brought back: no longer "evicted"
  assert.equal(viz._status(p.pid, 0), 'mem');
});
test('a simulation reset clears the visualisation state', () => {
  const { e, pm, vm, viz } = system();
  const p = mk(pm, 5, 8);
  vm.requestPage(p.pid, 0);
  assert.ok(viz.lastSeq > 0);
  e.reset();
  assert.equal(viz.lastSeq, 0);
  assert.equal(viz.cpuView, null);
});
