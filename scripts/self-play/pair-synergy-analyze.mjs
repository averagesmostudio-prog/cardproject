// Mines recorded self-play games (run.mjs --record-decks) for card PAIRS that
// win more together than their individual strengths predict.
//
//   node scripts/self-play/pair-synergy-analyze.mjs <out-dir> [<out-dir> ...] [--top=40] [--min=300] [--json=path]
//
// For every pair (a, b) inside one color-pool stratum, the interaction
//     lift = P(win | a&b) - P(win | a&!b) - P(win | !a&b) + P(win | !a&!b)
// is the difference-in-differences of the 2x2 table: 0 when the two cards'
// effects simply add up, positive when having both is better than the sum
// of having each. Strata (the deck's color-pool key) are analysed separately
// and then pooled by inverse variance, so a deck-archetype confound (two
// cards that are only ever drafted together) cannot masquerade as synergy.
// Each cell needs `--min` decks or the pair is dropped; a lift is only
// reported when it clears --zmin standard errors (default 3).

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const dirs = args.filter((a) => !a.startsWith('--'));
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};
const TOP = parseInt(opt('top', '40'), 10);
const MIN_CELL = parseInt(opt('min', '300'), 10);
const JSON_OUT = opt('json', null);
const Z_MIN = parseFloat(opt('zmin', '3')); // 0 dumps every tested pair (for split-half replication checks)
if (dirs.length === 0) {
  console.error('Usage: pair-synergy-analyze.mjs <out-dir> [<out-dir> ...] [--top=N] [--min=N] [--json=path]');
  process.exit(1);
}

// stratum -> { N, W, n: Map(card -> count), w: Map(card -> wins), np: Map("a|b" -> count), wp: Map("a|b" -> wins) }
const strata = new Map();
const strat = (key) => {
  let s = strata.get(key);
  if (!s) { s = { N: 0, W: 0, n: new Map(), w: new Map(), np: new Map(), wp: new Map() }; strata.set(key, s); }
  return s;
};
const bump = (m, k, v) => m.set(k, (m.get(k) || 0) + v);

const addDeck = (key, cards, win) => {
  const s = strat(key);
  const ids = [...new Set(cards)].sort();
  s.N += 1;
  s.W += win;
  for (let i = 0; i < ids.length; i += 1) {
    bump(s.n, ids[i], 1);
    bump(s.w, ids[i], win);
    for (let j = i + 1; j < ids.length; j += 1) {
      const k = `${ids[i]}|${ids[j]}`;
      bump(s.np, k, 1);
      bump(s.wp, k, win);
    }
  }
};

let games = 0;
let used = 0;
for (const dir of dirs) {
  const file = path.join(dir, 'games.jsonl');
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    games += 1;
    let g;
    try { g = JSON.parse(line); } catch { continue; }
    if (!g.cardsA || !g.cardsB || !g.pairKeyA || !g.pairKeyB) continue;
    const winA = g.winner === 'A' ? 1 : g.winner === 'B' ? 0 : 0.5;
    addDeck(g.pairKeyA, g.cardsA, winA);
    addDeck(g.pairKeyB, g.cardsB, 1 - winA);
    used += 1;
  }
}
console.error(`Read ${games} games, ${used} with recorded decks, ${strata.size} strata.`);

const nameOf = (id) => String(id).split('__')[0];

// pair -> { num: sum(lift/var), den: sum(1/var), cells: total n(a&b), strata: [...] }
const pooled = new Map();
for (const [key, s] of strata) {
  for (const [pair, nab] of s.np) {
    const [a, b] = pair.split('|');
    const na = s.n.get(a); const nb = s.n.get(b);
    const n11 = nab; const n10 = na - nab; const n01 = nb - nab; const n00 = s.N - na - nb + nab;
    if (n11 < MIN_CELL || n10 < MIN_CELL || n01 < MIN_CELL || n00 < MIN_CELL) continue;
    const wab = s.wp.get(pair); const wa = s.w.get(a); const wb = s.w.get(b);
    const p11 = wab / n11; const p10 = (wa - wab) / n10; const p01 = (wb - wab) / n01; const p00 = (s.W - wa - wb + wab) / n00;
    const lift = p11 - p10 - p01 + p00;
    const v = (p) => Math.max(p * (1 - p), 0.05);
    const variance = v(p11) / n11 + v(p10) / n10 + v(p01) / n01 + v(p00) / n00;
    let acc = pooled.get(pair);
    if (!acc) { acc = { num: 0, den: 0, n11: 0, strata: [] }; pooled.set(pair, acc); }
    acc.num += lift / variance;
    acc.den += 1 / variance;
    acc.n11 += n11;
    acc.strata.push(key);
  }
}

const rows = [...pooled.entries()].map(([pair, acc]) => {
  const [a, b] = pair.split('|');
  const lift = acc.num / acc.den;
  const se = Math.sqrt(1 / acc.den);
  return { a: nameOf(a), b: nameOf(b), lift, se, z: lift / se, n: acc.n11, strata: acc.strata.length };
}).filter((r) => Math.abs(r.z) >= Z_MIN);

rows.sort((x, y) => y.lift - x.lift);
const fmt = (r) => `${r.a} + ${r.b}   lift ${(100 * r.lift).toFixed(1)}pts  (se ${(100 * r.se).toFixed(1)}, z ${r.z.toFixed(1)}, n=${r.n}, ${r.strata} pool${r.strata > 1 ? 's' : ''})`;
console.log(`\n=== Pairs tested: ${pooled.size}   significant (|z|>=${Z_MIN}): ${rows.length} ===`);
console.log(`\nTop ${TOP} POSITIVE synergies (better together than apart):`);
rows.filter((r) => r.lift > 0).slice(0, TOP).forEach((r) => console.log('  ' + fmt(r)));
console.log(`\nTop ${TOP} NEGATIVE interactions (anti-synergy / redundancy):`);
rows.filter((r) => r.lift < 0).slice(-TOP).reverse().forEach((r) => console.log('  ' + fmt(r)));
if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify(rows, null, 1));
  console.error(`Wrote ${rows.length} rows to ${JSON_OUT}`);
}
