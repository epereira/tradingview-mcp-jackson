#!/usr/bin/env node
// Statistiques nettes de frais sur un ou plusieurs journaux de replay.
//
//   node scalp-lab/stats.js                       -> tous les journaux sauf example.json
//   node scalp-lab/stats.js journal/2025-06-10.json [autres...]
//
// Les trades marqués "tag": "undisciplined" sont exclus des stats (mais comptés à part).

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(join(here, 'rules.json'), 'utf8'));
const { tick_value, commission_per_side, assumed_slippage_ticks_per_side } = rules.fees;

const args = process.argv.slice(2);
const files = args.length
  ? args.map((f) => resolve(f))
  : readdirSync(join(here, 'journal'))
      .filter((f) => f.endsWith('.json') && f !== 'example.json')
      .map((f) => join(here, 'journal', f));

if (!files.length) {
  console.error('Aucun journal trouvé dans scalp-lab/journal/ (example.json est ignoré par défaut).');
  process.exit(1);
}

// Coût d'un aller-retour : 2 commissions + slippage supposé des deux côtés, exprimé en ticks.
const roundTripCostTicks = (2 * commission_per_side) / tick_value + 2 * assumed_slippage_ticks_per_side;

const all = [];
let undisciplined = 0;
for (const file of files) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  for (const t of j.trades ?? []) {
    if (t.tag === 'undisciplined') { undisciplined++; continue; }
    all.push({ ...t, session: j.session?.date ?? file });
  }
}

const net = all.map((t) => t.ticks - roundTripCostTicks);
const wins = net.filter((x) => x > 0);
const losses = net.filter((x) => x <= 0);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const avg = (a) => (a.length ? sum(a) / a.length : 0);
const fmt = (x) => (Math.round(x * 100) / 100).toFixed(2);

const winRate = all.length ? wins.length / all.length : 0;
const avgWin = avg(wins);
const avgLoss = Math.abs(avg(losses));
const expectancy = avg(net);
const payoff = avgLoss ? avgWin / avgLoss : Infinity;
const grossTicks = sum(all.map((t) => t.ticks));
const netTicks = sum(net);

// Pire série de pertes consécutives (nettes).
let worstStreak = 0, streak = 0;
for (const x of net) { streak = x <= 0 ? streak + 1 : 0; worstStreak = Math.max(worstStreak, streak); }

// Drawdown max sur le cumul net.
let peak = 0, cum = 0, maxDD = 0;
for (const x of net) { cum += x; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }

console.log(`Journaux           : ${files.length}`);
console.log(`Trades comptés     : ${all.length}  (exclus "undisciplined": ${undisciplined})`);
console.log(`Coût aller-retour  : ${fmt(roundTripCostTicks)} ticks (${fmt(roundTripCostTicks * tick_value)} $)`);
console.log('');
console.log(`Win rate (net)     : ${fmt(winRate * 100)} %`);
console.log(`Gain moyen (net)   : +${fmt(avgWin)} ticks`);
console.log(`Perte moyenne (net): -${fmt(avgLoss)} ticks`);
console.log(`Ratio gain/perte   : ${payoff === Infinity ? '∞' : fmt(payoff)}`);
console.log(`Espérance / trade  : ${fmt(expectancy)} ticks (${fmt(expectancy * tick_value)} $)`);
console.log('');
console.log(`P&L brut           : ${fmt(grossTicks)} ticks (${fmt(grossTicks * tick_value)} $)`);
console.log(`P&L net            : ${fmt(netTicks)} ticks (${fmt(netTicks * tick_value)} $)`);
console.log(`Pire série pertes  : ${worstStreak}`);
console.log(`Drawdown max (net) : ${fmt(maxDD)} ticks`);
console.log('');
console.log(expectancy > 0
  ? 'Verdict : espérance nette positive sur cet échantillon — à confirmer sur plus de sessions.'
  : 'Verdict : espérance nette négative ou nulle — la stratégie perd de l\'argent après frais.');
