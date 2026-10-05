/** Publish/subscribe bus. Subscribe to '*' to receive every event. */
export class EventBus {
  constructor() { this.handlers = new Map(); }
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) { this.handlers.get(type)?.delete(fn); }
  emit(type, payload = {}) {
    const evt = { type, ...payload };
    for (const key of [type, '*']) {
      for (const fn of [...(this.handlers.get(key) || [])]) fn(evt);
    }
    return evt;
  }
}
