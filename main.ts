// gta6-twitch-ccu-forecast-01: forecast Grand Theft Auto VI's launch-day Twitch
// viewers, hour by hour.
//
// Model (v2, size-dependent): a lognormal-quantile forecaster anchored on
// hour 1's print p1:
//   q_tau(h) = p1 * exp(MED[h](p1) + z_tau * SD[h]),  h = 2..24
//   tau in (0.05, 0.25, 0.5, 0.75, 0.95), z the standard normal quantiles.
//
// Why size-dependent: a launch's release-day shape depends strongly on its
// hour-1 size. Across the kit's 37 comparable past big launches (SullyGnome
// hourly Twitch category averages), the late rise (hour 19 / hour 1) is
// ~7.5x for a 23k hour-1 launch, ~2.8x at 117k, ~2.1x at 119k, ~1.65x at
// 270k, and ~0.94-1.31x above 320k. A single shape for every p1 (v1's fixed
// blend, ~1.4x late) badly underpredicts small launches and is only right
// for huge ones. So MED[h] is now a smooth blend of two medians — BIG_MED
// (12 launches, hour 1 in [10k, 100k)) and HUGE_MED (16 launches, hour 1
// >= 100k) — with a logistic weight on log10(p1) centred at 100k:
//   w(p1) = 1 / (1 + exp(-(log10(p1) - 5.0) / 0.3))
// Small launches lean on BIG_MED (late rise ~2.8x), huge ones on HUGE_MED
// (late rise ~1.25x, mid-day dip ~0.5x). GTA VI's hour 1 is in the millions
// (live read ~2.7M), so w ~ 0.99: the forecast is essentially the HUGE
// shape — a mid-day dip to ~0.5x, recovering to ~1.26x by hour 19 — which
// is the honest extrapolation for a launch far beyond every comparable.
// SD[h] is the per-hour residual standard deviation around the
// size-dependent median, pooled over the 28 launches with hour 1 >= 10k.
//
// Validation (mean pinball loss, log scale, on the kit's four practice
// launches — Wolverine, RDR2, God of War Ragnarok, Spider-Man 2 — which are
// NOT in the 37 comparables, so this is out-of-sample):
//   v2 (this model):  0.132 (Wolverine 0.234, RDR2 0.124, GoW 0.076, SM2 0.095)
//   v1 (fixed blend): 0.178 (Wolverine 0.382, RDR2 0.149, GoW 0.072, SM2 0.107)
//   house baseline (persistence, 0.15*sqrt(h-1) spread): 0.194
// v2 beats v1 by 25% and the house by 32% on the practice set, and its
// shape for GTA's size is the HUGE regime, the closest to a multi-million
// launch. One shape per size, no per-launch tuning: the logistic centre
// (100k) and scale (0.3) are fixed, not fitted to the practice cases.
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
 * BIG_MED[h - 2]: median log ratio log(viewers_h / viewers_1) for launches
 * whose hour 1 had 10,000–99,999 viewers (12 comparable launches),
 * hours 2..24.
 */
const BIG_MED = [
  -0.1902, -0.3458, -0.2981, -0.199, -0.0684, -0.0766, -0.0671, -0.1374,
  -0.1303, -0.1105, -0.0276, 0.0834, 0.2147, 0.4207, 0.5428, 0.5672,
  0.631, 1.037, 1.0205, 1.0155, 1.0054, 0.947, 0.8546,
];

/**
 * HUGE_MED[h - 2]: median log ratio log(viewers_h / viewers_1) for launches
 * whose hour 1 had >= 100,000 viewers (16 comparable launches),
 * hours 2..24.
 */
const HUGE_MED = [
  -0.1009, -0.2721, -0.3643, -0.3674, -0.3761, -0.506, -0.5884, -0.6606,
  -0.6772, -0.6745, -0.562, -0.4507, -0.241, -0.1816, -0.1063, 0.1016,
  0.1372, 0.2271, 0.1797, 0.2145, 0.1696, 0.0863, 0.1298,
];

/**
 * SD[h - 2]: per-hour log spread, the residual standard deviation around
 * the size-dependent median, pooled over the 28 comparable launches with
 * hour 1 >= 10,000, hours 2..24.
 */
const SD = [
  0.1984, 0.3227, 0.3163, 0.3449, 0.5065, 0.5349, 0.5239, 0.5385,
  0.5563, 0.5687, 0.5898, 0.623, 0.6542, 0.6691, 0.6522, 0.6211,
  0.5722, 0.5785, 0.6153, 0.6109, 0.5787, 0.5529, 0.5549,
];

/** Logistic weight on log10(p1): 0 = pure BIG shape, 1 = pure HUGE shape. */
const hugeWeight = (p1: number): number => {
  const x = Math.log10(Math.max(p1, 1));
  return 1 / (1 + Math.exp(-(x - 5.0) / 0.3));
};

/** Median log ratio for hour h given hour 1's print p1. */
const medFor = (p1: number, h: number): number => {
  const w = hugeWeight(p1);
  return (1 - w) * BIG_MED[h - 2] + w * HUGE_MED[h - 2];
};

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
  const med = medFor(p1, h);
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
