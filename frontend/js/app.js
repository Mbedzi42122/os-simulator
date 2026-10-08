import { SimulationEngine } from './simulation/SimulationEngine.js';
import { SimulationClock } from './simulation/SimulationClock.js';
import { SPEEDS, DEFAULT_CONFIG } from './simulation/SimulationState.js';
import { ProcessManager } from './process/ProcessManager.js';
import { STATES, TRANSITIONS } from './process/Process.js';
import { Scheduler, ALGORITHMS } from './cpu/Scheduler.js';
import { MemoryManager } from './memory/MemoryManager.js';
import { VirtualMemory, REPLACEMENT_ALGORITHMS, LIVE_ALGORITHMS, simulateReplacement } from './memory/VirtualMemory.js';
import { RaidManager } from './raid/RaidManager.js';
import { Visualizer } from './visualization/Visualizer.js';
import { RAID_LEVELS, LEVEL_IDS, MAX_DISKS, MAX_CAPACITY, describe } from './raid/RaidLayout.js';

const engine = new SimulationEngine();
const pm = engine.registerModule(new ProcessManager(engine));
const mm = engine.registerModule(new MemoryManager(engine));
const raid = engine.registerModule(new RaidManager(engine));      // the disk array that holds the backing store
const vm = engine.registerModule(new VirtualMemory(engine, pm, mm, raid));
const sched = engine.registerModule(new Scheduler(engine, pm, vm));
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PAGES = ['Dashboard', 'Processes', 'CPU & Scheduling', 'Memory', 'Virtual Memory', 'Visualization', 'RAID', 'Event Log', 'Settings'];
const READY_PAGES = ['Dashboard', 'Processes', 'CPU & Scheduling', 'Memory', 'Virtual Memory', 'Visualization', 'RAID', 'Event Log', 'Settings'];
const ui = { vmTab: 'demand', memSel: null, translation: null, page: 'Dashboard', selected: null, search: '', error: '', notice: '', logFilter: '', logSearch: '' };

const badge = (s) => `<span class="badge s-${s}">${s}</span>`;
// Appearance / behaviour preferences (kept in the browser; the simulation itself is unaffected)
const PREFS_KEY = 'os-simulator-prefs';
const prefs = { theme: 'light', confirm: true };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch { /* storage unavailable: use defaults */ }
const applyTheme = () => { document.documentElement.dataset.theme = prefs.theme === 'dark' ? 'dark' : 'light'; };
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };
applyTheme();
const confirmDialog = (msg) => !prefs.confirm || window.confirm(msg);
const guard = (fn) => { try { ui.error = ''; ui.notice = ''; fn(); } catch (e) { ui.error = e.errors ? e.errors.join('\n') : e.message; } render(true); };

// Controls ------------------------------------------------------------------
$('#btn-start').onclick = () => engine.start();
$('#btn-pause').onclick = () => engine.pause();
$('#btn-resume').onclick = () => engine.resume();
$('#btn-step').onclick = () => engine.step();
$('#btn-reset').onclick = () => {
  if (engine.state.status !== 'STOPPED' && !confirmDialog('The simulation is active. Reset everything?')) return;
  ui.selected = null; engine.reset();
};
$('#speed').innerHTML = SPEEDS.map((s) => `<option value="${s}"${s === 1 ? ' selected' : ''}>${s}x</option>`).join('');
$('#speed').onchange = (e) => engine.setSpeed(Number(e.target.value));

function renderTopbar() {
  const st = engine.state.status;
  $('#clock').textContent = SimulationClock.format(engine.state.clock);
  $('#status').textContent = st;
  $('#btn-start').disabled = st !== 'STOPPED';
  $('#btn-pause').disabled = st !== 'RUNNING';
  $('#btn-resume').disabled = st !== 'PAUSED';
  $('#btn-step').disabled = st === 'RUNNING';
}

// Pages ---------------------------------------------------------------------
function dashboard() {
  const c = pm.counts(), s = engine.state;
  return `<div class="info"><b>What is this?</b> The dashboard summarises the whole simulated system. Everything here is read from the single simulation state.</div>
  <div class="grid">
   <div class="card"><h2>Simulation</h2><div class="big">${SimulationClock.format(s.clock)}</div>Status: ${s.status} · Speed ${s.speed}x</div>
   <div class="card"><h2>Processes</h2><div class="big">${c.total}</div>Running ${c.RUNNING} · Ready ${c.READY} · Waiting ${c.WAITING} · New ${c.NEW} · Terminated ${c.TERMINATED}</div>
   <div class="card"><h2>CPU</h2><div class="big">${sched.stats().cpuUtilisation}%</div>Running: ${s.cpu.current || 'idle'} · Algorithm ${s.config.schedulingAlgorithm}</div>
   <div class="card"><h2>Memory (frames)</h2><div class="big">${mm.stats().utilisation}%</div>${mm.stats().used} of ${mm.stats().frames} frames used · ${s.config.memorySize} KB, ${s.config.pageSize} KB pages</div>
   <div class="card"><h2>Virtual memory</h2><div class="big">${vm.stats().faults}</div>page faults · ${vm.stats().hits} hits · ${vm.stats().replacements} replacements</div>
   <div class="card"><h2>RAID backing store</h2><div class="big"><span class="rs rs-${raid.status}">${raid.status}</span></div>${raid.stats().label} · ${raid.stats().disks} disks · ${raid.stats().usableKB} KB usable · ${raid.stats().reconstructed} reconstructed page-ins</div>
  </div>
  <div class="card"><h2>Process state diagram</h2><div class="flow">${badge('NEW')}→${badge('READY')}⇄${badge('RUNNING')}→${badge('TERMINATED')}&nbsp;&nbsp;${badge('RUNNING')}→${badge('WAITING')}→${badge('READY')}</div></div>`;
}

function processes() {
  const rows = pm.search(ui.search);
  const sel = pm.get(ui.selected);
  const table = rows.length ? `<table><thead><tr><th>PID</th><th>Name</th><th>State</th><th>Priority</th><th>Burst</th><th>Remaining</th><th>Memory</th><th>Pages</th><th>Faults</th></tr></thead><tbody>${rows.map((p) =>
    `<tr data-pid="${p.pid}" class="${p.pid === ui.selected ? 'sel' : ''}"><td>${p.pid}</td><td>${esc(p.name)}</td><td>${badge(p.state)}</td><td>${p.priority}</td><td>${p.burstTime}</td><td>${p.remainingTime}</td><td>${p.memoryRequired} KB</td><td>${p.pages}</td><td>${p.pageFaults}</td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">${pm.list.length ? 'No processes match your search.' : 'No processes yet. Create one using the form above.'}</div>`;
  const detail = sel ? `<div class="card"><h2>${sel.pid} — ${esc(sel.name)} ${badge(sel.state)}</h2>
    <div class="row">${TRANSITIONS[sel.state].map((t) => `<button data-to="${t}">→ ${t}</button>`).join('') || '<span class="empty">Terminal state: no further transitions.</span>'}
    <button class="danger" data-remove>Remove</button></div>
    <table><tbody>${[['Arrival', sel.arrivalTime], ['Burst', sel.burstTime], ['Remaining', sel.remainingTime], ['Priority', sel.priority], ['Memory', sel.memoryRequired + ' KB'], ['Pages', `${sel.pages} (${mm.residentPages(sel.pid)} in memory)`], ['Page faults', sel.pageFaults], ['Page hits', sel.pageHits],
      ['Parent PID', sel.parentPid ?? '—'], ['CPU time used', sel.cpuTimeUsed], ['Waiting time', sel.waitingTime], ['Turnaround', sel.turnaroundTime],
      ['I/O state', sel.ioState], ...(sel.abortReason ? [['Aborted because', esc(sel.abortReason)]] : []), ['Created at', sel.creationTime], ['Terminated at', sel.terminationTime ?? '—']].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</tbody></table></div>` : '';
  return `<div class="info"><b>What is this?</b> A process is a program in execution. It moves through states (NEW, READY, RUNNING, WAITING, SUSPENDED, TERMINATED); only valid transitions are allowed. Priority: <b>lower number = higher priority</b> (0–10). NEW processes become READY once the clock reaches their arrival time. Memory is in KB: a process is divided into pages (page size is set on the Memory page) and its pages are loaded into frames on demand.</div>
  <div class="card"><h2>Create process</h2><form id="pform" class="fields">
   <div><label>Name</label><input name="name" required></div>
   <div><label>Burst time</label><input name="burstTime" type="number" value="5"></div>
   <div><label>Priority (0–10)</label><input name="priority" type="number" value="5"></div>
   <div><label>Memory (KB)</label><input name="memoryRequired" type="number" value="16"></div>
   <div><label>Arrival time</label><input name="arrivalTime" type="number" value="0"></div>
   <div class="row"><button class="primary">Create</button><button type="button" id="demo-load" title="Add five sample processes (P1–P5) with different arrival times, bursts, priorities and sizes">Load demo processes</button></div></form>
   <div class="err">${esc(ui.error)}</div></div>
  <div class="card"><div class="row" style="justify-content:space-between"><h2>Process table</h2>
   <input id="psearch" placeholder="Search PID, name or state" value="${esc(ui.search)}" style="max-width:240px"></div>${table}</div>${detail}`;
}

// Event severity: danger = red (failures / data at risk), warn = amber (degraded / needs attention), ok = green (recovered)
const EVENT_SEVERITY = {
  RAID_DISK_FAILED: 'danger', PAGE_IO_ERROR: 'danger', PROCESS_ABORTED: 'danger', VIRTUAL_MEMORY_FULL: 'danger',
  RAID_RECONSTRUCT: 'warn', RAID_REBUILD_STARTED: 'warn', RAID_RECREATED: 'warn',
  RAID_REBUILD_COMPLETE: 'ok',
};
const SEVERITY_ICON = { danger: '⚠', warn: '▲', ok: '✔' };
const SEVERITY_LABEL = { danger: 'DANGER', warn: 'WARNING', ok: 'OK' };
const severityOf = (e) => EVENT_SEVERITY[e.type] || '';

function visibleEvents() {
  const f = ui.logFilter, q = ui.logSearch.toLowerCase();
  return engine.state.events.filter((e) => (!f || e.type === f) && (!q || e.message.toLowerCase().includes(q)));
}

/** Offer `text` to the browser as a downloaded file. */
function saveFile(name, text, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Download the events currently shown (respecting the filter/search) as a plain-text file, oldest first. */
function downloadLog() {
  const ev = visibleEvents();
  if (!ev.length) throw new Error('There are no events to download.');
  const stamp = new Date();
  const lines = [
    'OS Simulator - event log',
    `Exported: ${stamp.toLocaleString()}`,
    `Events: ${ev.length}${ui.logFilter || ui.logSearch ? ` (filtered${ui.logFilter ? ` by type ${ui.logFilter}` : ''}${ui.logSearch ? `, search "${ui.logSearch}"` : ''})` : ''}`,
    '='.repeat(72),
    ...ev.map((e) => `[${SimulationClock.format(e.time)}] [${(SEVERITY_LABEL[severityOf(e)] || 'INFO').padEnd(7)}] [${e.type}] ${e.message}`),
  ];
  const pad = (n) => String(n).padStart(2, '0');
  const name = `os-simulator-log-${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.txt`;
  saveFile(name, lines.join('\r\n') + '\r\n', 'text/plain');
}

function eventLog() {
  const f = ui.logFilter, ev = visibleEvents(), all = engine.state.events;
  const types = [...new Set(all.map((e) => e.type))];
  const count = (sv) => all.filter((e) => severityOf(e) === sv).length;
  const danger = count('danger'), warn = count('warn');
  return `<div class="card"><div class="row"><select id="lfilter" style="max-width:220px"><option value="">All events</option>${types.map((t) => `<option${t === f ? ' selected' : ''}>${t}</option>`).join('')}</select>
   <input id="lsearch" placeholder="Search events" value="${esc(ui.logSearch)}" style="max-width:240px"><button id="ldownload"${ev.length ? '' : ' disabled'} title="Save the events shown below as a .txt file">⬇ Download log</button><button id="lclear">Clear log</button></div>
   <div class="legend"><span class="badge ev-danger">⚠ ${danger} danger</span><span class="badge ev-warn">▲ ${warn} warning</span><span class="empty">Red = failure / data at risk (e.g. disk failure, page I/O error, process aborted, virtual memory full). Amber = degraded or needs attention. Green = recovered.</span></div>
   <div class="log">${ev.length ? ev.slice().reverse().map((e) => { const sv = severityOf(e); return `<div class="ev${sv ? ' ev-' + sv : ''}" title="${e.type}">${sv ? `<span class="ev-icon">${SEVERITY_ICON[sv]}</span>` : ''}${SimulationClock.format(e.time)}&nbsp; ${esc(e.message)}</div>`; }).join('') : '<div class="empty">No events.</div>'}</div></div>`;
}

// Settings -------------------------------------------------------------------
const currentSettings = () => {
  const c = engine.state.config, r = engine.state.raid.config;
  return { speed: engine.state.speed, schedulingAlgorithm: c.schedulingAlgorithm, timeQuantum: c.timeQuantum,
    memorySize: c.memorySize, pageSize: c.pageSize, virtualMemorySize: c.virtualMemorySize,
    replacementAlgorithm: c.replacementAlgorithm, pageFaultTime: c.pageFaultTime,
    raid: { level: r.level, disks: r.disks, capacity: r.capacity } };
};

/** Every problem with a complete settings object (nothing is changed). */
function validateSettings(s) {
  const errs = [], int = Number.isInteger;
  if (!SPEEDS.includes(s.speed)) errs.push(`Speed must be one of ${SPEEDS.join(', ')}x.`);
  if (!ALGORITHMS[s.schedulingAlgorithm]) errs.push('Unknown CPU scheduling algorithm.');
  if (!(int(s.timeQuantum) && s.timeQuantum > 0)) errs.push('Time quantum must be a whole number greater than zero.');
  if (!LIVE_ALGORITHMS.includes(s.replacementAlgorithm)) errs.push('Page replacement algorithm must be FIFO, LRU or Optimal.');
  if (!(int(s.pageFaultTime) && s.pageFaultTime >= 1 && s.pageFaultTime <= 10)) errs.push('Page fault service time must be a whole number of ticks from 1 to 10.');
  errs.push(...mm.checkConfig(s.memorySize, s.pageSize, s.virtualMemorySize));
  return errs;
}

/** Validate everything first, then apply it (the RAID array first, because it is the only part that can still refuse). */
function applySettings(s) {
  const errs = validateSettings(s);
  if (errs.length) throw new Error(errs.join('\n'));
  const r = engine.state.raid.config;
  if (s.raid && (s.raid.level !== r.level || s.raid.disks !== r.disks || s.raid.capacity !== r.capacity)) raid.configure(s.raid);
  sched.configure({ schedulingAlgorithm: s.schedulingAlgorithm, timeQuantum: s.timeQuantum });
  vm.configure({ replacementAlgorithm: s.replacementAlgorithm, pageFaultTime: s.pageFaultTime });
  mm.applyConfig(s.memorySize, s.pageSize, s.virtualMemorySize);
  engine.setSpeed(s.speed);
  $('#speed').value = String(s.speed);
}

/** Turn an imported JSON document into a settings object (missing values keep their current setting). */
function parseImportedSettings(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  const src = doc && typeof doc === 'object' ? (doc.settings && typeof doc.settings === 'object' ? doc.settings : doc) : null;
  if (!src || Array.isArray(src)) throw new Error('That file does not contain simulator settings.');
  const cur = currentSettings(), out = { ...cur }, errs = [];
  const take = (k, type) => {
    if (!(k in src)) return;
    if (typeof src[k] !== type) errs.push(`"${k}" must be a ${type}.`); else out[k] = src[k];
  };
  ['speed', 'timeQuantum', 'memorySize', 'pageSize', 'virtualMemorySize', 'pageFaultTime'].forEach((k) => take(k, 'number'));
  ['schedulingAlgorithm', 'replacementAlgorithm'].forEach((k) => take(k, 'string'));
  if ('raid' in src) {
    const r = src.raid;
    if (r && typeof r === 'object' && ['level', 'disks', 'capacity'].every((k) => typeof r[k] === 'number')) out.raid = { level: r.level, disks: r.disks, capacity: r.capacity };
    else errs.push('"raid" must contain numeric level, disks and capacity.');
  }
  if (!Object.keys(src).some((k) => k in cur)) errs.push('No known settings were found in that file.');
  if (errs.length) throw new Error(errs.join('\n'));
  return out;
}

function settingsPage() {
  const s = currentSettings(), n = engine.state.processes.length;
  const sel = (name, opts, cur) => `<select name="${name}">${opts.map(([v, l]) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  const frames = s.pageSize ? Math.floor(s.memorySize / s.pageSize) : 0;
  return `<div class="info"><b>What is this?</b> One place for the simulator's configuration. <b>Apply settings</b> checks every value first and changes nothing if any of them is invalid. RAM, page size and virtual memory size depend on each other, so they are checked together. They can only change while no pages are loaded and no live processes exist (use <b>Reset</b> first).</div>
  ${ui.notice ? `<div class="ok-note">${esc(ui.notice)}</div>` : ''}
  <form id="setform">
   <div class="grid">
    <div class="card"><h2>Simulation</h2><div class="fields"><div><label>Speed</label>${sel('speed', SPEEDS.map((v) => [v, v + 'x']), s.speed)}</div></div></div>
    <div class="card"><h2>CPU scheduling</h2><div class="fields">
     <div><label>Algorithm</label>${sel('schedulingAlgorithm', Object.entries(ALGORITHMS).map(([k, a]) => [k, a.label]), s.schedulingAlgorithm)}</div>
     <div><label>Time quantum (Round Robin)</label><input name="timeQuantum" type="number" value="${s.timeQuantum}"></div></div></div>
    <div class="card"><h2>Memory</h2><div class="fields">
     <div><label>Physical memory / RAM (KB)</label><input name="memorySize" type="number" value="${s.memorySize}"></div>
     <div><label>Page / frame size (KB)</label><input name="pageSize" type="number" value="${s.pageSize}"></div>
     <div><label>Virtual memory size (KB)</label><input name="virtualMemorySize" type="number" value="${s.virtualMemorySize}"></div></div>
     <div class="calc">Currently ${s.memorySize} KB / ${s.pageSize} KB = <b>${frames} frames</b></div></div>
    <div class="card"><h2>Virtual memory</h2><div class="fields">
     <div><label>Page replacement</label>${sel('replacementAlgorithm', LIVE_ALGORITHMS.map((a) => [a, REPLACEMENT_ALGORITHMS[a].label]), s.replacementAlgorithm)}</div>
     <div><label>Page fault service time (ticks, 1–10)</label><input name="pageFaultTime" type="number" value="${s.pageFaultTime}"></div></div></div>
   </div>
   <div class="row"><button class="primary">Apply settings</button><span class="empty" style="padding:0">RAID: ${RAID_LEVELS[s.raid.level].label}, ${s.raid.disks} disks × ${s.raid.capacity} blocks (change it on the RAID page; it is included in export / import).</span></div>
   <div class="err">${esc(ui.error)}</div>
  </form>
  <div class="grid" style="margin-top:14px">
   <div class="card"><h2>Appearance &amp; behaviour</h2>
    <div class="fields"><div><label>Theme</label><select id="set-theme"><option value="light"${prefs.theme === 'light' ? ' selected' : ''}>Light</option><option value="dark"${prefs.theme === 'dark' ? ' selected' : ''}>Dark</option></select></div></div>
    <label class="check"><input type="checkbox" id="set-confirm"${prefs.confirm ? ' checked' : ''}> Ask for confirmation before destructive actions (reset, clear log, remove process, re-create RAID)</label></div>
   <div class="card"><h2>Quick actions</h2><div class="row">
    <button id="demo-load" title="Add five sample processes (P1–P5)">Load demo processes</button>
    <button id="ldownload"${engine.state.events.length ? '' : ' disabled'}>⬇ Download event log</button>
    <button id="lclear"${engine.state.events.length ? '' : ' disabled'}>Clear event log</button></div>
    <div class="row" style="margin-top:8px"><button class="danger" id="set-reset" title="Clears all processes and the log and restores the default settings">↻ Reset to defaults</button></div>
    <div class="empty" style="padding:6px 0 0;text-align:left">${n} process(es) and ${engine.state.events.length} log event(s) currently exist. Resetting removes them.</div></div>
   <div class="card"><h2>Export / import settings</h2><div class="row"><button id="set-export">⬇ Export settings (.json)</button></div>
    <div style="margin-top:10px"><label>Import settings from a .json file</label><input type="file" id="set-import" accept=".json,application/json"></div>
    <div class="empty" style="padding:6px 0 0;text-align:left">Importing is checked exactly like Apply settings.</div></div>
  </div>`;
}

const COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7'];
const colour = (pid) => (pid ? COLORS[(parseInt(pid.slice(1), 10) - 1) % COLORS.length] : '#e5e8ef');
const viz = new Visualizer(engine, { pm, mm, vm, raid, colour, esc });

function ganttView() {
  const g = engine.state.gantt;
  if (!g.length) return '<div class="empty">The Gantt chart appears once the simulation runs.</div>';
  return `<div class="gantt">${g.map((x) => `<div style="flex:${x.end - x.start};background:${colour(x.pid)}" title="${x.pid || 'idle'}: ${x.start}–${x.end}">${x.pid || 'idle'}</div>`).join('')}</div>
   <div class="gticks">${g.map((x) => `<span style="flex:${x.end - x.start}">${x.start}</span>`).join('')}<span class="last">${g[g.length - 1].end}</span></div>`;
}

function cpuPage() {
  const s = engine.state, c = s.config, st = sched.stats(), cpu = s.cpu;
  const queue = s.readyQueue.map((pid) => `<span class="badge s-READY">${pid}</span>`).join(' → ');
  const blocked = pm.list.filter((p) => p.state === 'WAITING' && p.wakeAt !== null).map((p) => `<span class="badge s-WAITING">${p.pid}</span>`).join(' ');
  return `<div class="info"><b>What is this?</b> CPU scheduling decides which ready process gets the CPU next. This is a <b>uniprocessor</b>: one CPU runs one process at a time. Each instruction of the running process references a page; if the page is not in a frame, a page fault blocks the process (WAITING) while another process uses the CPU. <b>${ALGORITHMS[c.schedulingAlgorithm].label}:</b> ${ALGORITHMS[c.schedulingAlgorithm].description}</div>
  <div class="card"><h2>Configuration</h2><form id="sform" class="fields">
   <div><label>Algorithm</label><select name="schedulingAlgorithm">${Object.entries(ALGORITHMS).map(([k, a]) => `<option value="${k}"${k === c.schedulingAlgorithm ? ' selected' : ''}>${a.label}</option>`).join('')}</select></div>
   <div><label>Time quantum (Round Robin)</label><input name="timeQuantum" type="number" value="${c.timeQuantum}"></div>
   <div><button class="primary">Apply</button></div></form>
   <div class="err">${esc(ui.error)}</div></div>
  <div class="grid"><div class="card"><h2>CPU</h2>Current: <b>${cpu.current || '—'}</b><br>State: <span class="badge ${cpu.current ? 's-RUNNING' : ''}">${cpu.state}</span>
   <br>Utilisation: <b>${cpu.utilisation}%</b><br>Busy ${cpu.busyTime} · Idle ${cpu.idleTime}</div>
   <div class="card"><h2>Ready queue</h2>${queue || '<span class="empty">Empty</span>'}</div>
   <div class="card"><h2>Blocked on a page fault</h2>${blocked || '<span class="empty">None</span>'}</div></div>
  <div class="card"><h2>Gantt chart</h2>${ganttView()}</div>
  <div class="card"><h2>Statistics</h2><div class="grid" style="margin-bottom:10px">
   <div>Avg waiting<div class="big">${st.avgWaiting}</div></div><div>Avg turnaround<div class="big">${st.avgTurnaround}</div></div>
   <div>Avg response<div class="big">${st.avgResponse}</div></div><div>Throughput<div class="big">${st.throughput}</div></div>
   <div>CPU utilisation<div class="big">${st.cpuUtilisation}%</div></div></div>
   ${st.rows.length ? `<table><thead><tr><th>PID</th><th>Completion</th><th>Waiting</th><th>Turnaround</th><th>Response</th></tr></thead><tbody>${st.rows.map((r) => `<tr><td>${r.pid}</td><td>${r.completion}</td><td>${r.waiting}</td><td>${r.turnaround}</td><td>${r.response}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Statistics appear as processes complete.</div>'}</div>`;
}

/** Load every page of a process that is still on disk into free frames (no page is evicted). */
function loadPages(p) {
  const t = mm.table(p.pid);
  if (!t) throw new Error(`${p.pid} has no page table yet.`);
  const need = t.filter((f) => f === null).length, free = mm.stats().free;
  if (!need) throw new Error(`All ${t.length} page(s) of ${p.pid} are already in RAM.`);
  if (need > free) throw new Error(`${p.pid} needs ${need} free frame(s) but only ${free} are free. Free some frames first (terminate a process) or use a larger RAM size.`);
  t.forEach((f, pg) => { if (f === null) vm.requestPage(p.pid, pg); });
}

function memPage() {
  const s = engine.state, c = s.config, st = mm.stats(), frames = s.memory.frames;
  const live = pm.list.filter((p) => mm.hasTable(p.pid));
  if (!(ui.memSel && mm.table(ui.memSel)) && live.length) ui.memSel = live[0].pid; // always show a page table when one exists
  const sel = ui.memSel && mm.table(ui.memSel) ? pm.get(ui.memSel) : null, x = ui.translation;
  const table = sel ? mm.table(sel.pid) : null;
  const freeList = frames.map((f, i) => (f.pid === null ? i : -1)).filter((i) => i >= 0);
  const usedList = frames.map((f, i) => (f.pid !== null ? i : -1)).filter((i) => i >= 0);
  const allocation = (p) => {
    const t = mm.table(p.pid);
    return `<div class="alloc"><b>Process ${p.pid}</b> (${esc(p.name)}, ${p.memoryRequired} KB) — pages = ceiling(${p.memoryRequired} / ${c.pageSize}) = ${p.pages}, ${mm.residentPages(p.pid)} in RAM
     ${t.map((f, pg) => f === null
    ? `<div class="alloc-row disk">Page ${pg} ─────► Disk (secondary storage, not in RAM)</div>`
    : `<div class="alloc-row ram">Page ${pg} ─────► Frame ${f}</div>`).join('')}</div>`;
  };
  return `<div class="info"><b>What is paging?</b> Physical memory is divided into fixed-size <i>frames</i> and every process into same-size <i>pages</i>. Each process has a <i>page table</i> that maps page → frame, so its pages can sit anywhere in memory and there is no external fragmentation. Pages are loaded <i>on demand</i> by the Virtual Memory manager (see the Virtual Memory page) the first time they are referenced, or you can load them yourself with the buttons below. Logical address = (page number, offset); physical address = frame × page size + offset. Units are KB. Create processes on the Processes page, then Start or Step the simulation.</div>
  <div class="card"><h2>Configuration</h2><form id="mform" class="fields">
   <div><label>Physical memory / RAM (KB)</label><input name="memorySize" type="number" value="${c.memorySize}"></div>
   <div><label>Page / frame size (KB)</label><input name="pageSize" type="number" value="${c.pageSize}"></div>
   <div><button class="primary">Apply</button></div></form>
   <div class="err">${esc(ui.error)}</div>
   <div class="calc"><b>Number of frames</b> = RAM / page size = ${c.memorySize} KB / ${c.pageSize} KB = <b>${st.frames} frames</b></div></div>
  <div class="card"><h2>Physical frames (${st.used}/${st.frames} used)</h2>
   <div class="legend"><span><i class="lg-ram"></i>Page in RAM (coloured by process)</span><span><i class="lg-free"></i>Free frame</span><span><i class="lg-disk"></i>Page on disk (secondary storage) — see tables below</span></div>
   <div class="frames">${frames.map((f, i) => f.pid
    ? `<div class="frame used" title="${f.pid} page ${f.page}" style="background:${colour(f.pid)};color:#fff">F${i}<br>${f.pid}:p${f.page}</div>`
    : `<div class="frame free" title="free frame">F${i}<br>free</div>`).join('')}</div></div>
  <div class="grid">
   <div class="card"><h2>Free-frame list (${freeList.length})</h2><div class="flist">${freeList.length ? freeList.map((i) => `<span class="badge fl-free">F${i}</span>`).join('') : '<span class="empty">None — RAM is full</span>'}</div></div>
   <div class="card"><h2>Occupied-frame list (${usedList.length})</h2><div class="flist">${usedList.length ? usedList.map((i) => `<span class="badge" style="background:${colour(frames[i].pid)};color:#fff" title="frame ${i} holds ${frames[i].pid} page ${frames[i].page}">F${i} ← ${frames[i].pid}:p${frames[i].page}</span>`).join('') : '<span class="empty">None — all frames are free</span>'}</div></div>
   <div class="card"><h2>Frames used</h2><div class="big">${st.used} / ${st.frames}</div>${st.utilisation}% of ${st.memorySize} KB</div>
   <div class="card"><h2>Internal fragmentation</h2><div class="big">${st.internalFragmentation} KB</div>unused part of each process's last page</div>
   <div class="card"><h2>Waiting for virtual memory</h2>${vm.stats().waiting.length ? vm.stats().waiting.map((p) => `<span class="badge s-WAITING">${p}</span>`).join(' ') : '<span class="empty">None</span>'}</div></div>
  <div class="card"><h2>Page-to-frame allocation</h2>
   <div class="row"><button id="mem-load-sel"${sel ? '' : ' disabled'}>Load all pages of ${sel ? sel.pid : 'selected process'} into RAM</button><button id="mem-load-all"${live.length ? '' : ' disabled'}>Load pages of every process (while frames are free)</button></div>
   ${live.length ? live.map(allocation).join('') : '<div class="empty">No process has an address space yet. Create processes on the Processes page.</div>'}</div>
  <div class="card"><h2>Process list (click a row to see its page table)</h2>${live.length ? `<table><thead><tr><th>PID</th><th>Name</th><th>Size</th><th>Pages</th><th>In RAM</th><th>On disk</th></tr></thead><tbody>${live.map((p) =>
    `<tr data-mpid="${p.pid}" class="${p.pid === ui.memSel ? 'sel' : ''}"><td>${p.pid}</td><td>${esc(p.name)}</td><td>${p.memoryRequired} KB</td><td>${p.pages}</td><td>${mm.residentPages(p.pid)}</td><td>${p.pages - mm.residentPages(p.pid)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No process has an address space yet. Create processes on the Processes page.</div>'}</div>
  ${sel ? `<div class="grid"><div class="card"><h2>Page table — ${sel.pid} (${esc(sel.name)})</h2><table class="pt"><thead><tr><th>Page</th><th>Frame</th><th>Valid Bit</th><th>Location</th></tr></thead><tbody>${table.map((f, p) =>
    `<tr class="${f === null ? 'pt-disk' : 'pt-ram'}"><td>${p}</td><td>${f === null ? '-' : f}</td><td>${f === null ? 0 : 1}</td><td>${f === null ? 'Disk' : 'RAM'}</td></tr>`).join('')}</tbody></table>
    <div class="empty" style="margin-top:6px">Valid bit 1 = page is in a RAM frame; 0 = page is on secondary storage (a reference causes a page fault).</div></div>
   <div class="card"><h2>Translate an address</h2><form id="xform" class="row"><input name="address" type="number" placeholder="0–${sel.memoryRequired - 1}" style="max-width:140px"><button class="primary">Translate</button></form>
   ${x && x.pid === sel.pid ? (x.resident ? `<div class="flow" style="margin-top:10px"><span class="badge">logical ${x.address}</span>→<span class="badge">page ${x.page} · offset ${x.offset}</span>→<span class="badge">page table: ${x.page} ↦ ${x.frame}</span>→<span class="badge s-RUNNING">physical ${x.physical}</span></div><div style="margin-top:6px">${x.frame} × ${c.pageSize} + ${x.offset} = ${x.physical}</div>`
     : `<div class="flow" style="margin-top:10px"><span class="badge">logical ${x.address}</span>→<span class="badge">page ${x.page} · offset ${x.offset}</span>→<span class="badge s-TERMINATED">page ${x.page} not in memory: page fault</span></div>`) : ''}</div></div>` : ''}`;
}

function demandView() {
  const c = engine.state.config, st = vm.stats(), rows = vm.processRows(), tr = engine.state.virtualMemory.trace.slice(-15).reverse();
  return `<div class="info"><b>What is virtual memory?</b> A process may be larger than the free physical memory: only the pages it is using need to be in frames. Every instruction references a page. If the page is not in a frame, a <i>page fault</i> occurs: the process blocks (WAITING) for the page-fault service time while the page is read from the backing store into a free frame or, if none is free, into the frame of a <i>victim</i> chosen by the replacement algorithm. <b>${REPLACEMENT_ALGORITHMS[c.replacementAlgorithm].label}:</b> ${REPLACEMENT_ALGORITHMS[c.replacementAlgorithm].description} Replacement is global (any process's page can be the victim).</div>
  <div class="card"><h2>Configuration</h2><form id="vcform" class="fields">
   <div><label>Virtual memory size (KB)</label><input name="virtualMemorySize" type="number" value="${c.virtualMemorySize}"></div>
   <div><label>Replacement algorithm</label><select name="replacementAlgorithm">${LIVE_ALGORITHMS.map((k) => `<option value="${k}"${k === c.replacementAlgorithm ? ' selected' : ''}>${REPLACEMENT_ALGORITHMS[k].label}</option>`).join('')}</select></div>
   <div><label>Page fault service time (ticks)</label><input name="pageFaultTime" type="number" value="${c.pageFaultTime}"></div>
   <div><button class="primary">Apply</button></div></form>
   <div class="err">${esc(ui.error)}</div></div>
  <div class="grid">
   <div class="card"><h2>Page faults</h2><div class="big">${st.faults}</div>fault rate ${st.faultRate}</div>
   <div class="card"><h2>Page hits</h2><div class="big">${st.hits}</div>${st.references} references</div>
   <div class="card"><h2>Replacements</h2><div class="big">${st.replacements}</div>pages evicted to make room</div>
   <div class="card"><h2>Virtual memory used</h2><div class="big">${st.usedPages} / ${st.capacityPages}</div>pages of ${st.capacityPages * c.pageSize} KB (${c.pageSize} KB each)${st.capacityPages * c.pageSize < c.virtualMemorySize ? `<br><small>limited by the RAID array (configured ${c.virtualMemorySize} KB)</small>` : ''}</div>
   <div class="card"><h2>Backing store: ${st.raid.label}</h2><div class="big"><span class="rs rs-${st.raid.status}">${st.raid.status}</span></div>${st.raid.reads} page-ins · ${st.raid.reconstructed} rebuilt from parity (+${st.raid.extraTicks} ticks) · ${st.raid.ioErrors} I/O errors<br><small>Configure it on the RAID page; a failed disk slows or kills page-ins.</small></div></div>
  <div class="card"><h2>Per process</h2>${rows.length ? `<table><thead><tr><th>PID</th><th>Name</th><th>Pages</th><th>In memory</th><th>Faults</th><th>Hits</th><th>Fault rate</th></tr></thead><tbody>${rows.map((r) =>
    `<tr><td>${r.pid}</td><td>${esc(r.name)}</td><td>${r.pages}</td><td>${r.resident}</td><td>${r.faults}</td><td>${r.hits}</td><td>${r.faultRate}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No process has an address space yet.</div>'}</div>
  <div class="card"><h2>Latest page references</h2>${tr.length ? `<table><thead><tr><th>Time</th><th>Process</th><th>Page</th><th>Result</th><th>Frame</th><th>Evicted</th><th>Backing store read</th></tr></thead><tbody>${tr.map((x) =>
    `<tr><td>${x.time}</td><td>${x.pid}</td><td>${x.page}</td><td><span class="badge ${x.fault ? 's-TERMINATED' : 's-RUNNING'}">${x.fault ? 'FAULT' : 'hit'}</span></td><td>${x.frame}</td><td>${x.evicted ? `${x.evicted.pid}:p${x.evicted.page}` : '—'}</td><td>${x.ioError ? '<span class="badge s-TERMINATED">I/O ERROR</span>' : x.disk != null ? `Disk ${x.disk + 1}${x.reconstructed ? ' <span class="badge s-WAITING">rebuilt from parity</span>' : ''}` : '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">References appear once a process runs.</div>'}</div>`;
}

function replacementView() {
  const v = engine.state.virtualMemory.lab, r = v.result, L = (x) => (v.labels ? v.labels[x] : x);
  const table = !r ? '<div class="empty">Run a simulation to see the frame-by-frame table.</div>' : `<div style="overflow-x:auto"><table class="vmtable"><tbody>
    <tr><th>Ref</th>${r.steps.map((s) => `<td><b>${L(s.ref)}</b></td>`).join('')}</tr>
    ${Array.from({ length: r.frameCount }, (_, f) => `<tr><th>Frame ${f}</th>${r.steps.map((s) => `<td class="${s.slot === f ? 'loaded' : ''}">${s.frames[f] === null || s.frames[f] === undefined ? '' : L(s.frames[f])}</td>`).join('')}</tr>`).join('')}
    <tr><th>Result</th>${r.steps.map((s) => `<td class="${s.fault ? 'fault' : 'hit'}">${s.fault ? 'F' : 'H'}</td>`).join('')}</tr></tbody></table></div>`;
  const cmp = r ? `<table><thead><tr><th>Algorithm</th><th>Page faults</th><th>Hits</th><th>Hit ratio</th></tr></thead><tbody>${Object.keys(REPLACEMENT_ALGORITHMS).map((k) => {
    const q = simulateReplacement(v.refs, v.frames, k);
    return `<tr class="${k === v.algorithm ? 'sel' : ''}"><td>${REPLACEMENT_ALGORITHMS[k].label}</td><td>${q.faults}</td><td>${q.hits}</td><td>${q.hitRatio}</td></tr>`;
  }).join('')}</tbody></table>` : '';
  return `<div class="info"><b>Page replacement lab.</b> Run FIFO, LRU or Optimal on any reference string, or replay the <b>real page references</b> of your processes (the last 100) with the real number of frames (${engine.state.memory.frames.length}) to compare what each algorithm <i>would</i> have done. <b>${REPLACEMENT_ALGORITHMS[v.algorithm].label}:</b> ${REPLACEMENT_ALGORITHMS[v.algorithm].description}</div>
  <div class="card"><h2>Page replacement</h2><form id="vmform" class="fields">
   <div style="grid-column:span 2"><label>Reference string</label><input name="refString" value="${v.labels ? '' : esc(v.refString)}" placeholder="${v.labels ? 'replaying the live trace — type a string to run your own' : '1 2 3 4 1 2 5 1'}"></div>
   <div><label>Frames (1–10)</label><input name="frames" type="number" value="${v.labels ? 3 : v.frames}"></div>
   <div><label>Algorithm</label><select name="algorithm">${Object.entries(REPLACEMENT_ALGORITHMS).map(([k, a]) => `<option value="${k}"${k === v.algorithm ? ' selected' : ''}>${a.label}</option>`).join('')}</select></div>
   <div class="row"><button class="primary">Run</button><button type="button" id="vm-example">Load classic example</button><button type="button" id="vm-trace">Replay live page references</button></div></form>
   <div class="err">${esc(ui.error)}</div></div>
  ${r ? `<div class="grid"><div class="card"><h2>Page faults</h2><div class="big">${r.faults}</div>fault ratio ${r.faultRatio}</div><div class="card"><h2>Page hits</h2><div class="big">${r.hits}</div>hit ratio ${r.hitRatio}</div></div>` : ''}
  <div class="card"><h2>Frames over time${v.labels ? ' (live trace, ' + v.frames + ' frames)' : ''}</h2>${table}</div>${r ? `<div class="card"><h2>Compare algorithms (same references and frames)</h2>${cmp}</div>` : ''}`;
}

function vmPage() {
  const tab = ui.vmTab;
  return `<div class="row" style="margin-bottom:14px"><button data-tab="demand" class="${tab === 'demand' ? 'primary' : ''}">Demand paging</button><button data-tab="replacement" class="${tab === 'replacement' ? 'primary' : ''}">Page replacement lab</button></div>`
    + (tab === 'demand' ? demandView() : replacementView());
}

// RAID ------------------------------------------------------------------------------------------------
const KIND = { data: 'Data', mirror: 'Mirror copy', parity: 'Parity (P)', parityQ: 'Parity (Q)', ecc: 'Hamming ECC' };
const METHOD = { single: 'none (no redundancy)', mirror: 'copy from a surviving mirror', xor: 'XOR of the surviving blocks', rs6: 'P (XOR) and Q (Reed-Solomon over GF(2⁸))', hamming: 'Hamming-code equations' };
const hex = (v) => (v === null || v === undefined ? '--' : v.toString(16).toUpperCase().padStart(2, '0'));

function raidDisks(R, A, ev) {
  const own = raid.owners(), multi = A.groups.length > 1 && A.groups[0].disks.length > 1;
  const head = (d) => {
    const x = R.disks[d], pct = Math.round((100 * x.progress) / A.rows);
    return `<th class="dh d-${x.status}">Disk ${d + 1}<div class="dstat">${x.status === 'FAILED' ? '[FAILED]' : x.status === 'REBUILDING' ? `[REBUILDING ${pct}%]` : 'online'}</div></th>`;
  };
  const cell = (c, d, r) => {
    const x = R.disks[d];
    if (x.status === 'FAILED') return '<td class="cell cx">✕</td>';
    if (x.status === 'REBUILDING' && r >= x.progress) return '<td class="cell cr">…</td>';
    const o = (c.kind === 'data' || c.kind === 'mirror') && c.lb !== null ? own[c.lb] : null;
    const tip = `${KIND[c.kind]} ${c.label}, value 0x${hex(R.store[d][r])}${o ? ` — page ${o.page} of ${o.pid} (backing store)` : ''}`;
    return `<td class="cell k-${c.kind}${x.status === 'REBUILDING' ? ' fresh' : ''}" title="${tip}"><b>${c.label}</b><small>${hex(R.store[d][r])}</small>${o ? `<i style="background:${colour(o.pid)}">${o.pid}·p${o.page}</i>` : ''}</td>`;
  };
  return `<div style="overflow-x:auto"><table class="raid"><thead>
   ${multi ? `<tr><th></th>${A.groups.map((g) => `<th class="gh g-${ev.groups[A.groups.indexOf(g)].state}" colspan="${g.disks.length}">${g.name.replace(/ \(disks.*/, '')}</th>`).join('')}</tr>` : ''}
   <tr><th class="rl"></th>${R.disks.map((_, d) => head(d)).join('')}</tr>
   <tr><td></td>${R.disks.map((x, d) => `<td class="act">${x.status === 'FAILED' ? `<button data-rrepl="${d}"${R.dataLost ? ' disabled' : ''} title="Insert a blank disk and rebuild it">Replace</button>` : `<button class="danger" data-rfail="${d}">Fail disk</button>`}</td>`).join('')}</tr></thead>
   <tbody>${A.cells.map((row, r) => `<tr><th class="rl">Row ${r + 1}</th>${row.map((c, d) => cell(c, d, r)).join('')}</tr>`).join('')}
   <tr><th class="rl">I/O</th>${R.disks.map((x) => `<td class="io">${x.reads}</td>`).join('')}</tr></tbody></table></div>
  <div class="legend">${['data', 'parity', 'parityQ', 'mirror', 'ecc'].filter((k) => A.cells.some((row) => row.some((c) => c.kind === k))).map((k) => `<span class="cell k-${k}">${KIND[k]}</span>`).join('')}<span class="cell cx">✕ failed disk</span><span class="cell cr">… not rebuilt yet</span> <small>small hex = stored byte (parity = XOR/Reed-Solomon of its stripe) · coloured tag = process page held in that block · I/O = disk reads served</small></div>`;
}

function raidStatus(R, A, ev) {
  const st = raid.stats(), im = raid.impact(), vr = raid.verifyRecovery(), crit = raid.criticalDisks();
  const failed = ev.failedDisks.map((d) => d + 1), bad = ev.groups.filter((g) => g.state === 'FAILED');
  const deg = ev.groups.filter((g) => g.state === 'DEGRADED');
  let why;
  if (ev.status === 'OPTIMAL') why = `All ${st.disks} disks are online. ${st.label} survives ${st.guaranteed === st.best ? st.best : `${st.guaranteed} failure(s) in the worst case and up to ${st.best} if they are in different groups`}${st.best === 0 ? ' (it has no redundancy)' : ''}.`;
  else if (ev.status === 'DEGRADED') why = `Disk${failed.length > 1 ? 's' : ''} ${failed.join(', ')} ${failed.length > 1 ? 'are' : 'is'} ${ev.rebuilding ? 'failed or still rebuilding' : 'failed'}, but every ${st.label} group is within its tolerance, so all data is still available${im.reconstructed ? ` (${im.reconstructed} block(s) are rebuilt on the fly from the surviving disks, which is slower)` : ''}. ${crit.length ? `Another failure of Disk${crit.length > 1 ? 's' : ''} ${crit.map((d) => d + 1).join(', ')} would destroy the array.` : 'It can still survive another failure.'}`;
  else why = R.dataLost && !bad.length ? 'Data was lost earlier; replacing disks cannot bring it back. Re-create the array.' : `${bad.map((g) => `${g.name}: ${g.failed.length} disk(s) failed but only ${g.tolerance} can be tolerated`).join('; ')}. Data has been lost and the array is offline.`;
  return `<div class="grid"><div class="card rstatus rs-${ev.status}"><h2>System Status:</h2><div class="big">${ev.status}${ev.rebuilding ? ' <small>(rebuilding)</small>' : ''}</div><p>${why}</p>
    <div class="row">${ev.rebuilding ? '<button id="raid-rebuild" title="Normally the simulation clock drives the rebuild (1 row per tick)">Complete rebuild now</button>' : ''}${R.dataLost ? '<button id="raid-recreate" class="danger">Re-create array (data is lost)</button>' : ''}</div>
    ${ev.rebuilding ? '<small>The rebuild advances one row per simulation tick: press Start or Step.</small>' : ''}</div>
   <div class="card"><h2>Effect on the data</h2><div class="big">${im.availability}%</div>of ${im.total} blocks readable<table style="margin-top:6px"><tbody>
    <tr><th>Read directly</th><td>${im.direct}</td></tr><tr><th>Rebuilt on the fly</th><td>${im.reconstructed}</td></tr><tr><th>Lost / unreadable</th><td><b style="color:${im.unreadable ? '#b3261e' : 'inherit'}">${im.unreadable}</b></td></tr></tbody></table></div>
   <div class="card"><h2>Reconstruction check</h2>${vr.checked + vr.unrecoverable === 0 ? '<span class="empty" style="padding:0">No disk is missing.</span>' : vr.unrecoverable ? `<b style="color:#b3261e">${vr.unrecoverable} block(s) cannot be recomputed.</b>` : `<div class="big" style="color:#18703a">${vr.matched}/${vr.checked}</div>blocks of the missing disk(s) recomputed from the survivors and compared with the original`}
    <div style="margin-top:6px"><small>Method: ${METHOD[A.groups[0].type]}</small></div></div></div>
  <div class="card"><h2>Redundancy groups</h2><table><thead><tr><th>Group</th><th>Failed disks</th><th>Failed / tolerated</th><th>State</th></tr></thead><tbody>${ev.groups.map((g) =>
    `<tr><td>${g.name}</td><td>${g.failed.length ? g.failed.map((d) => d + 1).join(', ') : '—'}</td><td>${g.failed.length} / ${g.tolerance}</td><td><span class="rs rs-${g.state === 'OK' ? 'OPTIMAL' : g.state}">${g.state}</span></td></tr>`).join('')}</tbody></table>
   <small>The array is FAILED when any one group has more failed disks than it tolerates, so for RAID 10, 50 and 60 the <i>position</i> of the failures matters.</small></div>`;
}

function raidLink() {
  const st = raid.stats(), v = vm.stats(), c = engine.state.config, R = raid.r;
  const rows = Object.entries(R.swap).map(([pid, bl]) => ({ pid, p: pm.get(pid), bl }));
  return `<div class="card"><h2>How the array is used by the rest of the system</h2>
   <div class="info" style="margin-bottom:10px">The array is the <b>backing store</b> of virtual memory. One block = one page (${c.pageSize} KB), so the array offers <b>${st.usableBlocks} pages (${st.usableKB} KB)</b> of address space (virtual memory limit: ${v.capacityPages} pages). Every page of a process owns one block. A page fault reads that block: from a healthy disk it takes the normal ${c.pageFaultTime} ticks; if the block is on a failed disk it is rebuilt from the surviving disks (each extra block read adds a tick); if the array has FAILED the read errors out and the process is aborted. New processes cannot be admitted while the array is offline.</div>
   <div class="grid" style="margin-bottom:10px"><div>Page-ins<div class="big">${st.reads}</div></div><div>Read directly<div class="big">${st.direct}</div></div><div>Rebuilt from parity<div class="big">${st.reconstructed}</div></div><div>Extra ticks<div class="big">${st.extraTicks}</div></div><div>I/O errors<div class="big" style="color:${st.ioErrors ? '#b3261e' : 'inherit'}">${st.ioErrors}</div></div></div>
   ${rows.length ? `<table><thead><tr><th>PID</th><th>State</th><th>Pages</th><th>Backing-store blocks (page → block on disk)</th></tr></thead><tbody>${rows.map(({ pid, p, bl }) => `<tr><td>${pid}</td><td>${p ? badge(p.state) : ''}</td><td>${bl.length}</td><td>${bl.map((lb, pg) => { const L = raid.array.logical[lb], d = L.disks.length > 1 && !L.span ? L.disks.map((x) => x + 1).join('/') : L.disks[0] + 1; return `<span class="badge" style="background:${colour(pid)};color:#fff;margin:1px" title="page ${pg} → block ${raid.labelOf(lb)}, row ${L.row + 1}">p${pg}→${raid.labelOf(lb)}${L.span ? '' : `@D${d}`}</span>`; }).join(' ')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No process has an address space yet. Create processes on the Processes page (or load the demo processes) and Start the simulation to watch page-ins hit the array.</div>'}</div>`;
}

function raidCompare(R) {
  const c = R.config;
  return `<div class="card"><h2>Compare levels for ${c.disks} disks × ${c.capacity} blocks</h2><table><thead><tr><th>Level</th><th>Usable</th><th>Efficiency</th><th>Survives (worst / best)</th></tr></thead><tbody>${LEVEL_IDS.map((l) => {
    const d = describe(l, c.disks, c.capacity);
    return `<tr class="${l === c.level ? 'sel' : ''}"><td><b>${RAID_LEVELS[l].label}</b> <small>${RAID_LEVELS[l].name}</small></td>${d.valid ? `<td>${d.usable} blocks (${d.usable * engine.state.config.pageSize} KB)</td><td>${d.efficiency}%</td><td>${d.guaranteed} / ${d.best} disk(s)</td>` : `<td colspan="3" style="color:var(--mut)"><small>${esc(d.error)}</small></td>`}</tr>`;
  }).join('')}</tbody></table></div>`;
}

function raidPage() {
  const R = raid.r, A = raid.array, ev = raid.evaluation(), c = R.config;
  return `<div class="info"><b>What is RAID?</b> A RAID array combines several disks into one logical disk to gain speed, capacity or fault tolerance. <b>${RAID_LEVELS[c.level].label} – ${RAID_LEVELS[c.level].name}:</b> ${RAID_LEVELS[c.level].description} Use <i>Fail disk</i> on any disk: the status is computed from the level, the number of failed disks and <i>which</i> disks failed.</div>
  <div class="card"><h2>Array configuration</h2><form id="raform" class="fields">
   <div style="grid-column:span 2"><label>RAID level</label><select name="level">${LEVEL_IDS.map((l) => `<option value="${l}"${l === c.level ? ' selected' : ''}>${RAID_LEVELS[l].label} – ${RAID_LEVELS[l].name}</option>`).join('')}</select></div>
   <div><label>Number of disks (2–${MAX_DISKS})</label><input name="disks" type="number" value="${c.disks}"></div>
   <div><label>Disk capacity (blocks, 1–${MAX_CAPACITY}; 1 block = ${engine.state.config.pageSize} KB)</label><input name="capacity" type="number" value="${c.capacity}"></div>
   <div><button class="primary">Apply</button></div></form>
   <div class="err">${esc(ui.error)}</div>
   <small>${c.disks} disks × ${c.capacity} blocks = ${c.disks * c.capacity * engine.state.config.pageSize} KB raw → <b>${raid.usableBlocks} usable blocks (${raid.usableBlocks * engine.state.config.pageSize} KB)</b>${A.groups.length > 1 && c.level !== 0 ? ` · ${A.groups.length} groups` : ''}</small></div>
  ${raidStatus(R, A, ev)}
  <div class="card"><h2>Disks</h2>${raidDisks(R, A, ev)}</div>
  ${raidLink()}${raidCompare(R)}`;
}

const VIEWS = { RAID: raidPage, 'Virtual Memory': vmPage, Memory: memPage, 'CPU & Scheduling': cpuPage, Dashboard: dashboard, Processes: processes, 'Event Log': eventLog, Settings: settingsPage };

function render(force = false) {
  renderTopbar();
  const ae = document.activeElement;
  // Don't wipe a form the user is typing in while the simulation ticks.
  if (!force && ae && ae.closest?.('#page') && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
  if (ui.page !== 'Visualization') viz.deactivate();
  $('#nav').innerHTML = PAGES.map((p) => `<a data-page="${p}" class="${p === ui.page ? 'active' : ''}${READY_PAGES.includes(p) ? '' : ' soon'}">${p}</a>`).join('');
  if (ui.page === 'Visualization') {   // the visualisation keeps its own DOM (animations must survive state changes)
    if (!$('#page .viz')) { $('#page').innerHTML = '<h2>Visualization</h2><div class="viz"></div>'; viz.mount($('#page .viz')); }
    viz.activate($('#page .viz'));
    return;
  }
  const keep = document.activeElement?.id;
  $('#page').innerHTML = `<h2>${ui.page}</h2>` + (VIEWS[ui.page]?.() ?? `<div class="card empty">This module is built in a later phase.</div>`);
  if (keep && $('#' + keep)) { const el = $('#' + keep); el.focus(); if (el.setSelectionRange && el.type === 'text') el.setSelectionRange(el.value.length, el.value.length); }
}

// Delegated events (survive re-rendering) -----------------------------------
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.dataset.page) { ui.page = t.dataset.page; ui.error = ''; ui.notice = ''; render(true); }
  else if (t.dataset.rfail !== undefined) guard(() => raid.failDisk(Number(t.dataset.rfail)));
  else if (t.dataset.rrepl !== undefined) guard(() => raid.replaceDisk(Number(t.dataset.rrepl)));
  else if (t.id === 'raid-rebuild') guard(() => raid.completeRebuild());
  else if (t.id === 'raid-recreate') { if (confirmDialog('Re-create the array? Everything stored on it is lost; processes that still need those pages will be aborted.')) guard(() => raid.reinitialise()); }
  else if (t.closest('tr[data-pid]')) { ui.selected = t.closest('tr').dataset.pid; render(true); }
  else if (t.dataset.tab) { ui.vmTab = t.dataset.tab; ui.error = ''; render(true); }
  else if (t.closest('tr[data-mpid]')) { ui.memSel = t.closest('tr').dataset.mpid; ui.translation = null; render(true); }
  else if (t.id === 'vm-example') guard(() => vm.run({ refString: '7 0 1 2 0 3 0 4 2 3 0 3 2 1 2 0 1 7 0 1', frames: 3, algorithm: 'FIFO' }));
  else if (t.id === 'vm-trace') guard(() => vm.runTrace(engine.state.virtualMemory.lab.algorithm));
  else if (t.id === 'demo-load') guard(() => [
    // name, arrivalTime, burstTime, priority, memoryRequired (KB)
    ['P1', 0, 8, 2, 12],
    ['P2', 1, 5, 1, 8],
    ['P3', 2, 12, 3, 20],
    ['P4', 3, 6, 2, 16],
    ['P5', 4, 10, 4, 24],
  ].forEach(([name, arrivalTime, burstTime, priority, memoryRequired]) =>
    pm.create({ name, arrivalTime, burstTime, priority, memoryRequired })));
  else if (t.id === 'mem-load-sel') guard(() => loadPages(pm.get(ui.memSel)));
  else if (t.id === 'mem-load-all') guard(() => {
    let loaded = 0;
    for (const p of pm.list.filter((q) => mm.hasTable(q.pid))) {
      const need = mm.table(p.pid).filter((f) => f === null).length;
      if (need && need <= mm.stats().free) { loadPages(p); loaded++; }
    }
    if (!loaded) throw new Error('Nothing to load: every process is fully in RAM, or there are not enough free frames for any remaining process.');
  });
  else if (t.dataset.to) guard(() => pm.transition(ui.selected, t.dataset.to));
  else if (t.dataset.remove !== undefined) {
    if (confirmDialog(`Remove ${ui.selected}?`)) guard(() => { pm.remove(ui.selected); ui.selected = null; });
  } else if (t.id === 'set-export') {
    guard(() => { saveFile('os-simulator-settings.json', JSON.stringify({ app: 'os-simulator', version: 1, exported: new Date().toISOString(), settings: currentSettings() }, null, 2) + '\n', 'application/json'); ui.notice = 'Settings exported.'; });
  } else if (t.id === 'set-reset') {
    if (confirmDialog('Reset to defaults? This clears all processes and the event log and restores the default settings.')) guard(() => {
      Object.assign(engine.state.config, DEFAULT_CONFIG);
      ui.selected = null; ui.memSel = null; ui.translation = null;
      engine.reset(); engine.setSpeed(1); $('#speed').value = '1';
      ui.notice = 'Everything was reset to the default settings.';
    });
  } else if (t.id === 'ldownload') { guard(() => downloadLog());
  } else if (t.id === 'lclear') { if (confirmDialog('Clear the event log?')) { engine.state.events.length = 0; render(true); } }
});
document.addEventListener('submit', (e) => {
  const F = e.target.id, fd = () => Object.fromEntries(new FormData(e.target));
  if (['xform', 'vcform', 'mform', 'vmform', 'raform'].includes(F)) {
    e.preventDefault();
    const d = fd();
    if (F === 'mform') guard(() => mm.configure({ memorySize: Number(d.memorySize), pageSize: Number(d.pageSize) }));
    if (F === 'vcform') guard(() => vm.configure({ virtualMemorySize: Number(d.virtualMemorySize), replacementAlgorithm: d.replacementAlgorithm, pageFaultTime: Number(d.pageFaultTime) }));
    if (F === 'xform') guard(() => { ui.translation = mm.translate(ui.memSel, d.address === '' ? NaN : Number(d.address)); });
    if (F === 'raform') guard(() => raid.configure({ level: Number(d.level), disks: Number(d.disks), capacity: Number(d.capacity) }));
    if (F === 'vmform') guard(() => vm.run({ refString: d.refString, frames: Number(d.frames), algorithm: d.algorithm }));
    return;
  }
  if (e.target.id === 'setform') {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    guard(() => {
      applySettings({ ...currentSettings(), speed: Number(d.speed), schedulingAlgorithm: d.schedulingAlgorithm, timeQuantum: Number(d.timeQuantum),
        memorySize: Number(d.memorySize), pageSize: Number(d.pageSize), virtualMemorySize: Number(d.virtualMemorySize),
        replacementAlgorithm: d.replacementAlgorithm, pageFaultTime: Number(d.pageFaultTime) });
      ui.notice = 'Settings applied.';
    });
    return;
  }
  if (e.target.id === 'sform') {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    guard(() => sched.configure({ schedulingAlgorithm: d.schedulingAlgorithm, timeQuantum: Number(d.timeQuantum) }));
    return;
  }
  if (e.target.id !== 'pform') return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  guard(() => { ui.selected = pm.create(data).pid; });
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'psearch') { ui.search = e.target.value; render(true); }
  if (e.target.id === 'lsearch') { ui.logSearch = e.target.value; render(true); }
});
document.addEventListener('change', (e) => {
  const id = e.target.id;
  if (id === 'lfilter') { ui.logFilter = e.target.value; render(true); }
  else if (id === 'set-theme') { prefs.theme = e.target.value; savePrefs(); applyTheme(); render(true); }
  else if (id === 'set-confirm') { prefs.confirm = e.target.checked; savePrefs(); render(true); }
  else if (id === 'set-import') {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then((text) => guard(() => {
      const imported = parseImportedSettings(text);
      const errs = validateSettings(imported);
      if (errs.length) throw new Error('Import failed:\n' + errs.join('\n'));
      if (!confirmDialog(`Apply the settings from "${file.name}"?`)) return;
      applySettings(imported);
      ui.notice = `Settings imported from ${file.name}.`;
    })).catch(() => { ui.error = 'Could not read that file.'; render(true); });
  }
});

// Re-render only when the simulation state changes (not on every event).
engine.bus.on('STATE_CHANGED', () => render());
engine.log('SYSTEM_READY', 'Simulator ready');
render(true);
