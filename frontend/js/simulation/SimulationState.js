/**
 * Single source of truth for the whole simulation.
 * Units: memory sizes are in KB. Physical memory is divided into frames of `pageSize` KB;
 * every process is divided into pages of the same size.
 */
export const DEFAULT_CONFIG = {
  memorySize: 32,            // physical memory (KB) -> memorySize / pageSize frames
  pageSize: 4,               // KB per page / frame
  virtualMemorySize: 128,    // backing store (KB): the total address space all live processes may use
  replacementAlgorithm: 'FIFO',
  pageFaultTime: 2,          // ticks a process is blocked while a missing page is read from the backing store
  diskSize: 200,
  schedulingAlgorithm: 'FCFS',
  timeQuantum: 4,
};
export const SPEEDS = [0.5, 1, 2, 5, 10];

export const buildFrames = (memorySize, pageSize) =>
  Array.from({ length: Math.floor(memorySize / pageSize) }, () => ({ pid: null, page: null, loadedAt: -1, usedAt: -1, dirty: false }));

export function createInitialState(config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  return {
    clock: 0,
    status: 'STOPPED', // STOPPED | RUNNING | PAUSED
    speed: 1,
    nextPid: 1,
    processes: [],
    readyQueue: [], // PIDs in READY order
    cpu: null,      // the single CPU (created by the Scheduler)
    gantt: [],      // { pid|null, start, end }
    // Physical memory: frames[i] = { pid, page, loadedAt, usedAt }; tables[pid][page] = frame index | null (null = not in memory)
    memory: { frames: buildFrames(cfg.memorySize, cfg.pageSize), tables: {}, seq: 0 },
    // Virtual memory: demand paging bookkeeping + the stand-alone page replacement lab
    virtualMemory: {
      waiting: [],                                   // PIDs waiting for backing-store space
      counters: { faults: 0, hits: 0, replacements: 0, writebacks: 0, pagesIn: 0, pagesOut: 0 },   // pagesIn/pagesOut = pages swapped in from / out to secondary storage
      refSeq: 0,                                     // sequence number of the last page reference (the visualisation follows it)
      trace: [],                                     // recent page references of the running system
      lab: { refString: '', refs: [], labels: null, frames: 3, algorithm: 'FIFO', result: null },
    },
    raid: null,     // created by the RaidManager (disk array that holds the backing store)
    events: [],
    config: cfg,
  };
}
