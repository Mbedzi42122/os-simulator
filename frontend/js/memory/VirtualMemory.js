export const REPLACEMENT_ALGORITHMS = {
  FIFO: { label: 'FIFO', description: 'Evict the page that has been in memory the longest. Simple, but can suffer Belady\'s anomaly (more frames → more faults).' },
  LRU: { label: 'LRU', description: 'Evict the page that has not been used for the longest time. Good approximation of the optimal policy.' },
  OPTIMAL: { label: 'Optimal', description: 'Evict the page whose next use is farthest in the future. Needs knowledge of the future, so it is a benchmark rather than a real policy.' },
};
/** Policies that can run on the live system (Optimal needs the future, so it is only available in the lab). */
export const LIVE_ALGORITHMS = ['FIFO', 'LRU'];

export function parseReferenceString(text) {
  const parts = String(text ?? '').split(/[\s,]+/).filter(Boolean);
  if (!parts.length) throw new Error('Enter a page reference string, e.g. 1 2 3 4 1 2 5 1.');
  if (parts.length > 100) throw new Error('Reference string is limited to 100 references.');
  return parts.map((x) => {
    if (!/^\d+$/.test(x)) throw new Error(`"${x}" is not a valid page number (use non-negative whole numbers).`);
    return Number(x);
  });
}

/** Pure simulation. Frames are fixed slots; a replacement overwrites the victim's slot. */
export function simulateReplacement(refs, frameCount, algorithm) {
  if (!REPLACEMENT_ALGORITHMS[algorithm]) throw new Error('Unknown page replacement algorithm.');
  const frames = Array(frameCount).fill(null), loadedAt = Array(frameCount).fill(-1), usedAt = Array(frameCount).fill(-1);
  const steps = [];
  let faults = 0;
  const victim = (i) => {
    const slots = frames.map((_, s) => s);
    const best = (score) => slots.reduce((b, s) => (score(s) > score(b) ? s : b), 0); // ties → lowest slot
    if (algorithm === 'FIFO') return best((s) => -loadedAt[s]);
    if (algorithm === 'LRU') return best((s) => -usedAt[s]);
    return best((s) => { const n = refs.indexOf(frames[s], i + 1); return n < 0 ? Infinity : n; });
  };
  refs.forEach((page, i) => {
    let slot = frames.indexOf(page), evicted = null;
    const fault = slot < 0;
    if (fault) {
      faults++;
      slot = frames.indexOf(null);
      if (slot < 0) { slot = victim(i); evicted = frames[slot]; }
      frames[slot] = page; loadedAt[slot] = i;
    }
    usedAt[slot] = i;
    steps.push({ ref: page, fault, slot: fault ? slot : null, evicted, frames: [...frames] });
  });
  const hits = refs.length - faults;
  return { algorithm, frameCount, steps, faults, hits,
    hitRatio: +(hits / refs.length).toFixed(3), faultRatio: +(faults / refs.length).toFixed(3) };
}

const TRACE_LIMIT = 400;
/** Deterministic per-process random number in [0, 1) (mulberry32). */
function rand(p) {
  p.rng = (p.rng + 0x6d2b79f5) >>> 0;
  let t = p.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Demand paging on top of the MemoryManager (frames + page tables).
 *  - The backing store (config.virtualMemorySize) bounds the total address space of all live processes.
 *    A process is admitted (page table created, nothing loaded) only if its pages fit.
 *  - Every executed instruction references one page of the process (reference stream with locality).
 *    A reference to a page that is not in a frame is a PAGE FAULT: the page is brought into a free frame,
 *    or, if none is free, a victim chosen by the replacement algorithm (FIFO / LRU, global scope) is evicted.
 *  - The faulting process blocks (WAITING) for config.pageFaultTime ticks (the Scheduler does this) and
 *    retries the same reference afterwards.
 *  - Optional RaidManager: the backing store is a RAID array. The address space is limited by the array's usable
 *    capacity, every page owns one logical block of it, and a page-in is a read of that block: a degraded array
 *    adds reconstruction ticks to the fault service time, and an unreadable block aborts the process.
 */
export class VirtualMemory {
  constructor(engine, pm, mm, raid = null) {
    this.name = 'virtualMemory';
    this.engine = engine;
    this.pm = pm;
    this.mm = mm;
    this.raid = raid;
    pm.limitProvider = () => this.capacityPages * this.state.config.pageSize; // a process cannot be bigger than the backing store
    pm.admissionGate = (p) => this.ensureAllocated(p); // a process can only become READY once it has an address space
    engine.bus.on('PROCESS_CREATED', (e) => { const p = pm.get(e.pid); if (p) this.ensureAllocated(p); });
    engine.bus.on('PROCESS_TERMINATED', (e) => this._forget(e.pid));
    engine.bus.on('PROCESS_REMOVED', (e) => this._forget(e.pid));
  }
  get state() { return this.engine.state; }
  get vm() { return this.state.virtualMemory; }
  get lab() { return this.vm.lab; }
  get capacityPages() {
    const pages = Math.floor(this.state.config.virtualMemorySize / this.state.config.pageSize);
    return this.raid ? Math.min(pages, this.raid.usableBlocks) : pages;   // the array is the backing store
  }
  _forget(pid) { this.vm.waiting = this.vm.waiting.filter((x) => x !== pid); }

  // Address-space admission -----------------------------------------------------
  ensureAllocated(p) {
    if (this.mm.hasTable(p.pid)) return true;
    if (p.state === 'TERMINATED') return false;
    if (this.raid && !this.raid.online) {
      if (!this.vm.waiting.includes(p.pid)) {
        this.vm.waiting.push(p.pid);
        this.engine.log('VIRTUAL_MEMORY_FULL', `${p.pid} cannot get an address space: the RAID backing store is ${this.raid.status} (offline)`, { pid: p.pid });
      }
      return false;
    }
    const free = this.capacityPages - this.mm.allocatedPages();
    if (p.pages > free) {
      if (!this.vm.waiting.includes(p.pid)) {
        this.vm.waiting.push(p.pid);
        this.engine.log('VIRTUAL_MEMORY_FULL', `${p.pid} needs ${p.pages} page(s) of virtual memory but only ${free} are free`, { pid: p.pid });
      }
      return false;
    }
    this.mm.createTable(p.pid, p.pages);
    const blocks = this.raid ? this.raid.allocate(p.pid, p.pages) : null;
    this._forget(p.pid);
    this.engine.log('VIRTUAL_ALLOCATED', `${p.pid} (${p.memoryRequired} KB) divided into ${p.pages} page(s); page table created, no page loaded yet${blocks ? `; backing store: ${blocks.length} block(s) on the ${this.raid.stats().label} array` : ''}`, { pid: p.pid });
    return true;
  }

  // Demand paging -----------------------------------------------------------------
  /** Next page the process touches: mostly the same page, often the next one, sometimes a jump. */
  nextPage(p) {
    const r = rand(p);
    if (r < 0.6) return p.lastPage;
    if (r < 0.85) return (p.lastPage = (p.lastPage + 1) % p.pages);
    return (p.lastPage = Math.floor(rand(p) * p.pages));
  }

  _victim() {
    const key = this.state.config.replacementAlgorithm === 'LRU' ? 'usedAt' : 'loadedAt';
    let best = 0;
    this.mm.frames.forEach((f, i) => { if (f[key] < this.mm.frames[best][key]) best = i; }); // ties → lowest frame
    return best;
  }
  /** What the replacement algorithm looked at: every frame with the number it compares (smallest wins). */
  _selection(chosen) {
    const key = this.state.config.replacementAlgorithm === 'LRU' ? 'usedAt' : 'loadedAt';
    return { frame: chosen, policy: this.state.config.replacementAlgorithm, keyName: key === 'usedAt' ? 'last used' : 'loaded',
      candidates: this.mm.frames.map((f, i) => ({ frame: i, pid: f.pid, page: f.page, key: f[key] })) };
  }

  /** Deterministic pseudo-random facts about an instruction (does not touch the process's random stream). */
  _instruction(p) {
    const instr = p.cpuTimeUsed + 1, bytes = this.state.config.pageSize * 1024;
    const h = Math.imul((instr * 2654435761) ^ (parseInt(p.pid.slice(1), 10) * 40503), 2246822519) >>> 0;
    return { instr, offset: h % bytes, write: (h >>> 8) % 4 === 0 };   // about one instruction in four is a store
  }

  _record(entry) {
    this.vm.trace.push({ seq: ++this.vm.refSeq, time: this.state.clock, ...entry });
    if (this.vm.trace.length > TRACE_LIMIT) this.vm.trace.shift();
  }

  /**
   * The running process executes an instruction that references one of its pages.
   * Returns { fault, page, frame, evicted }. On a fault the page is loaded immediately (a frame is reserved),
   * and p.pendingPage remembers the reference so it is retried when the process wakes up.
   */
  reference(p, forcePage = null) {
    const retry = forcePage === null && p.pendingPage !== null;
    const page = forcePage !== null ? forcePage : retry ? p.pendingPage : this.nextPage(p);
    const ins = { ...this._instruction(p), manual: forcePage !== null };
    const table = this.mm.table(p.pid);
    if (!table) throw new Error(`${p.pid} has no page table.`);
    const c = this.vm.counters;
    if (table[page] !== null) {                       // page is in a frame: hit
      this.mm.touch(table[page]);
      p.pendingPage = null;
      if (!retry) {
        c.hits++; p.pageHits++;
        if (ins.write) this.mm.markDirty(table[page]);
        this._record({ pid: p.pid, page, fault: false, frame: table[page], evicted: null, ...ins });
      }
      return { fault: false, page, frame: table[page], evicted: null };
    }
    c.faults++; p.pageFaults++; p.pendingPage = page; // page fault
    const io = this.raid ? this.raid.readPage(p.pid, page) : null;   // read the page from the backing store (RAID)
    if (io && !io.ok) {                                              // unreadable: nothing is loaded, nobody is evicted
      p.pendingPage = null;
      this.engine.log('PAGE_IO_ERROR', `${p.pid} page ${page}: backing-store read failed (${io.reason})`, { pid: p.pid });
      this._record({ pid: p.pid, page, fault: true, frame: null, evicted: null, ioError: true, io, ...ins });
      return { fault: true, ioError: true, page, frame: null, evicted: null, io };
    }
    let frame = this.mm.freeFrame(), evicted = null, victim = null;
    if (frame < 0) {
      frame = this._victim();
      victim = this._selection(frame);
      evicted = this.mm.unmap(frame);
      c.replacements++;
      if (evicted.dirty) { c.writebacks++; this.engine.log('PAGE_WRITEBACK', `${evicted.pid} page ${evicted.page} was modified: written back to the backing store before its frame is reused`, { pid: evicted.pid }); }
      this.engine.log('PAGE_REPLACED', `${this.state.config.replacementAlgorithm}: ${evicted.pid} page ${evicted.page} evicted from frame ${frame}`, { pid: evicted.pid });
    }
    this.mm.map(p.pid, page, frame);
    if (ins.write) this.mm.markDirty(frame);              // the instruction that faulted is a store: the page will be modified
    this.engine.log('PAGE_FAULT', `${p.pid} page ${page} not in memory → loaded into frame ${frame}${evicted ? ` (replaced ${evicted.pid}:p${evicted.page})` : ''}`, { pid: p.pid });
    const serviceTime = this.state.config.pageFaultTime + (io?.extraTicks || 0);
    this._record({ pid: p.pid, page, fault: true, frame, evicted, victim, disk: io && io.lb !== null ? io.disk : null, reconstructed: !!io?.reconstructed, io, serviceTime, ...ins });
    return { fault: true, page, frame, evicted, io, serviceTime };
  }

  /**
   * Manual "what-if" request made from the visualisation: the CPU touches `page` of `pid` once. It goes through the
   * same path as a real instruction (hit, or page fault + replacement + backing-store read) but never blocks or kills
   * the process. Returns the trace record.
   */
  requestPage(pid, page) {
    const p = this.pm.get(pid), t = this.mm.table(pid);
    if (!p || !t) throw new Error('Select a page of a process that has an address space.');
    if (!Number.isInteger(page) || page < 0 || page >= t.length) throw new Error(`${pid} has no page ${page}.`);
    if (p.pendingPage !== null) throw new Error(`${pid} is still waiting for a page fault to be served; wait until it is READY again.`);
    const r = this.reference(p, page);
    p.pendingPage = null;                                  // nothing to retry: the user's request is complete
    this.engine.log('MANUAL_PAGE_REQUEST', `Manual request: ${pid} page ${page} → ${r.ioError ? 'I/O error' : r.fault ? 'page fault' : 'hit'}`, { pid });
    this.engine.bus.emit('STATE_CHANGED');
    return this.vm.trace[this.vm.trace.length - 1];
  }

  configure(patch) {
    const c = this.state.config, errs = [];
    if ('replacementAlgorithm' in patch && !LIVE_ALGORITHMS.includes(patch.replacementAlgorithm)) errs.push('Choose FIFO or LRU (Optimal needs the future, so it is only available in the lab).');
    if ('pageFaultTime' in patch && !(Number.isInteger(patch.pageFaultTime) && patch.pageFaultTime >= 1 && patch.pageFaultTime <= 10)) errs.push('Page fault service time must be a whole number of ticks from 1 to 10.');
    if ('virtualMemorySize' in patch) {
      const n = patch.virtualMemorySize;
      if (!Number.isInteger(n) || n <= 0) errs.push('Virtual memory size must be a whole number greater than zero.');
      else {
        if (n % c.pageSize) errs.push(`Virtual memory size must be a multiple of the page size (${c.pageSize} KB).`);
        if (n < c.memorySize) errs.push(`Virtual memory cannot be smaller than physical memory (${c.memorySize} KB).`);
        const used = this.mm.allocatedPages() * c.pageSize;
        if (n < used) errs.push(`${used} KB of virtual memory is already in use.`);
      }
    }
    if (errs.length) throw new Error(errs.join(' '));
    this.engine.updateConfig(patch);
  }

  stats() {
    const c = this.vm.counters, refs = c.faults + c.hits, cap = this.capacityPages, used = this.mm.allocatedPages();
    return { ...c, references: refs, faultRate: refs ? +(c.faults / refs).toFixed(3) : 0,
      capacityPages: cap, usedPages: used, waiting: [...this.vm.waiting], raid: this.raid ? this.raid.stats() : null };
  }

  /** One row per process that has an address space. */
  processRows() {
    return this.state.processes.filter((p) => this.mm.hasTable(p.pid)).map((p) => ({
      pid: p.pid, name: p.name, pages: p.pages, resident: this.mm.residentPages(p.pid), faults: p.pageFaults, hits: p.pageHits,
      faultRate: p.pageFaults + p.pageHits ? +(p.pageFaults / (p.pageFaults + p.pageHits)).toFixed(2) : 0 }));
  }

  // Page replacement lab ------------------------------------------------------------
  run({ refString, frames, algorithm }) {
    const refs = parseReferenceString(refString);
    if (!Number.isInteger(frames) || frames < 1 || frames > 10) throw new Error('Number of frames must be a whole number from 1 to 10.');
    const result = simulateReplacement(refs, frames, algorithm);
    Object.assign(this.lab, { refString: String(refString).trim(), refs, labels: null, frames, algorithm, result });
    this.engine.log('PAGE_REPLACEMENT_RUN', `${algorithm}, ${frames} frames: ${result.faults} page faults, ${result.hits} hits`);
    return result;
  }

  /** Replay the most recent real page references (all processes) through the lab with the real number of frames. */
  runTrace(algorithm = 'FIFO', limit = 100) {
    const t = this.vm.trace.slice(-limit);
    if (!t.length) throw new Error('No page references recorded yet. Run the simulation with some processes first.');
    const labels = [], ids = new Map();
    const refs = t.map((x) => { const k = `${x.pid}:p${x.page}`; if (!ids.has(k)) { ids.set(k, labels.length); labels.push(k); } return ids.get(k); });
    const frames = this.mm.frames.length;
    const result = simulateReplacement(refs, frames, algorithm);
    Object.assign(this.lab, { refString: t.map((x) => `${x.pid}:p${x.page}`).join(' '), refs, labels, frames, algorithm, result });
    this.engine.log('PAGE_REPLACEMENT_RUN', `Live trace (${refs.length} references), ${algorithm}, ${frames} frames: ${result.faults} page faults, ${result.hits} hits`);
    return result;
  }
}
