import { RAID_LEVELS, MAX_DISKS, MIN_CAPACITY, MAX_CAPACITY, buildArray, checkDisks, evaluate, tolerance, recoverStripe, normalIOs } from './RaidLayout.js';

export const DEFAULT_RAID = { level: 5, disks: 4, capacity: 12 }; // 4 x 12 blocks, RAID 5 -> 36 usable blocks (144 KB at 4 KB/block)
export const REBUILD_ROWS_PER_TICK = 1;

/**
 * The disk array that holds the system's BACKING STORE (swap space for virtual memory).
 *  - One block of the array = one page (config.pageSize KB). When a process gets an address space the
 *    VirtualMemory manager asks `allocate()` for one logical block per page.
 *  - A page fault reads that block through `readPage()`: the layout says which disk holds it; if that disk
 *    has failed the block is rebuilt from the surviving disks (extra I/Os = extra ticks); if the array has
 *    failed the read errors out and the faulting process is aborted.
 *  - Disk failure / replacement / rebuild are driven by the user and by the simulation clock.
 * state.raid = { config, disks[{status,progress,reads}], store[disk][row], swap{pid:[lb]}, lost[lb], dataLost, stats }
 */
export class RaidManager {
  constructor(engine) {
    this.name = 'raid';
    this.engine = engine;
    this.array = null;
    engine.bus.on('PROCESS_TERMINATED', (e) => this.release(e.pid));
    engine.bus.on('PROCESS_REMOVED', (e) => this.release(e.pid));
    this._init({ ...DEFAULT_RAID }, { swap: {}, lost: [] });
  }
  get state() { return this.engine.state; }
  get r() { return this.state.raid; }
  get blockKB() { return this.state.config.pageSize; }
  onReset() { this._init({ ...DEFAULT_RAID }, { swap: {}, lost: [] }); }

  _init(config, keep) {
    this.array = buildArray(config.level, config.disks, config.capacity);
    const prev = this.state.raid;
    this.state.raid = {
      config: { ...config },
      disks: Array.from({ length: config.disks }, () => ({ status: 'OK', progress: 0, reads: 0 })),
      store: this.array.cells.length ? Array.from({ length: config.disks }, (_, d) => this.array.cells.map((row) => row[d].value)) : [],
      swap: keep.swap, lost: keep.lost, dataLost: false,
      stats: prev?.stats ? { ...prev.stats } : { reads: 0, direct: 0, reconstructed: 0, extraTicks: 0, ioErrors: 0, failures: 0, rebuilds: 0 },
    };
  }

  // Status ---------------------------------------------------------------------------------------
  /** Disks that cannot serve their data right now (failed, or replaced but not rebuilt yet). */
  unavailable() { return new Set(this.r.disks.flatMap((d, i) => (d.status === 'OK' ? [] : [i]))); }
  evaluation() {
    const ev = evaluate(this.array, this.unavailable());
    if (this.r.dataLost) ev.status = 'FAILED';     // once data has been lost, replacing disks cannot bring it back
    return { ...ev, rebuilding: this.r.disks.some((d) => d.status === 'REBUILDING'), dataLost: this.r.dataLost };
  }
  get status() { return this.evaluation().status; }
  get online() { return this.status !== 'FAILED'; }
  get usableBlocks() { return this.array.logicalBlocks; }
  get tolerance() { return tolerance(this.array); }
  /** Is the cell at (disk,row) readable? A rebuilding disk is readable only for rows it has already rebuilt. */
  _avail(disk, row) { const d = this.r.disks[disk]; return d.status === 'OK' || (d.status === 'REBUILDING' && row < d.progress); }

  // Configuration --------------------------------------------------------------------------------
  configure({ level, disks, capacity }) {
    const errs = [];
    if (!RAID_LEVELS[level]) errs.push('Choose a RAID level.');
    if (!Number.isInteger(capacity) || capacity < MIN_CAPACITY || capacity > MAX_CAPACITY) errs.push(`Disk capacity must be a whole number of blocks from ${MIN_CAPACITY} to ${MAX_CAPACITY}.`);
    if (RAID_LEVELS[level]) { const e = checkDisks(level, disks); if (e) errs.push(e); }
    if (errs.length) throw new Error(errs.join(' '));
    if (this.status !== 'OPTIMAL') throw new Error(`The array is ${this.status}: replace and rebuild the failed disks (or re-create the array) before changing its configuration.`);
    const next = buildArray(level, disks, capacity), used = this.allocatedBlocks().reduce((a, b) => Math.max(a, b + 1), 0);
    if (next.logicalBlocks < used) throw new Error(`The backing store already uses ${used} block(s); this configuration only offers ${next.logicalBlocks} usable block(s). Choose more or larger disks.`);
    this._init({ level, disks, capacity }, { swap: this.r.swap, lost: this.r.lost });
    this.engine.log('RAID_CONFIGURED', `${RAID_LEVELS[level].label}: ${disks} disks x ${capacity} blocks → ${next.logicalBlocks} usable blocks (${next.logicalBlocks * this.blockKB} KB of backing store)`);
    this.engine.bus.emit('STATE_CHANGED');
  }

  // Failure, replacement, rebuild ------------------------------------------------------------
  _disk(d) { if (!Number.isInteger(d) || d < 0 || d >= this.r.disks.length) throw new Error(`There is no disk ${d + 1}.`); return this.r.disks[d]; }

  failDisk(d) {
    const disk = this._disk(d);
    if (disk.status === 'FAILED') throw new Error(`Disk ${d + 1} has already failed.`);
    const before = this.status;
    disk.status = 'FAILED'; disk.progress = 0;
    this.r.store[d] = this.r.store[d].map(() => null);     // the contents are gone
    this.r.stats.failures++;
    const ev = this.evaluation();
    if (ev.status === 'FAILED') this.r.dataLost = true;
    this.engine.log('RAID_DISK_FAILED', `Disk ${d + 1} failed → array ${ev.status}` + (ev.status === 'FAILED' ? ` (${ev.groups.filter((g) => g.state === 'FAILED').map((g) => g.name).join('; ')} lost more than ${RAID_LEVELS[this.r.config.level].label} can tolerate; data lost)` : before !== ev.status ? ' (still readable: missing blocks are rebuilt from the surviving disks)' : ''));
    this.engine.bus.emit('STATE_CHANGED');
    return ev;
  }

  /** Put a blank replacement disk in and start rebuilding it (progress follows the simulation clock). */
  replaceDisk(d) {
    const disk = this._disk(d);
    if (disk.status !== 'FAILED') throw new Error(`Disk ${d + 1} has not failed.`);
    if (this.r.dataLost) throw new Error('The array has lost data: a replacement disk cannot be rebuilt. Re-create the array instead.');
    disk.status = 'REBUILDING'; disk.progress = 0;
    this.engine.log('RAID_REBUILD_STARTED', `Disk ${d + 1} replaced; rebuilding from the surviving disks (${this.array.rows} rows, ${REBUILD_ROWS_PER_TICK} per tick)`);
    this.engine.bus.emit('STATE_CHANGED');
  }

  _rebuildRow(d, row) {
    const missing = new Set(this.r.disks.flatMap((x, i) => (x.status === 'OK' || (x.status === 'REBUILDING' && row < x.progress) ? [] : [i])));
    const stripe = this.array.stripes[row].find((s) => s.members.some((m) => m.disk === d));
    const rec = recoverStripe(stripe, (x) => this.r.store[x][row], missing);
    if (!rec) throw new Error(`Row ${row + 1} of disk ${d + 1} cannot be recovered.`);
    this.r.store[d][row] = rec.get(d);
  }

  _rebuildStep(rows) {
    let done = false;
    this.r.disks.forEach((disk, d) => {
      if (disk.status !== 'REBUILDING') return;
      for (let k = 0; k < rows && disk.progress < this.array.rows; k++) { this._rebuildRow(d, disk.progress); disk.progress++; }
      if (disk.progress >= this.array.rows) {
        disk.status = 'OK'; disk.progress = 0; this.r.stats.rebuilds++; done = true;
        const ok = this.r.store[d].every((v, row) => v === this.array.cells[row][d].value);
        this.engine.log('RAID_REBUILD_COMPLETE', `Disk ${d + 1} rebuilt (${this.array.rows} blocks recomputed from parity/mirror data, contents ${ok ? 'verified identical to the original' : 'MISMATCH'}) → array ${this.status}`);
      }
    });
    return done;
  }
  onTick() { if (this.r.disks.some((d) => d.status === 'REBUILDING')) this._rebuildStep(REBUILD_ROWS_PER_TICK); }
  /** Finish all running rebuilds immediately (the clock normally drives them). */
  completeRebuild() {
    if (!this.r.disks.some((d) => d.status === 'REBUILDING')) throw new Error('No disk is being rebuilt.');
    this._rebuildStep(this.array.rows);
    this.engine.bus.emit('STATE_CHANGED');
  }

  /** After data loss: format a fresh array with the same configuration. Everything that was stored in it is gone. */
  reinitialise() {
    if (!this.r.dataLost) throw new Error('The array has not lost data; replace the failed disk(s) and rebuild instead.');
    const lost = this.allocatedBlocks();
    this._init({ ...this.r.config }, { swap: this.r.swap, lost });
    this.engine.log('RAID_RECREATED', `Array re-created with new disks; ${lost.length} backing-store block(s) were lost. Processes that need those pages will abort.`);
    this.engine.bus.emit('STATE_CHANGED');
  }

  // Backing store (swap) allocation ---------------------------------------------------------------
  allocatedBlocks() { return Object.values(this.r.swap).flat().sort((a, b) => a - b); }
  allocate(pid, pages) {
    const used = new Set(this.allocatedBlocks()), blocks = [];
    for (let lb = 0; lb < this.usableBlocks && blocks.length < pages; lb++) if (!used.has(lb)) blocks.push(lb);
    if (blocks.length < pages) throw new Error(`The array has only ${this.usableBlocks - used.size} free block(s); ${pages} needed.`);
    this.r.swap[pid] = blocks;
    return blocks;
  }
  release(pid) {
    const blocks = this.r.swap[pid];
    if (!blocks) return;
    delete this.r.swap[pid];
    this.r.lost = this.r.lost.filter((b) => !blocks.includes(b));
  }
  /** lb -> { pid, page } for every allocated block. */
  owners() { const o = {}; for (const [pid, bl] of Object.entries(this.r.swap)) bl.forEach((lb, page) => { o[lb] = { pid, page }; }); return o; }

  // Reading -----------------------------------------------------------------------------------------
  /** How a read of logical block `lb` would be served right now (no side effects). */
  plan(lb) {
    const a = this.array, L = a.logical[lb];
    if (!L) return { ok: false, lb, reason: `block ${lb} does not exist` };
    const label = a.cells[L.row][L.disks[0]].label;
    if (this.r.lost.includes(lb)) return { ok: false, lb, label, reason: 'the block was lost when the array was re-created' };
    if (!this.online) return { ok: false, lb, label, reason: `the array is ${this.status} (offline)` };
    const normal = normalIOs(a, lb), stripe = a.stripes[L.row][L.gi];
    const up = (d) => this._avail(d, L.row), direct = (reads, disk) => ({ ok: true, lb, label, row: L.row, disk, reconstructed: false, ios: reads.length, reads, extraTicks: 0 });
    if (stripe.type === 'mirror') {                      // read any readable copy (spread over the copies)
      const pool = L.disks.filter(up);
      if (!pool.length) return { ok: false, lb, label, reason: 'every copy of the block is lost' };
      const copy = pool[lb % pool.length];
      return direct([copy], copy);
    }
    if (L.disks.every(up)) return direct(L.span ? L.disks : [L.disks[0]], L.disks[0]);
    const alive = stripe.members.filter((x) => up(x.disk)), failedDisk = L.disks.find((d) => !up(d));
    if (stripe.members.length - alive.length > stripe.tolerance) return { ok: false, lb, label, reason: 'too many disks of its stripe are lost' };
    // Rebuild the missing block from the surviving blocks of the stripe. RAID 2/3 need only the other data
    // slices (already read by a normal access) plus one parity/ECC slice; the others read every survivor.
    let reads = alive.map((x) => x.disk);
    if (L.span) {
      const m = stripe.members.find((x) => x.disk === failedDisk);
      const par = stripe.type === 'hamming' ? stripe.members.find((x) => x.pos === (m.pos & -m.pos)) : stripe.members.find((x) => x.kind === 'parity');
      reads = [...L.disks.filter(up), par.disk];
    }
    return { ok: true, lb, label, row: L.row, disk: failedDisk, reconstructed: true, ios: reads.length, reads, extraTicks: Math.max(0, reads.length - normal) };
  }

  /** A page-in: the block of (pid, page) is read from the array. Updates statistics and per-disk I/O counters. */
  readPage(pid, page) {
    const lb = this.r.swap[pid]?.[page];
    if (lb === undefined) return { ok: true, lb: null, reconstructed: false, ios: 0, extraTicks: 0, noBlock: true };
    const p = this.plan(lb), s = this.r.stats;
    s.reads++;
    if (!p.ok) { s.ioErrors++; return p; }
    p.reads.forEach((d) => { this.r.disks[d].reads++; });
    if (p.reconstructed) { s.reconstructed++; s.extraTicks += p.extraTicks; this.engine.log('RAID_RECONSTRUCT', `${pid} page ${page} → block ${p.label} lives on failed Disk ${p.disk + 1}: rebuilt from ${p.reads.length} surviving block(s) on disk(s) ${p.reads.map((d) => d + 1).join(', ')} (+${p.extraTicks} tick(s))`, { pid }); }
    else s.direct++;
    return p;
  }

  // Analysis -----------------------------------------------------------------------------------------
  /** Effect of the current failures on the data: how many blocks are readable directly, rebuilt on the fly, or lost. */
  impact() {
    let direct = 0, reconstructed = 0, unreadable = 0;
    for (let lb = 0; lb < this.usableBlocks; lb++) { const p = this.plan(lb); if (!p.ok) unreadable++; else if (p.reconstructed) reconstructed++; else direct++; }
    const total = this.usableBlocks;
    return { total, direct, reconstructed, unreadable, availability: total ? +((100 * (total - unreadable)) / total).toFixed(1) : 0 };
  }

  /**
   * Prove the redundancy works: for every row, recompute the contents of the unavailable disks from the
   * surviving ones (XOR / Reed-Solomon / Hamming / mirror) and compare with what the disks originally held.
   */
  verifyRecovery() {
    let checked = 0, matched = 0, unrecoverable = 0;
    for (let row = 0; row < this.array.rows; row++) {
      const missing = new Set([...this.unavailable()].filter((d) => !this._avail(d, row)));
      if (!missing.size) continue;
      for (const stripe of this.array.stripes[row]) {
        const gone = new Set([...missing].filter((d) => stripe.members.some((m) => m.disk === d)));
        if (!gone.size) continue;
        const rec = recoverStripe(stripe, (x) => this.r.store[x][row], gone);
        if (!rec || this.r.dataLost) { unrecoverable += gone.size; continue; }
        for (const [d, v] of rec) { checked++; if (v === this.array.cells[row][d].value) matched++; }
      }
    }
    return { checked, matched, unrecoverable };
  }

  /** Healthy disks whose failure would, right now, take the whole array down (location-aware). */
  criticalDisks() {
    if (this.status === 'FAILED') return [];
    const down = this.unavailable();
    return this.r.disks.map((_, d) => d).filter((d) => !down.has(d) && evaluate(this.array, new Set([...down, d])).status === 'FAILED');
  }
  labelOf(lb) { const L = this.array.logical[lb]; return L ? this.array.cells[L.row][L.disks[0]].label : '?'; }

  stats() {
    const ev = this.evaluation(), c = this.r.config, t = this.tolerance;
    return {
      level: c.level, label: RAID_LEVELS[c.level].label, disks: c.disks, capacity: c.capacity,
      status: ev.status, rebuilding: ev.rebuilding, usableBlocks: this.usableBlocks, usableKB: this.usableBlocks * this.blockKB,
      rawKB: c.disks * c.capacity * this.blockKB, allocated: this.allocatedBlocks().length,
      guaranteed: t.guaranteed, best: t.best, ...this.r.stats,
    };
  }
}
