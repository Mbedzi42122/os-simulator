/**
 * Pure RAID logic (no engine, no UI): block layouts, parity maths, failure evaluation and stripe recovery.
 *
 * An array is described as a list of GROUPS. Data is striped (RAID 0) across the groups; each group protects
 * its own disks with one scheme and can lose at most `tolerance` disks:
 *   single  - one disk, no redundancy (RAID 0)            mirror  - every disk holds a copy (RAID 1, 10)
 *   xor     - XOR parity (RAID 3, 4, 5, 50)               rs6     - P (XOR) + Q (Reed-Solomon, GF(2^8)) (RAID 6, 60)
 *   hamming - Hamming ECC disks (RAID 2)
 * The array is FAILED as soon as one group has lost more disks than it tolerates, so the *location* of failed
 * disks matters for RAID 10, 50 and 60 and not for the others.
 */
export const MAX_DISKS = 16;
export const MIN_CAPACITY = 1, MAX_CAPACITY = 32;

export const RAID_LEVELS = {
  0: { label: 'RAID 0', name: 'Striping', description: 'Blocks are striped across all disks. Fastest and uses all the capacity, but has no redundancy: one failed disk loses the array.' },
  1: { label: 'RAID 1', name: 'Mirroring', description: 'Every disk holds a complete copy of the data. Capacity of one disk; survives the loss of all but one disk.' },
  2: { label: 'RAID 2', name: 'Bit-level striping + Hamming ECC', description: 'Each logical block is split into slices over the data disks and Hamming-code ECC disks (at the power-of-two positions) protect them. Tolerates one failed disk (textbook single-error-correcting model).' },
  3: { label: 'RAID 3', name: 'Byte-level striping + dedicated parity', description: 'Each logical block is split into byte slices across the data disks; one dedicated disk stores XOR parity. Tolerates one failed disk.' },
  4: { label: 'RAID 4', name: 'Block-level striping + dedicated parity', description: 'Whole blocks are striped; one dedicated disk stores the parity of each stripe (it becomes the write bottleneck). Tolerates one failed disk.' },
  5: { label: 'RAID 5', name: 'Block striping + distributed parity', description: 'Like RAID 4 but the parity block rotates across the disks. Tolerates one failed disk.' },
  6: { label: 'RAID 6', name: 'Block striping + double distributed parity', description: 'Two independent parity blocks per stripe (P = XOR, Q = Reed-Solomon). Tolerates two failed disks.' },
  10: { label: 'RAID 10', name: 'Striped mirrors (1+0)', description: 'Disks are paired into mirrors and the pairs are striped. Survives one failure per pair, but losing both disks of a pair loses the array.' },
  50: { label: 'RAID 50', name: 'Striped RAID 5 sub-arrays (5+0)', description: 'Several equal RAID 5 sub-arrays striped together. Survives one failure per sub-array.' },
  60: { label: 'RAID 60', name: 'Striped RAID 6 sub-arrays (6+0)', description: 'Several equal RAID 6 sub-arrays striped together. Survives two failures per sub-array.' },
};
export const LEVEL_IDS = Object.keys(RAID_LEVELS).map(Number);

const isPow2 = (n) => (n & (n - 1)) === 0;
/** Smallest number (>= 2) of equal groups whose size is at least minSize. */
export function splitGroups(n, minSize) {
  for (let g = 2; g * minSize <= n; g++) if (n % g === 0) return { count: g, size: n / g };
  return null;
}

/** Returns an error message, or null when `level` can be built from `n` disks. */
export function checkDisks(level, n) {
  if (!RAID_LEVELS[level]) return 'Unknown RAID level.';
  if (!Number.isInteger(n) || n < 2 || n > MAX_DISKS) return `The number of disks must be a whole number from 2 to ${MAX_DISKS}.`;
  const L = RAID_LEVELS[level].label;
  if ((level === 3 || level === 4 || level === 5) && n < 3) return `${L} needs at least 3 disks.`;
  if (level === 6 && n < 4) return 'RAID 6 needs at least 4 disks.';
  if (level === 2 && (n < 3 || isPow2(n))) return 'RAID 2 needs at least 3 disks and the count cannot be a power of two (the Hamming parity disks sit at positions 1, 2, 4, 8…). Use 3, 5, 6, 7 or 9–15 disks.';
  if (level === 10 && (n < 4 || n % 2)) return 'RAID 10 needs an even number of disks, at least 4 (mirrored pairs).';
  if (level === 50 && !splitGroups(n, 3)) return `RAID 50 needs equal RAID 5 sub-arrays of at least 3 disks (at least 6 disks); ${n} disks cannot be split that way.`;
  if (level === 60 && !splitGroups(n, 4)) return `RAID 60 needs equal RAID 6 sub-arrays of at least 4 disks (at least 8 disks); ${n} disks cannot be split that way.`;
  return null;
}

// GF(2^8), polynomial 0x11d, generator 2 (used for the RAID 6 Q parity) ----------------------
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const gdiv = (a, b) => (a === 0 ? 0 : EXP[(LOG[a] - LOG[b] + 255) % 255]);
const g2 = (i) => EXP[i % 255];
const xor = (vals) => vals.reduce((a, b) => a ^ b, 0);
/** Deterministic content of a data block / slice. */
export const byteOf = (k) => (Math.imul(k + 1, 2654435761) >>> 24) & 255;

// Groups ----------------------------------------------------------------------------------------
export function makeGroups(level, n) {
  const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
  const disks = (a, b) => range(a, b).map((d) => d + 1).join(', ');
  const sub = (type, size, tol, what) => Array.from({ length: n / size }, (_, i) => ({ type, disks: range(i * size, (i + 1) * size), tolerance: tol, name: `${what} ${i + 1} (disks ${disks(i * size, (i + 1) * size)})` }));
  switch (level) {
    case 0: return range(0, n).map((d) => ({ type: 'single', disks: [d], tolerance: 0, name: `Disk ${d + 1}` }));
    case 1: return [{ type: 'mirror', disks: range(0, n), tolerance: n - 1, name: `Mirror set (disks ${disks(0, n)})` }];
    case 2: return [{ type: 'hamming', disks: range(0, n), tolerance: 1, name: `Hamming group (disks ${disks(0, n)})` }];
    case 3: return [{ type: 'xor', span: true, rotating: false, disks: range(0, n), tolerance: 1, name: `Parity group (disks ${disks(0, n)})` }];
    case 4: return [{ type: 'xor', rotating: false, disks: range(0, n), tolerance: 1, name: `Parity group (disks ${disks(0, n)})` }];
    case 5: return [{ type: 'xor', rotating: true, disks: range(0, n), tolerance: 1, name: `Parity group (disks ${disks(0, n)})` }];
    case 6: return [{ type: 'rs6', rotating: true, disks: range(0, n), tolerance: 2, name: `P+Q group (disks ${disks(0, n)})` }];
    case 10: return sub('mirror', 2, 1, 'Mirror pair');
    case 50: { const s = splitGroups(n, 3); return sub('xor', s.size, 1, 'RAID 5 sub-array').map((g) => ({ ...g, rotating: true })); }
    case 60: { const s = splitGroups(n, 4); return sub('rs6', s.size, 2, 'RAID 6 sub-array').map((g) => ({ ...g, rotating: true })); }
    default: throw new Error('Unknown RAID level.');
  }
}

/** Fill one stripe of one group. Returns { row, gi, type, tolerance, span, members[] }. */
function fillStripe(group, gi, row, ctx) {
  const D = group.disks, m = D.length, members = [];
  const add = (disk, kind, label, value, extra = {}) => { const x = { disk, kind, label, value, gi, row, lb: null, ...extra }; members.push(x); return x; };
  switch (group.type) {
    case 'single': { const lb = ctx.lb++; add(D[0], 'data', `A${lb + 1}`, byteOf(lb), { lb }); break; }
    case 'mirror': { const lb = ctx.lb++, v = byteOf(lb); D.forEach((d, i) => add(d, i === 0 ? 'data' : 'mirror', `A${lb + 1}`, v, { lb })); break; }
    case 'xor': {
      const pi = group.rotating ? m - 1 - (row % m) : m - 1, data = [];
      D.forEach((d, i) => {
        if (i === pi) return;
        const lb = ctx.lb++;
        data.push(add(d, 'data', group.span ? `A${row + 1}.${data.length + 1}` : `A${lb + 1}`, byteOf(lb), { lb, idx: data.length }));
      });
      ctx.p++;
      add(D[pi], 'parity', group.span ? `P${row + 1}` : `P${ctx.p}`, xor(data.map((x) => x.value)), { role: 'P' });
      members.sort((a, b) => a.disk - b.disk);
      break;
    }
    case 'rs6': {
      const pi = m - 1 - (row % m), qi = (pi + 1) % m, data = [];
      D.forEach((d, i) => { if (i !== pi && i !== qi) { const lb = ctx.lb++; data.push(add(d, 'data', `A${lb + 1}`, byteOf(lb), { lb, idx: data.length })); } });
      ctx.p++; ctx.q++;
      add(D[pi], 'parity', `P${ctx.p}`, xor(data.map((x) => x.value)), { role: 'P' });
      add(D[qi], 'parityQ', `Q${ctx.q}`, xor(data.map((x) => gmul(g2(x.idx), x.value))), { role: 'Q' });
      members.sort((a, b) => a.disk - b.disk);
      break;
    }
    case 'hamming': {
      const slices = [];
      D.forEach((d, i) => { if (!isPow2(i + 1)) { const lb = ctx.lb++; slices.push(add(d, 'data', `A${row + 1}.${slices.length + 1}`, byteOf(lb), { lb, idx: slices.length, pos: i + 1 })); } });
      D.forEach((d, i) => {
        const pos = i + 1;
        if (!isPow2(pos)) return;
        const j = Math.log2(pos);
        add(d, 'ecc', `H${row + 1}.${j + 1}`, xor(slices.filter((s) => s.pos & pos).map((s) => s.value)), { pos, role: `H${j}` });
      });
      members.sort((a, b) => a.disk - b.disk);
      break;
    }
    default: throw new Error('Unknown group type.');
  }
  members.forEach((x) => { if (x.pos === undefined) x.pos = D.indexOf(x.disk) + 1; });
  return { row, gi, type: group.type, span: !!group.span, tolerance: group.tolerance, members };
}

/** Build the whole array layout. `rows` = blocks per disk. */
export function buildArray(level, n, rows) {
  const err = checkDisks(level, n);
  if (err) throw new Error(err);
  const groups = makeGroups(level, n), ctx = { lb: 0, p: 0, q: 0 };
  const stripes = [], cells = [], logical = [];
  for (let r = 0; r < rows; r++) {
    const rowStripes = groups.map((g, gi) => fillStripe(g, gi, r, ctx));
    stripes.push(rowStripes);
    const rowCells = Array(n);
    for (const s of rowStripes) for (const x of s.members) rowCells[x.disk] = x;
    cells.push(rowCells);
    for (const s of rowStripes) {
      if (s.span || s.type === 'hamming') {      // byte/bit-level striping: every access spins up all data disks of the row
        const dm = s.members.filter((x) => x.kind === 'data');
        for (const x of dm) logical[x.lb] = { lb: x.lb, row: r, gi: s.gi, disks: dm.map((y) => y.disk), span: true };
      } else {
        const byLb = new Map();
        for (const x of s.members) if (x.lb !== null && (x.kind === 'data' || x.kind === 'mirror')) { if (!byLb.has(x.lb)) byLb.set(x.lb, []); byLb.get(x.lb).push(x.disk); }
        for (const [lb, ds] of byLb) logical[lb] = { lb, row: r, gi: s.gi, disks: ds, span: false };
      }
    }
  }
  return { level, n, rows, groups, stripes, cells, logical, logicalBlocks: logical.length };
}

/** Blocks a logical read touches when nothing has failed (RAID 2/3 read every data disk in parallel). */
export const normalIOs = (array, lb) => (array.logical[lb].span ? array.logical[lb].disks.length : 1);

// Failure evaluation --------------------------------------------------------------------------
/** `unavailable` = Set of disk indexes that are failed (or still being rebuilt). */
export function evaluate(array, unavailable) {
  const groups = array.groups.map((g) => {
    const failed = g.disks.filter((d) => unavailable.has(d));
    const state = failed.length === 0 ? 'OK' : failed.length > g.tolerance ? 'FAILED' : 'DEGRADED';
    return { name: g.name, type: g.type, disks: g.disks, tolerance: g.tolerance, failed, state };
  });
  const status = groups.some((g) => g.state === 'FAILED') ? 'FAILED' : groups.some((g) => g.state === 'DEGRADED') ? 'DEGRADED' : 'OPTIMAL';
  return { status, groups, failedDisks: [...unavailable].sort((a, b) => a - b) };
}

/** Failures survived in the worst case / the best case, derived from the group structure. */
export function tolerance(array) {
  return { guaranteed: Math.min(...array.groups.map((g) => g.tolerance)), best: array.groups.reduce((a, g) => a + g.tolerance, 0) };
}

// Stripe recovery (real parity maths) ----------------------------------------------------------
/**
 * Recompute the contents of the `missing` disks of one stripe from the surviving ones.
 * `val(disk)` returns the stored byte of a surviving disk. Returns Map(disk -> byte) or null if unrecoverable.
 */
export function recoverStripe(stripe, val, missing) {
  const M = stripe.members, gone = M.filter((x) => missing.has(x.disk)), out = new Map();
  if (!gone.length) return out;
  if (gone.length > stripe.tolerance) return null;
  const alive = M.filter((x) => !missing.has(x.disk));
  switch (stripe.type) {
    case 'single': return null;
    case 'mirror': gone.forEach((x) => out.set(x.disk, val(alive[0].disk))); return out;
    case 'xor': out.set(gone[0].disk, xor(alive.map((x) => val(x.disk)))); return out;
    case 'hamming': {
      const x = gone[0], j = Math.log2(x.pos & -x.pos);               // any equation that contains this position
      out.set(x.disk, xor(M.filter((o) => o !== x && (o.pos & (1 << j))).map((o) => val(o.disk))));
      return out;
    }
    case 'rs6': {
      const data = M.filter((x) => x.kind === 'data'), P = M.find((x) => x.role === 'P'), Q = M.find((x) => x.role === 'Q');
      const lostData = data.filter((x) => missing.has(x.disk)), D = new Map(data.filter((x) => !missing.has(x.disk)).map((x) => [x.idx, val(x.disk)]));
      const sumP = () => xor([...D.values()]), sumQ = () => xor([...D].map(([i, v]) => gmul(g2(i), v)));
      if (lostData.length === 1) {
        const i = lostData[0].idx;
        D.set(i, !missing.has(P.disk) ? val(P.disk) ^ sumP() : gdiv(val(Q.disk) ^ sumQ(), g2(i)));
      } else if (lostData.length === 2) {
        const [a, b] = lostData.map((x) => x.idx), pxy = val(P.disk) ^ sumP(), qxy = val(Q.disk) ^ sumQ();
        const db = gdiv(qxy ^ gmul(g2(a), pxy), g2(a) ^ g2(b));
        D.set(b, db); D.set(a, pxy ^ db);
      }
      for (const x of lostData) out.set(x.disk, D.get(x.idx));
      if (missing.has(P.disk)) out.set(P.disk, sumP());
      if (missing.has(Q.disk)) out.set(Q.disk, sumQ());
      return out;
    }
    default: return null;
  }
}

/** Compact facts about a level/disk-count (used by the comparison table). */
export function describe(level, n, rows) {
  const err = checkDisks(level, n);
  if (err) return { valid: false, error: err };
  const a = buildArray(level, n, rows), t = tolerance(a);
  return { valid: true, usable: a.logicalBlocks, raw: n * rows, efficiency: +((100 * a.logicalBlocks) / (n * rows)).toFixed(1), ...t, groups: a.groups.length };
}
