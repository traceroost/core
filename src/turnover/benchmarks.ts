/**
 * Published turnover benchmark bands (AL 06). One place to change them — these are sourced
 * figures and they will move.
 *
 * Sources (as of 2026): industry write-ups on AI-authored code churn put 30-day churn for
 * agent-written code in the 12–18% band, with "healthy" (comparable to human-authored code)
 * under ~15%; the 90-day figure settles around 22%. Update this module, and the citation, when
 * a better number is published.
 */

export interface BenchmarkBand {
  windowDays: 30 | 90
  /** The typical range, as fractions (0.12 = 12%). */
  low: number
  high: number
  /** At or below this, turnover is "healthy" — comparable to human-authored code. */
  healthyUnder: number
}

export const BENCHMARKS: Record<30 | 90, BenchmarkBand> = {
  30: { windowDays: 30, low: 0.12, high: 0.18, healthyUnder: 0.15 },
  90: { windowDays: 90, low: 0.20, high: 0.24, healthyUnder: 0.22 },
}

export function benchmarkFor(windowDays: 30 | 90): BenchmarkBand {
  return BENCHMARKS[windowDays]
}

/** A short verdict for a rate against its band. */
export function benchmarkVerdict(rate: number, windowDays: 30 | 90): 'healthy' | 'typical' | 'elevated' {
  const b = benchmarkFor(windowDays)
  if (rate <= b.healthyUnder) return 'healthy'
  if (rate <= b.high) return 'typical'
  return 'elevated'
}
