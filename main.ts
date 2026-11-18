// gta6-twitch-ccu-forecast-01: forecast Grand Theft Auto VI's launch-day Twitch
// viewers, hour by hour.
//
// Model: a lognormal-quantile forecaster anchored on hour 1's print p1:
//   q_tau(h) = p1 * exp(MED[h] + z_tau * SD[h]),  h = 2..24
//   tau in (0.05, 0.25, 0.5, 0.75, 0.95), z the standard normal quantiles.
//
// Where MED and SD come from: the kit's 37 comparable past big launches
// (SullyGnome hourly Twitch category averages, release-day curves). For each
// launch and hour, the log ratio log(viewers_h / viewers_1) was taken; MED[h]
// is the blend (log-space mean) of two medians: the 28 launches whose hour 1
// already had >= 10,000 viewers, and the 16 whose hour 1 had >= 100,000.
// SD[h] is the same blend of the two groups' per-hour residual standard
// deviations (k = 1.0, no tuning beyond that). Two regimes because the shape
// depends on launch size: small hour-1 launches explode later (median ratio
// 2.4x by hour 19), huge ones stay near flat (0.5x mid-day dip, ~1.25x by
// hour 19). GTA VI's hour 1 will be in the millions, so the blend leans on
// the huge-launch shape without trusting only 16 curves.
//
// Backtest on the same 37 comparable curves (mean pinball loss, log scale):
//   this model:  0.106 on huge launches (h1 >= 100k), 0.151 on big (>= 10k)
//   house baseline (persistence, 0.15*sqrt(h-1) spread): 0.131 / 0.175
// Leave-one-out on the huge set: 0.117 vs the house's 0.131, so the edge is
// not self-influence. The house's own practice number for its baseline is
// ~0.387 on the four practice cases; the comparable backtest is a different
// sample, so the two numbers are not directly comparable. One shape for
// every p1, no size interpolation: the final's p1 is in the millions, beyond
// every comparable, so any size rule would extrapolate on six or fewer
// launches; the blend is the honest middle and beats the house on every
// regime backtested.
//
// Live anchor (not used by the program; it reads p1 from the case file):
// Twitch's public directory count for the GTA VI category, read 2026-11-18
// 16:35 and 16:39 UTC, averaged 2,703,843 viewers / ~13,025 channels,
// up from 1,240 viewers at the house's 2026-11-17 probe. New Zealand
// unlocked 11:00 UTC that day, so the category was already live before
// hour 1 of the UTC release day.
//
// Runs offline, standard library only, deterministic: the same case file
// always writes the same bytes. Outside the grader's container,
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

/**
 * MED[h - 2]: median log ratio log(viewers_h / viewers_1), blended from the
 * big-launch (h1 >= 10k) and huge-launch (h1 >= 100k) medians, hours 2..24.
 */
const MED = [
  -0.1123, -0.3015, -0.3468, -0.3125, -0.2922, -0.3789, -0.4183, -0.483,
  -0.4897, -0.4395, -0.3237, -0.2448, -0.1005, -0.0146, 0.058, 0.1847,
  0.2311, 0.3368, 0.3056, 0.3266, 0.3386, 0.3228, 0.1756,
];

/**
 * SD[h - 2]: per-hour log spread, blended from the two groups' residual
 * standard deviations, hours 2..24.
 */
const SD = [
  0.2038, 0.2924, 0.3011, 0.3179, 0.4629, 0.5243, 0.5161, 0.5282,
  0.5468, 0.5524, 0.5609, 0.5541, 0.5641, 0.5808, 0.5745, 0.5424,
  0.5254, 0.5548, 0.5858, 0.573, 0.5688, 0.548, 0.5497,
];

interface Case {
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  history_hourly?: Array<{ viewers: number }>;
  history?: Array<{ viewers: number }>;
}

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** The five quantiles for one hour h, given hour 1's print p1. */
const hourQuantiles = (p1: number, h: number): number[] => {
  const med = MED[h - 2];
  const sd = SD[h - 2];
  return Z.map((z) => {
    const q = round2(p1 * Math.exp(med + z * sd));
    return Math.min(1e9, Math.max(0.01, q));
  });
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  const first = c.known.find((k) => k.hour === 1);
  // Fallback: if hour 1 has no print (recorder gap), anchor on the last
  // pre-checkpoint hourly mean instead of failing the case.
  const fallback = c.history_hourly?.at(-1)?.viewers ?? c.history?.at(-1)?.viewers;
  const p1 = Math.max(1, first?.viewers ?? fallback ?? 1);
  const hours = c.forecast.map(({ hour }) => ({ hour, q: hourQuantiles(p1, hour) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
