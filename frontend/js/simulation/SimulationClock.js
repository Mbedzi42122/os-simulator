/** Discrete simulation clock. Time only moves via advance(). */
export class SimulationClock {
  constructor(state) { this.state = state; }
  get time() { return this.state.clock; }
  advance(n = 1) { this.state.clock += n; return this.state.clock; }
  reset() { this.state.clock = 0; }
  static format(t) {
    const p = (n) => String(Math.floor(n)).padStart(2, '0');
    return `${p(t / 3600)}:${p((t % 3600) / 60)}:${p(t % 60)}`;
  }
}
