import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulationEngine } from '../js/simulation/SimulationEngine.js';
import { ProcessManager } from '../js/process/ProcessManager.js';
import { MemoryManager } from '../js/memory/MemoryManager.js';
import { VirtualMemory } from '../js/memory/VirtualMemory.js';
import { Scheduler } from '../js/cpu/Scheduler.js';
import { RaidManager } from '../js/raid/RaidManager.js';
import { buildArray, checkDisks, describe, evaluate, tolerance, LEVEL_IDS } from '../js/raid/RaidLayout.js';

const labels = (a) => a.cells.map((row) => row.map((c) => c.label).join(' '));
const status = (level, n, failed) => evaluate(buildArray(level, n, 2), new Set(failed.map((d) => d - 1))).status;   // disks are 1-based here
const SIZES = { 0: 4, 1: 3, 2: 7, 3: 4, 4: 5, 5: 4, 6: 5, 10: 6, 50: 6, 60: 8 };

function system(cfg = {}, raidCfg = null) {
  const e = new SimulationEngine(cfg);
  const pm = e.registerModule(new ProcessManager(e));
  const mm = e.registerModule(new MemoryManager(e));
  const raid = e.registerModule(new RaidManager(e));
  if (raidCfg) raid.configure(raidCfg);
  const vm = e.registerModule(new VirtualMemory(e, pm, mm, raid));
  const sched = e.registerModule(new Scheduler(e, pm, vm));
  return { e, pm, mm, raid, vm, sched };
}
const mk = (pm, burst, mem, extra = {}) => pm.create({ name: 'p', burstTime: burst, priority: 5, memoryRequired: mem, arrivalTime: 0, ...extra });

// --- layouts --------------------------------------------------------------------------------------
test('RAID 0 stripes blocks like the specification example', () => {
  assert.deepEqual(labels(buildArray(0, 2, 3)), ['A1 A2', 'A3 A4', 'A5 A6']);
});
test('RAID 1 mirrors every block on every disk', () => {
  const a = buildArray(1, 3, 2);
  assert.deepEqual(labels(a), ['A1 A1 A1', 'A2 A2 A2']);
  assert.equal(a.logicalBlocks, 2);
});
test('RAID 4 keeps parity on a dedicated disk, RAID 5 rotates it, RAID 6 has P and Q', () => {
  assert.deepEqual(labels(buildArray(4, 4, 2)), ['A1 A2 A3 P1', 'A4 A5 A6 P2']);
  assert.deepEqual(labels(buildArray(5, 4, 4)), ['A1 A2 A3 P1', 'A4 A5 P2 A6', 'A7 P3 A8 A9', 'P4 A10 A11 A12']);
  const a6 = buildArray(6, 5, 2);
  for (const row of a6.cells) { assert.equal(row.filter((c) => c.kind === 'parity').length, 1); assert.equal(row.filter((c) => c.kind === 'parityQ').length, 1); }
});
test('RAID 2 puts ECC disks at power-of-two positions; RAID 3 has a dedicated parity disk', () => {
  const a2 = buildArray(2, 7, 1);
  assert.deepEqual(a2.cells[0].map((c) => c.kind), ['ecc', 'ecc', 'data', 'ecc', 'data', 'data', 'data']);
  assert.deepEqual(buildArray(3, 4, 1).cells[0].map((c) => c.kind), ['data', 'data', 'data', 'parity']);
});
test('RAID 10 / 50 / 60 are built from groups', () => {
  assert.deepEqual(buildArray(10, 6, 1).groups.map((g) => g.disks), [[0, 1], [2, 3], [4, 5]]);
  assert.deepEqual(buildArray(50, 6, 1).groups.map((g) => g.disks), [[0, 1, 2], [3, 4, 5]]);
  assert.deepEqual(buildArray(60, 8, 1).groups.map((g) => g.disks), [[0, 1, 2, 3], [4, 5, 6, 7]]);
});
test('disk counts are validated per level', () => {
  assert.match(checkDisks(5, 2), /at least 3/);
  assert.match(checkDisks(6, 3), /at least 4/);
  assert.match(checkDisks(10, 5), /even/);
  assert.match(checkDisks(50, 7), /cannot be split/);
  assert.match(checkDisks(60, 6), /at least 8|cannot be split/);
  assert.match(checkDisks(2, 8), /power of two/);
  assert.equal(checkDisks(0, 2), null);
  assert.match(checkDisks(0, 17), /2 to 16/);
});
test('usable capacity follows from the layout', () => {
  assert.equal(describe(0, 4, 10).usable, 40);
  assert.equal(describe(1, 4, 10).usable, 10);
  assert.equal(describe(5, 4, 10).usable, 30);
  assert.equal(describe(6, 6, 10).usable, 40);
  assert.equal(describe(10, 6, 10).usable, 30);
  assert.equal(describe(50, 6, 10).usable, 40);
  assert.equal(describe(60, 8, 10).usable, 40);
  assert.equal(describe(3, 5, 10).usable, 40);
});
test('guaranteed / best-case tolerance', () => {
  const t = (l, n) => tolerance(buildArray(l, n, 1));
  assert.deepEqual(t(0, 4), { guaranteed: 0, best: 0 });
  assert.deepEqual(t(1, 4), { guaranteed: 3, best: 3 });
  assert.deepEqual(t(5, 5), { guaranteed: 1, best: 1 });
  assert.deepEqual(t(6, 5), { guaranteed: 2, best: 2 });
  assert.deepEqual(t(10, 6), { guaranteed: 1, best: 3 });
  assert.deepEqual(t(60, 8), { guaranteed: 2, best: 4 });
});

// --- status depends on level, number AND location of failed disks ---------------------------------------
test('RAID 0 fails on any failure', () => {
  assert.equal(status(0, 4, []), 'OPTIMAL');
  assert.equal(status(0, 4, [3]), 'FAILED');
});
test('RAID 1 is degraded until the last copy is lost', () => {
  assert.equal(status(1, 3, [1]), 'DEGRADED');
  assert.equal(status(1, 3, [1, 3]), 'DEGRADED');
  assert.equal(status(1, 3, [1, 2, 3]), 'FAILED');
});
test('single-parity levels (2, 3, 4, 5) survive one failure, not two', () => {
  for (const [l, n] of [[2, 7], [3, 4], [4, 5], [5, 4]]) {
    assert.equal(status(l, n, [2]), 'DEGRADED', `RAID ${l}`);
    assert.equal(status(l, n, [1, 2]), 'FAILED', `RAID ${l}`);
  }
});
test('RAID 6 survives two failures, not three', () => {
  assert.equal(status(6, 5, [1, 5]), 'DEGRADED');
  assert.equal(status(6, 5, [1, 3, 5]), 'FAILED');
});
test('RAID 10: it matters WHICH disks fail', () => {
  assert.equal(status(10, 6, [1, 3, 5]), 'DEGRADED');   // one per pair
  assert.equal(status(10, 6, [1, 2]), 'FAILED');        // both disks of pair 1
  assert.equal(status(10, 6, [1, 4]), 'DEGRADED');      // two failures, different pairs
});
test('RAID 50 / 60: tolerance is per sub-array', () => {
  assert.equal(status(50, 6, [1, 4]), 'DEGRADED');      // one per sub-array
  assert.equal(status(50, 6, [1, 2]), 'FAILED');        // two in sub-array 1
  assert.equal(status(60, 8, [1, 2, 5, 6]), 'DEGRADED'); // two per sub-array
  assert.equal(status(60, 8, [1, 2, 3]), 'FAILED');     // three in sub-array 1
  assert.equal(status(60, 8, [1, 2, 5]), 'DEGRADED');
});

// --- the redundancy really works: contents are recomputed from the survivors -----------------------------
test('every single disk failure is recoverable (and verified) for every redundant level', () => {
  for (const l of LEVEL_IDS.filter((x) => x !== 0)) {
    const { e, raid } = system();
    raid.configure({ level: l, disks: SIZES[l], capacity: 6 });
    for (let d = 0; d < SIZES[l]; d++) {
      raid.failDisk(d);
      const v = raid.verifyRecovery();
      assert.ok(v.checked > 0 && v.matched === v.checked && v.unrecoverable === 0, `RAID ${l} disk ${d + 1}: ${JSON.stringify(v)}`);
      raid.replaceDisk(d); raid.completeRebuild();
      assert.equal(raid.status, 'OPTIMAL');
    }
  }
});
test('RAID 6 recovers every pair of failed disks (data+data, data+P, data+Q, P+Q)', () => {
  const { raid } = system();
  raid.configure({ level: 6, disks: 6, capacity: 6 });
  for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) {
    raid.failDisk(a); raid.failDisk(b);
    const v = raid.verifyRecovery();
    assert.ok(v.checked > 0 && v.matched === v.checked, `disks ${a + 1},${b + 1}: ${JSON.stringify(v)}`);
    raid.replaceDisk(a); raid.replaceDisk(b); raid.completeRebuild();
    assert.equal(raid.status, 'OPTIMAL');
  }
});
test('RAID 60 recovers two failures in each sub-array', () => {
  const { raid } = system();
  raid.configure({ level: 60, disks: 8, capacity: 4 });
  [0, 1, 4, 7].forEach((d) => raid.failDisk(d));
  assert.equal(raid.status, 'DEGRADED');
  const v = raid.verifyRecovery();
  assert.ok(v.checked > 0 && v.matched === v.checked);
});
test('a failed disk loses its contents; rebuilding restores exactly the original contents', () => {
  const { e, raid } = system();
  raid.failDisk(1);
  assert.ok(raid.r.store[1].every((v) => v === null));
  raid.replaceDisk(1);
  e.step(); e.step();                                     // 1 row per tick
  assert.equal(raid.r.disks[1].progress, 2);
  assert.equal(raid.status, 'DEGRADED');
  assert.equal(raid.evaluation().rebuilding, true);
  for (let i = 0; i < 20; i++) e.step();
  assert.equal(raid.r.disks[1].status, 'OK');
  assert.equal(raid.status, 'OPTIMAL');
  assert.deepEqual(raid.r.store[1], raid.array.cells.map((row) => row[1].value));
});
test('beyond the tolerance data is lost for good: replacing a disk cannot rebuild it', () => {
  const { raid } = system();                              // RAID 5
  raid.failDisk(0); raid.failDisk(1);
  assert.equal(raid.status, 'FAILED');
  assert.throws(() => raid.replaceDisk(0), /lost data/);
  assert.throws(() => raid.configure({ level: 5, disks: 4, capacity: 12 }), /FAILED/);
  raid.reinitialise();
  assert.equal(raid.status, 'OPTIMAL');
});
test('impact: blocks on a failed disk are reconstructed, the rest are read directly', () => {
  const { raid } = system();                              // RAID 5, 4 disks x 12
  raid.failDisk(1);
  const im = raid.impact();
  assert.equal(im.total, 36);
  assert.equal(im.unreadable, 0);
  assert.equal(im.reconstructed, 9);                      // disk 2 holds 9 data blocks and 3 parity blocks
  assert.equal(im.direct, 27);
  assert.equal(raid.impact().availability, 100);
});
test('RAID 0 failure makes every block unreadable', () => {
  const { raid } = system({}, { level: 0, disks: 3, capacity: 4 });
  raid.failDisk(2);
  assert.equal(raid.impact().unreadable, 12);
});
test('configuration is validated and refused when the backing store would not fit', () => {
  const { e, pm, raid } = system();
  assert.throws(() => raid.configure({ level: 5, disks: 2, capacity: 4 }), /at least 3/);
  assert.throws(() => raid.configure({ level: 5, disks: 4, capacity: 0 }), /capacity/);
  mk(pm, 5, 40);                                          // 10 pages
  assert.throws(() => raid.configure({ level: 1, disks: 2, capacity: 4 }), /usable/);
  raid.configure({ level: 1, disks: 2, capacity: 12 });
  assert.equal(raid.usableBlocks, 12);
});

// --- integration with the other modules ------------------------------------------------------------------
test('the array is the backing store: it limits the address space and each page owns a block', () => {
  const { e, pm, vm, raid } = system({}, { level: 5, disks: 4, capacity: 4 });   // 12 usable blocks = 48 KB
  assert.equal(vm.capacityPages, 12);
  assert.throws(() => mk(pm, 5, 64), /virtual memory size/);                  // 16 pages cannot fit
  const p = mk(pm, 5, 16);                                                     // 4 pages
  assert.deepEqual(raid.r.swap[p.pid], [0, 1, 2, 3]);
  assert.equal(raid.owners()[2].pid, p.pid);
  pm.transition(p.pid, 'READY'); pm.transition(p.pid, 'RUNNING'); pm.terminate(p.pid);
  assert.equal(raid.allocatedBlocks().length, 0);                              // freed with the process
});
test('healthy array: page-fault service time is unchanged', () => {
  const { e, pm, sched } = system({ pageFaultTime: 2 });
  const a = mk(pm, 1, 4);
  e.step();
  assert.equal(a.wakeAt, 1 + 2);
});
test('degraded RAID 5 makes a page-in on the failed disk slower (n-1 reads); RAID 1 and RAID 6 differ', () => {
  const run = (raidCfg) => {
    const { e, pm, raid } = system({ pageFaultTime: 2 }, raidCfg);
    const a = mk(pm, 1, 4);                               // page 0 -> logical block 0 -> disk 1 (all these layouts)
    raid.failDisk(raid.array.logical[0].disks[0]);
    e.step();
    return { wait: a.wakeAt - 1, raid };
  };
  const r5 = run({ level: 5, disks: 5, capacity: 6 });
  assert.equal(r5.wait, 2 + 3);                           // 4 survivors read, 1 would be normal -> +3
  assert.equal(r5.raid.stats().reconstructed, 1);
  assert.equal(run({ level: 1, disks: 2, capacity: 6 }).wait, 2);       // another copy exists: no penalty
  assert.equal(run({ level: 6, disks: 5, capacity: 6 }).wait, 2 + 3);
  assert.equal(run({ level: 3, disks: 4, capacity: 6 }).wait, 2);       // byte striping: parity replaces the slice, same I/O count
  assert.equal(run({ level: 10, disks: 4, capacity: 6 }).wait, 2);
});
test('a page-in from a healthy disk is not penalised even while another disk is failed', () => {
  const { e, pm, raid } = system({ pageFaultTime: 2 });                         // RAID 5, block 0 on disk 1
  const a = mk(pm, 1, 4);
  raid.failDisk(3);                                                              // disk 4 holds parity P1 for row 1, not block 0
  e.step();
  assert.equal(a.wakeAt - 1, 2);
  assert.equal(raid.stats().reconstructed, 0);
});
test('RAID 0 disk failure aborts the process that needs the lost page; resident pages keep running', () => {
  const { e, pm, mm, raid } = system({ pageFaultTime: 1 }, { level: 0, disks: 2, capacity: 12 });
  const a = mk(pm, 40, 40);                               // 10 pages spread over both disks
  e.step();                                               // first page fault succeeds
  assert.equal(a.state, 'WAITING');
  raid.failDisk(0);
  assert.equal(raid.status, 'FAILED');
  for (let i = 0; i < 300 && a.state !== 'TERMINATED'; i++) e.step();
  assert.equal(a.state, 'TERMINATED');
  assert.match(a.abortReason, /offline/);
  assert.equal(a.completionTime, null);                   // killed, not completed
  assert.ok(raid.stats().ioErrors >= 1);
  assert.ok(e.state.events.some((x) => x.type === 'PROCESS_ABORTED'));
  assert.equal(mm.stats().used, 0);                       // its frames were released
  assert.equal(raid.allocatedBlocks().length, 0);
});
test('while the array is FAILED new processes wait; they are admitted after the array is re-created', () => {
  const { e, pm, vm, raid } = system({}, { level: 0, disks: 2, capacity: 12 });
  raid.failDisk(1);
  const p = mk(pm, 2, 8);
  e.step();
  assert.equal(p.state, 'NEW');
  assert.ok(vm.stats().waiting.includes(p.pid));
  raid.reinitialise();
  e.step();
  assert.notEqual(p.state, 'NEW');
  assert.ok(raid.r.swap[p.pid]);
});
test('blocks lost by re-creating the array abort the processes that stored pages there', () => {
  const { e, pm, raid } = system({ pageFaultTime: 1 }, { level: 0, disks: 2, capacity: 12 });
  const a = mk(pm, 30, 40);
  raid.failDisk(0);
  raid.reinitialise();
  assert.equal(raid.status, 'OPTIMAL');
  for (let i = 0; i < 100 && a.state !== 'TERMINATED'; i++) e.step();
  assert.equal(a.state, 'TERMINATED');
  assert.match(a.abortReason, /lost/);
});
test('degraded RAID 6 / rebuild: processes still finish and every burst unit executes', () => {
  const { e, pm, raid } = system({ pageFaultTime: 1 }, { level: 6, disks: 5, capacity: 12 });
  const ps = [mk(pm, 6, 12), mk(pm, 6, 12)];
  raid.failDisk(0); raid.failDisk(1);
  assert.equal(raid.status, 'DEGRADED');
  for (let i = 0; i < 400 && ps.some((p) => p.state !== 'TERMINATED'); i++) e.step();
  assert.ok(ps.every((p) => p.state === 'TERMINATED' && p.cpuTimeUsed === 6));
});
test('reset recreates a healthy default array', () => {
  const { e, raid } = system();
  raid.failDisk(0);
  e.reset();
  assert.equal(raid.status, 'OPTIMAL');
  assert.equal(e.state.raid.config.level, 5);
});
