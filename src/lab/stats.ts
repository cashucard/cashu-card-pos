export interface Stats {
  n: number;
  min: number;
  median: number;
  p90: number;
  max: number;
  mean: number;
}

const round = (x: number): number => Math.round(x * 100) / 100;

/** The numbers of a list of timings, in ms, each rounded to 0.01. */
export function summarize(xs: readonly number[]): Stats {
  const n = xs.length;
  if (n === 0) {
    return { n: 0, min: 0, median: 0, p90: 0, max: 0, mean: 0 };
  }
  const s = xs.slice().sort((a, b) => a - b);
  const median = n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const p90 = s[Math.ceil(0.9 * n) - 1];
  let sum = 0;
  for (const x of s) {
    sum += x;
  }
  return {
    n,
    min: round(s[0]),
    median: round(median),
    p90: round(p90),
    max: round(s[n - 1]),
    mean: round(sum / n),
  };
}
