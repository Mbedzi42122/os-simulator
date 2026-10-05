/** A simulated CPU core. Holds only execution bookkeeping; the Scheduler drives it. */
export class CPU {
  constructor(id) {
    this.id = id;
    this.current = null; // PID of running process
    this.state = 'IDLE'; // IDLE | RUNNING
    this.busyTime = 0;
    this.idleTime = 0;
    this.quantumLeft = 0;
  }
  get executionTime() { return this.busyTime; }
  get utilisation() {
    const total = this.busyTime + this.idleTime;
    return total ? Math.round((100 * this.busyTime) / total) : 0;
  }
  assign(pid, quantum) { this.current = pid; this.state = 'RUNNING'; this.quantumLeft = quantum; }
  release() { this.current = null; this.state = 'IDLE'; this.quantumLeft = 0; }
}
