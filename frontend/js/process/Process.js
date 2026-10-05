export const STATES = ['NEW', 'READY', 'RUNNING', 'WAITING', 'SUSPENDED', 'TERMINATED'];

/** Valid state transitions (process state diagram). */
export const TRANSITIONS = {
  NEW: ['READY', 'TERMINATED'],
  READY: ['RUNNING', 'SUSPENDED', 'TERMINATED'],
  RUNNING: ['READY', 'WAITING', 'TERMINATED'],
  WAITING: ['READY', 'SUSPENDED', 'TERMINATED'],
  SUSPENDED: ['READY', 'TERMINATED'],
  TERMINATED: [],
};

export class InvalidTransitionError extends Error {}
export class ValidationError extends Error {
  constructor(errors) { super(errors.join(' ')); this.errors = errors; }
}

export class Process {
  constructor({ pid, name, arrivalTime, burstTime, priority, memoryRequired, parentPid = null, creationTime, pages = 1, seed = 1 }) {
    this.pid = pid;
    this.name = name;
    this.arrivalTime = arrivalTime;
    this.burstTime = burstTime;
    this.remainingTime = burstTime;
    this.priority = priority;
    this.memoryRequired = memoryRequired; // KB of virtual address space
    this.pages = pages;                   // memoryRequired divided into pages
    this.state = 'NEW';
    this.parentPid = parentPid;
    this.cpuTimeUsed = 0;
    this.waitingTime = 0;
    this.turnaroundTime = 0;
    this.ioState = 'NONE';
    this.creationTime = creationTime;
    this.terminationTime = null;
    this.startTime = null; // first dispatch
    this.completionTime = null;
    // Demand paging bookkeeping (used by VirtualMemory)
    this.pageFaults = 0;
    this.pageHits = 0;
    this.pendingPage = null; // page being retried after a page fault
    this.wakeAt = null;      // clock value when the page-fault wait ends
    this.lastPage = 0;       // locality of the generated reference stream
    this.rng = seed >>> 0;   // per-process deterministic random stream
    this.abortReason = null; // set when the system kills the process (e.g. unreadable backing store)
  }
  canTransitionTo(next) { return TRANSITIONS[this.state].includes(next); }
}
