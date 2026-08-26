/** Nearest-rank percentiles. The median is the headline everywhere: a mean over browser
 *  timings is dominated by GC pauses and JIT-compile outliers, which are not the signal. */
export interface Stats {
  readonly n: number;
  readonly min: number;
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
  readonly stddev: number;
}

function pct(sorted: readonly number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
}

export function summarize(values: readonly number[]): Stats {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const mean = n === 0 ? 0 : s.reduce((a, b) => a + b, 0) / n;
  const variance = n === 0 ? 0 : s.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return {
    n,
    min: s[0] ?? 0,
    p50: pct(s, 50),
    p90: pct(s, 90),
    p95: pct(s, 95),
    max: s[n - 1] ?? 0,
    mean: round(mean),
    stddev: round(Math.sqrt(variance)),
  };
}

export function round(x: number): number {
  return Math.round(x * 100) / 100;
}
