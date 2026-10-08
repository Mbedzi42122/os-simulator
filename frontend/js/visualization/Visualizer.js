import { SimulationClock } from '../simulation/SimulationClock.js';
/**
 * Visualization module: shows how a process, its virtual memory (pages kept in secondary memory), the page table,
 * main memory (frames) and the CPU interact - and animates pages moving between them.
 *
 * Design
 *  - The simulation core appends one record per memory reference to state.virtualMemory.trace (hit, page fault,
 *    victim chosen, backing-store read ...). The Visualizer turns each record into a sequence of STEPS (buildSteps,
 *    pure and unit-tested) and plays them one after another with arrows, highlights and flying page tokens.
 *  - The core applies a fault immediately, but the screen must tell the story in order. While a record is
 *    still queued the view therefore "masks" the live state: the frame still shows the old page, the page table row
 *    still says NOT PRESENT, until the step that performs that change has played.
 *  - The panels are redrawn from state; tokens and arrows live in overlay layers so redrawing never kills an animation.
 */

export const hex = (n, w = 4) => '0x' + Math.max(0, n).toString(16).toUpperCase().padStart(w, '0');
const key = (pid, page) => `${pid}:${page}`;

/** Ordered steps of one memory reference. `ms` is the nominal duration at 1x. */
export function buildSteps(rec) {
  const pg = `Page ${rec.page}`, S = (id, title, text, ms) => ({ id, title, text, ms });
  const steps = [
    S('request', `CPU requests ${pg}`, `${rec.pid} executes instruction #${rec.instr} (${rec.write ? 'a store' : 'a load'}) and needs ${pg}. The CPU sends the virtual address to the page table.`, rec.fault ? 800 : 500),
    S('lookup', 'Page table lookup', `The page number selects row ${rec.page} of ${rec.pid}'s page table; the offset is kept for later.`, rec.fault ? 800 : 500),
  ];
  if (!rec.fault) {
    steps.push(S('hit', 'Page is PRESENT', `${pg} → Frame ${rec.frame}. The frame number replaces the page number: the physical address is ready.`, 500),
      S('access', 'Memory access', `Frame ${rec.frame} is read in main memory and the data goes back to the CPU. No page fault.`, 450));
    return steps;
  }
  steps.push(S('fault', 'PAGE FAULT', `${pg} is NOT PRESENT in main memory (its page table entry says it is on disk). The CPU cannot continue: the operating system takes over.`, 1100));
  if (rec.ioError) {
    steps.push(S('io', 'Read from secondary memory', `The OS tries to read ${pg} from the backing store (RAID array)…`, 900),
      S('ioerror', 'I/O ERROR', `The block cannot be read: ${rec.io?.reason || 'backing store unavailable'}. Nothing is loaded and no victim is evicted.`, 1100));
    return steps;
  }
  if (rec.victim) {
    const v = rec.evicted;
    steps.push(S('victim', 'No free frame: select a victim', `Main memory is full. ${rec.victim.policy} compares the "${rec.victim.keyName}" ${rec.victim.pick === 'largest' ? 'of every frame (it looks ahead at the future references) and picks the page used farthest in the future, or never again:' : 'number of every frame and picks the smallest:'} Frame ${rec.victim.frame} (${v.pid} page ${v.page}).`, 1500),
      S('evict', `Evict ${v.pid} page ${v.page}`, `${v.pid} page ${v.page} leaves Frame ${rec.victim.frame} and goes back to secondary memory${v.dirty ? ' (it was MODIFIED, so it is written back to disk first)' : ' (unmodified: the disk copy is still valid, nothing to write)'}. Its page table entry becomes NOT PRESENT.`, 1200));
  }
  const where = rec.io && rec.io.lb !== null && rec.io.lb !== undefined ? ` Block ${rec.io.label} on Disk ${rec.io.disk + 1}${rec.io.reconstructed ? ' is on a failed disk: rebuilt from the surviving disks' : ''}.` : '';
  steps.push(
    S('io', 'Read from secondary memory', `${pg} of ${rec.pid} is read from the virtual-memory area on disk.${where}`, 800),
    S('transfer', `${pg} travels to main memory`, `${pg} moves from secondary memory into Frame ${rec.frame}.`, 1500),
    S('place', `${pg} placed in Frame ${rec.frame}`, `Frame ${rec.frame} now belongs to ${rec.pid}, page ${rec.page}.`, 700),
    S('ptupdate', 'Page table updated', `Row ${rec.page}: Frame – → ${rec.frame}, Present NO → YES, Location Disk → Main Memory.`, 1000),
    S('resume', 'CPU resumes', `The instruction is retried and now hits. ${rec.pid} stays blocked for the ${rec.serviceTime} tick(s) of disk I/O, then continues.`, 800));
  return steps;
}

const STATUS = { RUNNING: 'RUNNING', IDLE: 'IDLE' };

export class Visualizer {
  /**
   * @param {object} deps { pm, mm, vm, raid, colour(pid), esc(text) }
   */
  constructor(engine, deps) {
    Object.assign(this, { engine, ...deps });
    this.root = null; this.active = false; this.animate = true; this.detail = 'all'; this.sync = true;
    this.frozen = false; this.anims = new Set(); this._prevStatus = engine.state.status; this._lastSpeed = engine.state.speed;
    this.queue = []; this.playing = false; this.epoch = 0; this.banner = null; this.lastSeq = 0; this.held = false;
    this.evicted = new Set(); this.hl = {}; this.steps = []; this.rec = null; this.sel = null; this.focus = 'auto';
    this.cpuView = null; this.addr = null; this.note = ''; this.catchingUp = false;
    engine.bus.on('STATE_CHANGED', () => this.onChange());
    // Step while paused moves a frozen animation forward again (nothing else would, because the clock is not running).
    engine.bus.on('TICK', () => { if (this.frozen && !this.engine.running) this._thaw(); });
  }
  get state() { return this.engine.state; }
  /** The animation runs at the simulation speed: 2x simulation = 2x animation (there is no separate animation speed). */
  get speed() { return this.state.speed || 1; }
  get paused() { return this.frozen; }
  get pageBytes() { return this.state.config.pageSize * 1024; }

  // Records -------------------------------------------------------------------------------------------
  onChange() {
    this._followSimulation();
    const vm = this.state.virtualMemory;
    if (vm.refSeq < this.lastSeq) this._reset();                 // simulation was reset
    const fresh = vm.trace.filter((r) => r.seq > this.lastSeq);
    if (fresh.length) this.lastSeq = fresh[fresh.length - 1].seq;
    for (const rec of fresh) {
      if (!this.active) this._instant({ ...rec }); else this.queue.push({ ...rec });
    }
    if (this.active && this.queue.length) {
      if (this.sync && this.animate && this.engine.running && !this.held) { this.engine.holdClock(); this.held = true; }
      this._run();
    } else if (this.active && !this.playing) this.draw();
  }
  /** Pause / Resume / speed changes of the simulation also pause, resume and re-time the animation in progress. */
  _followSimulation() {
    const st = this.state.status;
    if (st === 'PAUSED' && this._prevStatus === 'RUNNING' && this.playing && !this.frozen) this._freeze();
    else if (this.frozen && st !== 'PAUSED') this._thaw();
    this._prevStatus = st;
    if (this.state.speed !== this._lastSpeed) { this._lastSpeed = this.state.speed; for (const a of this.anims) a.playbackRate = this.speed / a._base; }
  }
  _freeze() { this.frozen = true; for (const a of this.anims) a.pause(); this.draw(); }
  _thaw() {
    this.frozen = false;
    for (const a of this.anims) a.play();
    if (this.held) this.engine.holdClock();      // Resume restarts the engine timer: keep the clock held until the animation ends
    this.draw();
  }
  _stopAnims() { for (const a of [...this.anims]) a.cancel(); this.anims.clear(); }
  _reset() { this.frozen = false; this._stopAnims(); this.epoch++; this.queue = []; this.playing = false; this.lastSeq = 0; this.evicted.clear(); this.hl = {}; this.steps = []; this.rec = null; this.cpuView = null; this.addr = null; this.sel = null; this._release(); }
  _release() { if (this.held) { this.held = false; this.engine.releaseClock(); } }

  /** Apply a record without telling the story (page hidden, animation off, or catching up). */
  _instant(rec) {
    Object.assign(rec, { placed: true, ptDone: true, evictDone: true, evictPtDone: true });
    if (rec.evicted) this.evicted.add(key(rec.evicted.pid, rec.evicted.page));
    if (rec.fault && !rec.ioError) this.evicted.delete(key(rec.pid, rec.page));
    this.cpuView = { pid: rec.pid, instr: rec.instr, write: rec.write, page: rec.page, frame: rec.frame, status: STATUS.RUNNING, access: rec.ioError ? 'I/O ERROR' : rec.fault ? 'PAGE FAULT (served)' : 'HIT' };
    this.addr = { page: rec.page, offset: rec.offset, frame: rec.frame, phase: rec.ioError ? 'fault' : 'resolved' };
  }

  activate(root) {
    if (this.active && this.root === root) return;
    this.root = root; this.stage = root.querySelector('#vz-stage'); this.fx = root.querySelector('#vz-fx'); this.active = true;
    this.onChange();
    if (!this.playing) this.draw();
  }
  deactivate() {
    if (!this.active) return;
    this.active = false; this.epoch++; this.playing = false; this.frozen = false; this._stopAnims();
    for (const r of this.queue) this._instant(r);
    this.queue = []; this.hl = {}; this._release();
  }

  // Playback ----------------------------------------------------------------------------------------------
  async _run() {
    if (this.playing) return;
    this.playing = true;
    const ep = this.epoch;
    try {
      while (this.queue.length && ep === this.epoch) {
        const rec = this.queue[0];
        const quick = !this.animate || this.detail === 'off' || (this.detail === 'faults' && !rec.fault) || this.queue.length > 3;
        this.catchingUp = this.animate && this.queue.length > 3;
        if (quick) { this._instant(rec); this.steps = []; this.rec = rec; this.draw(); }
        else await this._play(rec, ep);
        if (ep !== this.epoch) return;
        this.queue.shift();
      }
    } catch (e) { if (e !== 'aborted') throw e; }
    if (ep === this.epoch) { this.playing = false; this.catchingUp = false; this.hl = {}; this._release(); this.draw(); }
  }

  /**
   * Wait `ms` (measured at 1x). Time only passes while the simulation is not paused, and it passes `speed` times
   * faster at 2x, 5x ... because the animation uses the same speed as the simulation clock.
   */
  _sleep(ms, ep) {
    return new Promise((res, rej) => {
      let left = Math.max(0, ms), last = performance.now();
      const timer = setInterval(() => {
        const now = performance.now(), dt = now - last; last = now;
        if (ep !== this.epoch) { clearInterval(timer); rej('aborted'); return; }
        if (this.frozen) return;
        left -= dt * this.speed;
        if (left <= 0) { clearInterval(timer); res(); }
      }, 30);
    });
  }

  async _play(rec, ep) {
    this.rec = rec;
    this.steps = buildSteps(rec).map((s) => ({ ...s, state: 'todo' }));
    this.hl = {}; this.addr = null; this.banner = null;
    for (const st of this.steps) {
      st.state = 'active';
      this.hl = { say: st.text, title: st.title };
      this._apply(st, rec);
      this.draw();
      await Promise.all([this._effect(st, rec, ep), this._sleep(st.ms, ep)]);
      st.state = 'done';
    }
    this.hl = {}; this.banner = null;
    if (rec.fault && !rec.ioError) this.cpuView = { ...this.cpuView, status: STATUS.RUNNING };
    this.draw();
  }

  /** Instant visual state of a step (highlights, masks, CPU and address panels). */
  _apply(st, rec) {
    const hl = this.hl, v = { pid: rec.pid, instr: rec.instr, write: rec.write, page: rec.page };
    switch (st.id) {
      case 'request': this.cpuView = { ...v, frame: null, status: STATUS.RUNNING, access: `Requesting page ${rec.page}` }; this.addr = { page: rec.page, offset: rec.offset, frame: null, phase: 'virtual' }; hl.arrow = 'a1'; hl.cpu = true; break;
      case 'lookup': this.cpuView.access = 'Translating address…'; this.addr.phase = 'lookup'; hl.arrow = 'a1'; hl.ptRow = rec.page; hl.pt = true; break;
      case 'hit': this.cpuView = { ...this.cpuView, frame: rec.frame, access: 'HIT' }; this.addr = { ...this.addr, frame: rec.frame, phase: 'resolved' }; hl.arrow = 'a2'; hl.ptRow = rec.page; hl.frame = rec.frame; hl.good = true; break;
      case 'access': this.cpuView.access = 'HIT: data returned'; hl.arrow = 'a5'; hl.frame = rec.frame; hl.good = true; break;
      case 'fault': this.cpuView = { ...this.cpuView, status: 'BLOCKED', access: 'PAGE FAULT' }; this.addr.phase = 'fault'; hl.arrow = 'a3'; hl.ptRow = rec.page; hl.vmPage = key(rec.pid, rec.page); hl.fault = true; hl.bad = true; this.banner = rec.ioError ? '⚠ PAGE FAULT · BACKING STORE UNREADABLE' : '⚠ PAGE FAULT'; break;
      case 'victim': hl.victim = rec.victim.frame; hl.showVictim = true; hl.arrow = null; break;
      case 'evict': hl.victim = rec.victim.frame; hl.arrow = 'a4r'; hl.vmPage = key(rec.evicted.pid, rec.evicted.page); break;
      case 'io': this.cpuView.access = rec.ioError ? 'Reading disk…' : 'Waiting for disk'; hl.arrow = 'a3'; hl.vmPage = key(rec.pid, rec.page); hl.io = true; break;
      case 'transfer': hl.arrow = 'a4'; hl.vmPage = key(rec.pid, rec.page); hl.frame = rec.frame; hl.io = true; break;
      case 'place': rec.placed = true; hl.frame = rec.frame; hl.flashFrame = rec.frame; this.addr = { ...this.addr, frame: rec.frame, phase: 'resolved' }; hl.arrow = 'a4'; break;
      case 'ptupdate': rec.ptDone = true; this.evicted.delete(key(rec.pid, rec.page)); hl.arrow = 'a2'; hl.ptRow = rec.page; hl.changedPt = rec.page; hl.frame = rec.frame; break;
      case 'resume': this.cpuView = { ...this.cpuView, frame: rec.frame, status: 'WAITING I/O', access: `Page loaded. Resumes after ${rec.serviceTime} tick(s)` }; hl.arrow = 'a5'; hl.frame = rec.frame; hl.good = true; break;
      case 'ioerror': this.cpuView = { ...this.cpuView, status: 'ABORTED', access: 'I/O ERROR' }; hl.error = true; hl.bad = true; break;
      default: break;
    }
  }

  /** Token flights and the state changes that happen when a token arrives. */
  async _effect(st, rec, ep) {
    const ms = st.ms / this.speed, col = this.colour(rec.pid), pt = this.q('#vz-pt'), cpu = this.q('#vz-cpu'), mm = this.q(`[data-frame="${rec.frame}"]`);
    const chip = this.q(`[data-vm="${key(rec.pid, rec.page)}"]`), row = this.q(`[data-ptrow="${rec.page}"]`) || pt;
    switch (st.id) {
      case 'request': return this.fly(cpu, pt, `Request page ${rec.page}`, '#2f5bea', ms * 0.9, 'small');
      case 'hit': return this.fly(row, mm, `Page ${rec.page} → Frame ${rec.frame}`, '#18703a', ms * 0.9, 'small');
      case 'access': return this.fly(mm, cpu, `data (${hex(rec.frame * this.pageBytes + rec.offset, 5)})`, '#18703a', ms * 0.9, 'small');
      case 'fault': return this.fly(row, chip, 'Where is it?', '#b3261e', ms * 0.8, 'small');
      case 'evict': {
        const v = rec.evicted, vf = this.q(`[data-frame="${rec.victim.frame}"]`), vc = this.q(`[data-vm="${key(v.pid, v.page)}"]`);
        await this.fly(vf, vc, `${v.pid} · Page ${v.page}${v.dirty ? ' (modified → written back)' : ''}`, this.colour(v.pid), ms * 0.85, v.dirty ? 'dirty' : '');
        if (ep !== this.epoch) throw 'aborted';
        rec.evictDone = true; rec.evictPtDone = true; this.evicted.add(key(v.pid, v.page)); this.hl.changedPt = v.page; this.draw();
        return undefined;
      }
      case 'transfer': return this.fly(chip, mm, `${rec.pid} · Page ${rec.page}`, col, ms * 0.9);
      case 'ioerror': return this.fly(chip, cpu, 'I/O ERROR', '#b3261e', ms * 0.7, 'small');
      case 'resume': return this.fly(mm, cpu, 'resume', '#18703a', ms * 0.7, 'small');
      default: return undefined;
    }
  }

  q(sel) { return this.root ? this.root.querySelector(sel) : null; }
  async fly(from, to, label, color, ms, cls = '') {
    if (!this.animate || !from || !to || !this.stage) return;
    const R = this.stage.getBoundingClientRect(), a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
    const tok = document.createElement('div');
    tok.className = `vtoken ${cls}`; tok.textContent = label; tok.style.background = color;
    this.fx.appendChild(tok);
    const w = tok.offsetWidth, h = tok.offsetHeight;
    const x1 = a.left - R.left + a.width / 2 - w / 2, y1 = a.top - R.top + a.height / 2 - h / 2;
    const dx = b.left - R.left + b.width / 2 - w / 2 - x1, dy = b.top - R.top + b.height / 2 - h / 2 - y1;
    tok.style.left = `${x1}px`; tok.style.top = `${y1}px`;
    const anim = tok.animate([
      { transform: 'translate(0,0) scale(.6)', opacity: 0 },
      { transform: 'translate(0,0) scale(1)', opacity: 1, offset: 0.12 },
      { transform: `translate(${dx}px,${dy}px) scale(1)`, opacity: 1, offset: 0.88 },
      { transform: `translate(${dx}px,${dy}px) scale(.85)`, opacity: 0 },
    ], { duration: Math.max(60, ms), easing: 'ease-in-out', fill: 'forwards' });
    anim._base = this.speed;                                  // ms was already divided by this speed; later speed changes scale the rate
    this.anims.add(anim);
    if (this.frozen) anim.pause();
    try { await anim.finished; } catch { /* cancelled */ }
    this.anims.delete(anim);
    tok.remove();
  }

  // Display state (live state + masks for queued records) ---------------------------------------------------
  _pending() { return this.active ? this.queue : []; }

  /** What frame i shows right now. */
  dispFrame(i) {
    const f = this.mm.frames[i], pend = this._pending().filter((r) => r.fault && !r.ioError && r.frame === i);
    let last = null;
    for (const r of pend) {
      if (!r.placed) return !r.evicted || r.evictDone ? null : { pid: r.evicted.pid, page: r.evicted.page, dirty: r.evicted.dirty, loadedAt: -1, usedAt: -1 };
      last = r;
    }
    if (last) return { pid: last.pid, page: last.page, dirty: last.write, loadedAt: f.loadedAt, usedAt: f.usedAt };
    return f.pid === null ? null : f;
  }

  /** Page table entry as displayed: frame number or null. */
  dispEntry(pid, page) {
    const live = (this.mm.table(pid) || [])[page] ?? null;
    let state = null, any = false;
    for (const r of this._pending()) {
      if (!r.fault || r.ioError) continue;
      if (r.evicted && r.evicted.pid === pid && r.evicted.page === page) { any = true; state = { done: r.evictPtDone, then: null, before: r.frame }; if (!r.evictPtDone) return r.frame; }
      if (r.pid === pid && r.page === page) { any = true; if (!r.ptDone) return null; state = { then: r.frame }; }
    }
    return any && state ? (state.then ?? null) : live;
  }

  _status(pid, page) {
    const k = key(pid, page), fr = this.dispEntry(pid, page), p = this.pm.get(pid);
    const loading = this._pending().some((r) => r.fault && !r.ioError && r.pid === pid && r.page === page && !r.ptDone) || (p && p.pendingPage === page && p.wakeAt !== null && fr !== null);
    if (loading) return 'loading';
    if (fr !== null) return 'mem';
    return this.evicted.has(k) ? 'evicted' : 'disk';
  }

  focusPid() {
    if (this.focus !== 'auto' && this.mm.table(this.focus)) return this.focus;
    const live = this.state.cpu && this.state.cpu.current;
    if (this.cpuView && this.mm.table(this.cpuView.pid)) return this.cpuView.pid;
    if (live && this.mm.table(live)) return live;
    return this.pm.list.find((p) => this.mm.hasTable(p.pid))?.pid ?? null;
  }

  // Drawing --------------------------------------------------------------------------------------------------
  mount(root) {
    this.root = root;
    root.innerHTML = `
    <div class="info"><b>How to read this screen.</b> A process is split into <i>pages</i> that live in <b>virtual memory</b>, which is stored in <b>secondary memory</b> (the RAID array). The CPU asks the <b>page table</b> where a page is: if it is <i>present</i> it sits in a <b>frame</b> of <b>main memory</b>; if not, a <b>page fault</b> makes the OS bring the page in (evicting a victim if every frame is taken). Press <b>Start</b> or <b>Step</b> at the top (the animation uses the simulation clock and speed: <b>Pause</b> freezes it, <b>Resume</b> continues it, <b>Step</b> plays it forward one tick at a time), or click a page in virtual memory and use <i>CPU requests this page</i>.</div>
    <div class="card viz-bar">
      <label>Animate <select id="vz-detail"><option value="all">every memory access</option><option value="faults">page faults only</option><option value="off">off</option></select></label>
      <span id="vz-clock" class="vz-clock"></span>
      <label>Page table of <select id="vz-proc"></select></label>
      <label class="chk"><input type="checkbox" id="vz-sync" checked> Hold the simulation clock while an animation plays</label>
      <span id="vz-note" class="vz-note"></span></div>
    <div class="viz-stage" id="vz-stage">
      <div class="viz-grid">
        <section class="vz vz-cpu" id="vz-cpu"></section><section class="vz vz-addr" id="vz-addr"></section><section class="vz vz-story" id="vz-story"></section>
        <section class="vz vz-pt" id="vz-pt"></section><section class="vz vz-sec" id="vz-sec"></section><section class="vz vz-mm" id="vz-mm"></section>
      </div>
      <svg class="viz-svg" id="vz-svg"></svg><div class="viz-fx" id="vz-fx"></div></div>
    <div id="vz-detailcard"></div>`;
    this.stage = this.q('#vz-stage'); this.fx = this.q('#vz-fx');
    root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'vz-detail') this.detail = t.value;
      if (t.id === 'vz-sync') { this.sync = t.checked; if (!this.sync) this._release(); }
      if (t.id === 'vz-proc') this.focus = t.value;
      this.draw();
    });
    root.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-vpage]'), btn = e.target.closest('#vz-request');
      if (chip) { this.sel = chip.dataset.vpage; this.draw(); }
      if (btn && this.sel) {
        const [pid, page] = this.sel.split(':');
        try { this.note = ''; this.vm.requestPage(pid, Number(page)); } catch (err) { this.note = err.message; this.draw(); }
      }
    });
    if (!this._resize) { this._resize = () => this.active && this._arrows(); window.addEventListener('resize', this._resize); }
  }

  draw() {
    if (!this.root || !this.active || !this.stage) return;
    for (const k of [...this.evicted]) { const [pid] = k.split(':'); if (!this.mm.hasTable(pid)) this.evicted.delete(k); }
    this._cpu(); this._addr(); this._story(); this._pt(); this._mm(); this._sec(); this._detail(); this._procSelect();
    const ck = this.q('#vz-clock');
    if (ck) ck.innerHTML = `<b>Simulation clock</b> ${SimulationClock.format(this.state.clock)} &middot; ${this.state.status} &middot; ${this.state.speed}x`;
    const n = this.q('#vz-note'); if (n) n.innerHTML = this.frozen ? 'paused: the animation is frozen. Press Resume to continue (or Step to play it forward).' : this.note ? `<span style="color:#b3261e">${this.esc(this.note)}</span>` : this.catchingUp ? 'catching up: lower the simulation speed to watch every step' : this.held && this.playing ? 'clock held until the animation ends' : '';
    this._arrows();
  }

  _procSelect() {
    const sel = this.q('#vz-proc'); if (!sel) return;
    const pids = this.pm.list.filter((p) => this.mm.hasTable(p.pid)).map((p) => p.pid), sig = pids.join(',') + '|' + this.focus;
    if (sel.dataset.sig !== sig) { sel.innerHTML = `<option value="auto">follow the CPU</option>${pids.map((p) => `<option${p === this.focus ? ' selected' : ''}>${p}</option>`).join('')}`; sel.value = this.focus === 'auto' || !pids.includes(this.focus) ? 'auto' : this.focus; sel.dataset.sig = sig; }
  }

  _cpu() {
    const cpu = this.state.cpu, v = this.cpuView, busy = !!cpu.current;
    const waiting = this.pm.list.some((p) => p.state === 'WAITING' && p.wakeAt !== null);
    const live = busy ? STATUS.RUNNING : waiting ? 'IDLE (all processes wait for I/O)' : 'IDLE';
    const playing = this.playing && this.rec;
    const status = playing ? v.status : live;
    const pid = playing ? v.pid : (cpu.current || (v && v.pid) || null), p = pid ? this.pm.get(pid) : null;
    const showV = v && (playing || (pid && v.pid === pid));
    this.q('#vz-cpu').className = `vz vz-cpu${this.hl.cpu ? ' hot' : ''}${this.hl.error ? ' err' : ''}`;
    this.q('#vz-cpu').innerHTML = `<h3>CPU <small>core 0</small></h3><div class="vz-cpuchip st-${status.split(' ')[0]}">${status}</div>
      <table class="kv"><tbody>
       <tr><th>Process</th><td>${pid ? `<span class="pdot" style="background:${this.colour(pid)}"></span>${pid}${p ? ' · ' + this.esc(p.name) : ''}` : '—'}</td></tr>
       <tr><th>Instruction</th><td>${showV ? `#${v.instr} <small>${v.write ? 'STORE' : 'LOAD'}</small>` : '—'}</td></tr>
       <tr><th>Page</th><td>${showV ? v.page : '—'}</td></tr>
       <tr><th>Frame</th><td>${showV && v.frame !== null && v.frame !== undefined ? v.frame : '—'}</td></tr>
       <tr><th>Memory access</th><td>${showV ? `<b class="${/FAULT|ERROR/.test(v.access) ? 'bad' : /HIT/.test(v.access) ? 'good' : ''}">${this.esc(v.access)}</b>` : 'no access yet'}</td></tr>
      </tbody></table>`;
  }

  _addr() {
    const a = this.addr, ph = a ? a.phase : 'idle', B = this.pageBytes, el = this.q('#vz-addr');
    const vaddr = a ? a.page * B + a.offset : null, paddr = a && a.frame !== null && a.frame !== undefined ? a.frame * B + a.offset : null;
    const on = (names) => (names.includes(ph) ? ' on' : '');
    el.className = 'vz vz-addr';
    el.innerHTML = `<h3>Virtual address → physical address <small>page size ${this.state.config.pageSize} KB = ${B} bytes</small></h3>
     <div class="addr-row">
      <div class="abox"><small>VIRTUAL ADDRESS</small><div class="afield"><span class="seg pg${on(['virtual', 'lookup'])}">${a ? `Page ${a.page}` : 'Page number'}</span><span class="seg off${on(['virtual', 'lookup', 'resolved'])}">${a ? `Offset ${hex(a.offset, 3)}` : 'Page offset'}</span></div><small>${a ? hex(vaddr, 5) + ' = ' + vaddr : ''}</small></div>
      <div class="aarr${on(['lookup'])}">▶<br><small>PAGE TABLE</small></div>
      <div class="abox"><small>FRAME NUMBER</small><div class="afield"><span class="seg fr${ph === 'resolved' ? ' on ok' : ph === 'fault' ? ' on bad' : ''}">${ph === 'fault' ? 'PAGE FAULT' : paddr !== null ? `Frame ${a.frame}` : '?'}</span></div><small>&nbsp;</small></div>
      <div class="aarr${ph === 'resolved' ? ' on' : ''}">▶</div>
      <div class="abox"><small>PHYSICAL ADDRESS</small><div class="afield"><span class="seg fr${ph === 'resolved' ? ' on ok' : ''}">${paddr !== null ? `Frame ${a.frame}` : '—'}</span><span class="seg off${ph === 'resolved' ? ' on ok' : ''}">${a ? `Offset ${hex(a.offset, 3)}` : '—'}</span></div><small>${paddr !== null ? `${hex(paddr, 5)} = ${a.frame} × ${B} + ${a.offset}` : ''}</small></div>
     </div>`;
  }

  _story() {
    const el = this.q('#vz-story'), hl = this.hl, r = this.rec;
    const banner = this.banner && this.playing ? `<div class="vz-banner bad">${this.banner}</div>` : '';
    let victim = '';
    if (hl.showVictim && r && r.victim) {
      const v = r.victim, cands = v.candidates.filter((c) => c.pid);
      victim = `<div class="vsel"><b>Victim selection (${v.policy})</b><small> – ${v.pick === 'largest' ? 'the page whose next use is farthest away (or never) is evicted' : `smallest "${v.keyName}" number is evicted`}</small><table><tbody>${cands.map((c) => `<tr class="${c.frame === v.frame ? 'chosen' : ''}"><td>Frame ${c.frame}</td><td><span class="pdot" style="background:${this.colour(c.pid)}"></span>${c.pid} p${c.page}</td><td>${c.label ?? `${v.keyName} #${c.key}`}</td><td>${c.frame === v.frame ? '◀ victim' : ''}</td></tr>`).join('')}</tbody></table></div>`;
    }
    const list = this.steps.length ? `<ol class="steps">${this.steps.map((s) => `<li class="${s.state}"><b>${this.esc(s.title)}</b></li>`).join('')}</ol>` : '<div class="empty" style="padding:10px">The sequence of the current memory access appears here once the simulation runs.</div>';
    el.className = 'vz vz-story';
    el.innerHTML = `<h3>What is happening</h3>${banner}${hl.say ? `<div class="say">${this.esc(hl.say)}</div>` : r && !this.playing ? `<div class="say dim">${r.fault ? (r.ioError ? 'Last access: I/O error.' : 'Last access: page fault, served.') : 'Last access: hit.'} (${r.pid}, page ${r.page}) at t=${SimulationClock.format(r.time)}</div>` : ''}${list}${victim}`;
  }

  _pt() {
    const el = this.q('#vz-pt'), pid = this.focusPid(), t = pid ? this.mm.table(pid) : null, hl = this.hl;
    el.className = `vz vz-pt${hl.pt ? ' hot' : ''}${hl.fault ? ' err' : ''}`;
    if (!t) { el.innerHTML = '<h3>Page table</h3><div class="empty">No process has an address space yet. Create processes on the Processes page (Load demo processes).</div>'; return; }
    const p = this.pm.get(pid);
    el.innerHTML = `<h3>Page table <small><span class="pdot" style="background:${this.colour(pid)}"></span>${pid}</small></h3>
     <table class="ptab"><thead><tr><th>Page</th><th>Frame</th><th>Present</th><th>Location</th></tr></thead><tbody>${t.map((_, pg) => {
    const fr = this.dispEntry(pid, pg), st = this._status(pid, pg), cls = [hl.ptRow === pg && this.rec && this.rec.pid === pid ? (hl.bad ? 'cur bad' : hl.good ? 'cur good' : 'cur') : '', hl.changedPt === pg && this.rec && (this.rec.pid === pid || (this.rec.evicted && this.rec.evicted.pid === pid)) ? 'flash' : ''].join(' ');
    return `<tr class="${cls}" data-ptrow="${pg}"><td>${pg}</td><td>${fr === null ? '–' : fr}</td><td class="${fr === null ? 'no' : 'yes'}">${fr === null ? 'No' : 'Yes'}</td><td>${fr === null ? 'Secondary Memory' : 'Main Memory'}${st === 'loading' ? ' <small>(loading)</small>' : ''}</td></tr>`;
  }).join('')}</tbody></table><small>${p ? `${p.memoryRequired} KB = ${p.pages} pages` : ''}</small>`;
  }

  _mm() {
    const el = this.q('#vz-mm'), frames = this.mm.frames, hl = this.hl;
    const used = frames.filter((_, i) => this.dispFrame(i)).length;
    el.className = 'vz vz-mm';
    const compact = frames.length > 12;
    el.innerHTML = `<h3>Main memory <small>${used}/${frames.length} frames used · ${this.state.config.memorySize} KB</small></h3>
     <div class="vframes${compact ? ' compact' : ''}">${frames.map((_, i) => {
    const f = this.dispFrame(i), p = f ? this.pm.get(f.pid) : null;
    const loading = f && p && p.pendingPage === f.page && p.wakeAt !== null && !this._pending().some((r) => r.frame === i && !r.placed);
    const cls = ['vframe', f ? 'occ' : 'free', hl.frame === i ? (hl.bad ? 'hot bad' : hl.good ? 'hot good' : 'hot') : '', hl.victim === i ? 'victim' : '', hl.flashFrame === i ? 'flash' : ''].join(' ');
    return `<div class="${cls}" data-frame="${i}" ${f ? `style="--c:${this.colour(f.pid)}"` : ''} title="${f ? `${f.pid} page ${f.page}${f.dirty ? ' (modified)' : ''}` : 'free frame'}"><b>Frame ${i}</b>${f ? `<span class="fc"><span class="pdot" style="background:${this.colour(f.pid)}"></span>${f.pid} · Page ${f.page}</span><small>OCCUPIED${f.dirty ? ' · <span class="dirty">modified</span>' : ''}${loading ? ' · <span class="ld">loading I/O</span>' : ''}</small>` : '<span class="fc">EMPTY</span><small>FREE</small>'}</div>`;
  }).join('')}</div>`;
  }

  _blockInfo(pid, page) {
    const lb = this.raid && this.raid.r.swap[pid] ? this.raid.r.swap[pid][page] : undefined;
    if (lb === undefined) return null;
    const L = this.raid.array.logical[lb], pl = this.raid.plan(lb);
    const disks = L.span ? `D${L.disks[0] + 1}–${L.disks[L.disks.length - 1] + 1}` : 'D' + L.disks.map((d) => d + 1).join('/');
    return { lb, label: this.raid.labelOf(lb), disks, flag: !pl.ok ? '✕' : pl.reconstructed ? '⚠' : '', note: !pl.ok ? `unreadable: ${pl.reason}` : pl.reconstructed ? 'its disk failed: rebuilt from parity when read' : '' };
  }

  _sec() {
    const el = this.q('#vz-sec'), hl = this.hl, procs = this.pm.list.filter((p) => this.mm.hasTable(p.pid));
    const rs = this.raid ? this.raid.stats() : null;
    const body = procs.length ? procs.map((p) => `<div class="vproc" style="--c:${this.colour(p.pid)}"><h4><span class="pdot" style="background:${this.colour(p.pid)}"></span>Process ${p.pid} <small>${this.esc(p.name)} · ${p.pages} pages × ${this.state.config.pageSize} KB · ${p.state}</small></h4><div class="vpages">${this.mm.table(p.pid).map((_, pg) => {
      const st = this._status(p.pid, pg), k = key(p.pid, pg), fr = this.dispEntry(p.pid, pg), b = this._blockInfo(p.pid, pg);
      const lab = { mem: `in Frame ${fr}`, disk: 'on disk', loading: 'loading…', evicted: 'evicted' }[st];
      return `<div class="vchip st-${st}${hl.vmPage === k ? ' hot' : ''}${hl.io && hl.vmPage === k ? ' io' : ''}${this.sel === k ? ' sel' : ''}" data-vm="${k}" data-vpage="${k}" style="--c:${this.colour(p.pid)}" title="${p.pid} page ${pg}${b ? ` · block ${b.label} on ${b.disks}` : ''}${b && b.note ? ' · ' + b.note : ''}"><b>Page ${pg}</b><small>${lab}</small>${b ? `<small class="blk">${b.label} @ ${b.disks}${b.flag ? ' ' + b.flag : ''}</small>` : ''}</div>`;
    }).join('')}</div></div>`).join('') : '<div class="empty">Virtual memory is empty: no process has been given an address space.</div>';
    el.className = 'vz vz-sec';
    el.innerHTML = `<h3>Secondary memory <small>disk${rs ? ` · ${rs.label} <span class="rs rs-${rs.status}">${rs.status}</span>` : ''}</small></h3>
     <div class="vmbox" id="vz-vmbox"><div class="vmtitle">VIRTUAL MEMORY <small>pages of every process, stored on disk</small></div>${body}</div>
     <div class="legend vlegend"><span class="vchip st-disk"><b>on disk</b><small>secondary only</small></span><span class="vchip st-mem"><b>in memory</b><small>loaded in a frame</small></span><span class="vchip st-loading"><b>loading</b><small>waiting to load</small></span><span class="vchip st-evicted"><b>evicted</b><small>replaced, back on disk</small></span></div>
     <small>Chip line 3: block of the RAID array and disk that stores the page (⚠ rebuilt from parity, ✕ unreadable).</small>`;
  }

  _detail() {
    const el = this.q('#vz-detailcard');
    if (!this.sel) { el.innerHTML = '<div class="card empty" style="margin-top:14px">Click a page in virtual memory to see its details and to make the CPU request it.</div>'; return; }
    const [pid, ps] = this.sel.split(':'), pg = Number(ps), t = this.mm.table(pid);
    if (!t || pg >= t.length) { this.sel = null; return this._detail(); }
    const st = this._status(pid, pg), fr = this.dispEntry(pid, pg), f = fr !== null ? this.mm.frames[fr] : null, b = this._blockInfo(pid, pg), p = this.pm.get(pid);
    const status = { mem: 'PRESENT', disk: 'NOT PRESENT', loading: 'LOADING', evicted: 'NOT PRESENT (evicted)' }[st];
    const block = this.pm.get(pid) && p.pendingPage !== null;
    el.innerHTML = `<div class="card" style="margin-top:14px"><h2>Page ${pg} of ${pid}</h2><div class="grid"><table class="kv"><tbody>
      <tr><th>Process</th><td>${pid}</td></tr><tr><th>Page number</th><td>${pg}</td></tr><tr><th>Size</th><td>${this.state.config.pageSize} KB</td></tr>
      <tr><th>Location</th><td>${fr !== null ? 'Main Memory' : 'Secondary Memory'}</td></tr><tr><th>Frame</th><td>${fr !== null ? fr : '—'}</td></tr>
      <tr><th>Status</th><td><b>${status}</b></td></tr></tbody></table>
     <table class="kv"><tbody><tr><th>Modified (dirty)</th><td>${f ? (f.dirty ? 'Yes: written back when evicted' : 'No') : 'n/a (not in a frame)'}</td></tr>
      <tr><th>Loaded (order)</th><td>${f ? '#' + f.loadedAt : '—'}</td></tr><tr><th>Last used (order)</th><td>${f ? '#' + f.usedAt : '—'}</td></tr>
      <tr><th>Stored on disk as</th><td>${b ? `block ${b.label} on ${b.disks}${b.note ? ' <small>(' + this.esc(b.note) + ')</small>' : ''}` : '—'}</td></tr></tbody></table>
     <div><button id="vz-request" class="primary"${block || this.playing ? ' disabled' : ''}>CPU requests this page</button><div style="margin-top:6px"><small>${block ? 'This process is waiting for a page fault: wait until it is READY.' : this.playing ? 'Wait for the current animation to finish.' : 'Works even when the simulation is stopped. If the page is absent you will see the full page-fault sequence.'}</small></div></div></div></div>`;
  }

  // Arrows ------------------------------------------------------------------------------------------------------
  _arrows() {
    const svg = this.q('#vz-svg'); if (!svg || !this.stage) return;
    const R = this.stage.getBoundingClientRect(), box = (id) => { const e = this.q(id); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left - R.left, r: r.right - R.left, t: r.top - R.top, b: r.bottom - R.top, cx: (r.left + r.right) / 2 - R.left, cy: (r.top + r.bottom) / 2 - R.top }; };
    const cpu = box('#vz-cpu'), pt = box('#vz-pt'), mm = box('#vz-mm'), vmb = box('#vz-vmbox');
    svg.setAttribute('width', R.width); svg.setAttribute('height', R.height); svg.setAttribute('viewBox', `0 0 ${R.width} ${R.height}`);
    if (!cpu || !pt || !mm || !vmb || R.width < 900) { svg.innerHTML = ''; return; }
    const clamp = (y) => Math.min(vmb.b - 14, Math.max(vmb.t + 14, y)), a = this.hl.arrow;
    const x1 = Math.min(cpu.cx, pt.cx), yv3 = clamp(pt.cy), yv4 = clamp(mm.cy);
    const A = [
      ['a1', `M${x1} ${cpu.b} L${x1} ${pt.t - 2}`, 'memory request', x1 + 8, (cpu.b + pt.t) / 2],
      ['a2', `M${x1} ${pt.b} L${x1} ${mm.t - 2}`, 'page → frame', x1 + 8, (pt.b + mm.t) / 2],
      ['a3', `M${pt.r} ${pt.cy} L${vmb.l - 3} ${yv3}`, 'present? / where on disk', (pt.r + vmb.l) / 2 - 38, (pt.cy + yv3) / 2 - 8],
      ['a4', `M${vmb.l} ${yv4} L${mm.r + 3} ${mm.cy}`, 'page transfer', (mm.r + vmb.l) / 2 - 30, (yv4 + mm.cy) / 2 - 8],
      ['a5', `M${mm.l} ${mm.cy} C${mm.l - 34} ${mm.cy}, ${cpu.l - 34} ${cpu.cy}, ${cpu.l - 2} ${cpu.cy}`, 'data', cpu.l - 32, (mm.cy + cpu.cy) / 2],
    ];
    const on = (id) => a === id || (a === 'a4r' && id === 'a4');
    svg.innerHTML = `<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="context-stroke"/></marker></defs>${A.map(([id, d, label, lx, ly]) => `<path d="${d}" class="va${on(id) ? ' on' : ''}${a === 'a4r' && id === 'a4' ? ' rev' : ''}" marker-end="${a === 'a4r' && id === 'a4' ? '' : 'url(#ah)'}" marker-start="${a === 'a4r' && id === 'a4' ? 'url(#ah)' : ''}"/>${on(id) ? `<text x="${lx}" y="${ly}" class="vl">${label}</text>` : ''}`).join('')}`;
  }
}
