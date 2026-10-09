/**
 * Dashboard metrics, grouped by subsystem: CPU, Memory, Virtual Memory and RAID.
 *
 * Nothing is stored here. Every counter lives in the single simulation state and is incremented where the thing
 * happens (the scheduler, the virtual memory manager, the RAID manager), so a reset of the simulation - which
 * replaces that state - sets every counter back to zero. `snapshot()` reads them and derives the percentages.
 *
 * The dashboard is redrawn on every STATE_CHANGED event of the EventBus, which the engine emits on each tick of the
 * simulation clock and whenever something changes (page fault, disk failure, manual page request ...), so the numbers
 * follow the simulation in real time. `onUpdate(fn)` lets any other view subscribe to the same stream.
 */
const pct = (num, den, digits = 1) => (den ? +((100 * num) / den).toFixed(digits) : 0);

export class Metrics {
  constructor(engine, { sched, mm, vm, raid }) {
    Object.assign(this, { engine, sched, mm, vm, raid });
  }

  /** Call `fn(snapshot)` whenever the simulation state changes (every tick and every event). Returns an unsubscribe function. */
  onUpdate(fn) { return this.engine.bus.on('STATE_CHANGED', () => fn(this.snapshot())); }

  snapshot() {
    const s = this.engine.state, cpu = this.sched.stats(), mem = this.mm.stats(), v = this.vm.stats(), r = this.raid.stats();
    const refs = v.faults + v.hits;
    const live = s.processes.filter((p) => this.mm.hasTable(p.pid));
    const allocated = live.reduce((a, p) => a + p.pages, 0);
    const inRam = mem.used;
    return {
      time: s.clock,
      cpu: {
        utilisation: cpu.cpuUtilisation,             // % of the elapsed ticks in which the CPU executed an instruction
        avgWaiting: cpu.avgWaiting, avgTurnaround: cpu.avgTurnaround, avgResponse: cpu.avgResponse,
        completed: cpu.completed,                    // the three averages are taken over the completed processes
      },
      memory: {
        pageFaults: v.faults, pageHits: v.hits, references: refs,
        faultRate: pct(v.faults, refs), hitRate: pct(v.hits, refs),
        replacements: v.replacements,
        utilisation: mem.utilisation, framesUsed: mem.used, frames: mem.frames,
      },
      virtualMemory: {
        pagesInRam: inRam,
        pagesOnSecondary: Math.max(0, allocated - inRam),   // pages that exist but are not in a frame (they live on the disk array)
        transfers: v.pagesIn + v.pagesOut, swappedIn: v.pagesIn, swappedOut: v.pagesOut,
        replacements: v.replacements,
      },
      raid: {
        reads: r.reads, writes: r.writes,
        failedDisks: r.failedDisks, rebuildingDisks: r.rebuildingDisks, disks: r.disks,
        recoveryOps: r.reconstructed + r.rebuilds, reconstructedReads: r.reconstructed, rebuilds: r.rebuilds,
        storageUtilisation: pct(r.allocated, r.usableBlocks), blocksUsed: r.allocated, blocksTotal: r.usableBlocks,
        performance: this.raid.estimatedPerformance(), status: r.status, label: r.label,
      },
    };
  }
}
