import { buildFrames } from '../simulation/SimulationState.js';

/**
 * Physical memory with paging.
 *   state.memory.frames[i] = { pid, page, loadedAt, usedAt }   (pid === null -> frame is free)
 *   state.memory.tables[pid][page] = frame index, or null when the page is not in memory
 * Every process gets a page table when it is admitted; frames are handed out one page at a time by the
 * VirtualMemory manager (demand paging), so a process never needs contiguous memory.
 * Units are KB. Address translation: page = floor(addr / pageSize), offset = addr mod pageSize,
 * physical = frame * pageSize + offset.
 */
export class MemoryManager {
  constructor(engine) {
    this.name = 'memory';
    this.engine = engine;
    engine.bus.on('PROCESS_TERMINATED', (e) => this.release(e.pid));
    engine.bus.on('PROCESS_REMOVED', (e) => this.release(e.pid));
  }
  get state() { return this.engine.state; }
  get mem() { return this.state.memory; }
  get frames() { return this.mem.frames; }
  get pageSize() { return this.state.config.pageSize; }

  table(pid) { return this.mem.tables[pid] || null; }
  hasTable(pid) { return pid in this.mem.tables; }
  createTable(pid, pages) {
    if (this.hasTable(pid)) throw new Error(`${pid} already has a page table.`);
    this.mem.tables[pid] = Array(pages).fill(null);
    return this.mem.tables[pid];
  }

  /** Lowest-numbered free frame, or -1. */
  freeFrame() { return this.frames.findIndex((f) => f.pid === null); }
  residentPages(pid) { return (this.table(pid) || []).filter((f) => f !== null).length; }
  /** Pages of address space handed out so far (used by the virtual memory manager for capacity). */
  allocatedPages() { return Object.values(this.mem.tables).reduce((a, t) => a + t.length, 0); }

  /** Load `page` of `pid` into `frame` (the frame must be free). */
  map(pid, page, frame) {
    const t = this.table(pid);
    if (!t || page < 0 || page >= t.length) throw new Error(`${pid} has no page ${page}.`);
    if (this.frames[frame].pid !== null) throw new Error(`Frame ${frame} is not free.`);
    const at = ++this.mem.seq;
    this.frames[frame] = { pid, page, loadedAt: at, usedAt: at, dirty: false };
    t[page] = frame;
  }
  /** Evict whatever is in `frame`; returns { pid, page } (or null if it was free). */
  unmap(frame) {
    const f = this.frames[frame];
    if (f.pid === null) return null;
    const victim = { pid: f.pid, page: f.page, dirty: !!f.dirty };
    const t = this.table(f.pid);
    if (t) t[f.page] = null;
    this.frames[frame] = { pid: null, page: null, loadedAt: -1, usedAt: -1, dirty: false };
    return victim;
  }
  touch(frame) { this.frames[frame].usedAt = ++this.mem.seq; }
  /** The page in `frame` has been modified (a store instruction): it must be written back when evicted. */
  markDirty(frame) { this.frames[frame].dirty = true; }

  /** Free every frame and the page table of a process. */
  release(pid) {
    const t = this.table(pid);
    if (!t) return false;
    let freed = 0;
    this.frames.forEach((f, i) => { if (f.pid === pid) { this.unmap(i); freed++; } });
    delete this.mem.tables[pid];
    this.engine.log('MEMORY_RELEASED', `${pid} released ${freed} frame(s) and its page table (${t.length} page(s))`, { pid });
    return true;
  }

  /** logical address -> (page, offset) -> page table -> frame -> physical address. Inspection only: it never loads a page. */
  translate(pid, address) {
    const p = this.state.processes.find((x) => x.pid === pid);
    const t = this.table(pid);
    if (!p || !t) throw new Error('Select a process that has a page table first.');
    if (!Number.isInteger(address) || address < 0 || address >= p.memoryRequired)
      throw new Error(`Logical address must be a whole number from 0 to ${p.memoryRequired - 1}.`);
    const ps = this.pageSize, page = Math.floor(address / ps), offset = address % ps, frame = t[page];
    const resident = frame !== null;
    const physical = resident ? frame * ps + offset : null;
    this.engine.log('ADDRESS_TRANSLATED', resident
      ? `${pid}: logical ${address} → page ${page}, offset ${offset} → frame ${frame} → physical ${physical}`
      : `${pid}: logical ${address} → page ${page}, offset ${offset} → page not in memory (would cause a page fault)`, { pid });
    return { pid, address, page, offset, frame, physical, resident };
  }

  configure(patch) {
    const c = this.state.config, errs = [];
    const ms = 'memorySize' in patch ? patch.memorySize : c.memorySize;
    const ps = 'pageSize' in patch ? patch.pageSize : c.pageSize;
    const whole = (n) => Number.isInteger(n) && n > 0;
    if (!whole(ms) || !whole(ps)) errs.push('Physical memory and page size must be whole numbers greater than zero.');
    else {
      if (ps > ms || ms % ps) errs.push('Physical memory must be a whole multiple of the page size.');
      else if (ms / ps > 256) errs.push('At most 256 frames are supported.');
      if (ms > c.virtualMemorySize) errs.push(`Physical memory cannot exceed the virtual memory size (${c.virtualMemorySize} KB).`);
      if (c.virtualMemorySize % ps) errs.push(`The virtual memory size (${c.virtualMemorySize} KB) must be a multiple of the page size.`);
      const changed = ms !== c.memorySize || ps !== c.pageSize;
      if (changed && this.frames.some((f) => f.pid !== null)) errs.push('Physical memory and page size can only change while no pages are loaded (terminate the processes or reset first).');
      if (ps !== c.pageSize && this.state.processes.some((p) => p.state !== 'TERMINATED'))
        errs.push('Page size can only change while no live processes exist, because processes are divided into pages when they are created.');
    }
    if (errs.length) throw new Error(errs.join(' '));
    const rebuild = ms !== c.memorySize || ps !== c.pageSize;
    this.engine.updateConfig({ memorySize: ms, pageSize: ps });
    if (rebuild) this.mem.frames = buildFrames(ms, ps);
  }

  stats() {
    const ps = this.pageSize, frames = this.frames, total = frames.length;
    const used = frames.filter((f) => f.pid !== null).length;
    const live = this.state.processes.filter((p) => this.hasTable(p.pid));
    return {
      frames: total, used, free: total - used, pageSize: ps, memorySize: this.state.config.memorySize,
      utilisation: total ? +((100 * used) / total).toFixed(1) : 0,
      // the last page of a process is rarely full: the unused part of it is wasted
      internalFragmentation: live.reduce((a, p) => a + p.pages * ps - p.memoryRequired, 0),
    };
  }
}
