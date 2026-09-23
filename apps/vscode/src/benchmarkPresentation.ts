export interface BenchmarkViewResult {
  medianMs: number | null;
  outputSha1: string | null;
  outputsMatch: boolean;
}

export function benchmarkSpeedup(baseline: BenchmarkViewResult | undefined, result: BenchmarkViewResult): number | null {
  if (!baseline || !baseline.outputsMatch || !result.outputsMatch || baseline.outputSha1 !== result.outputSha1 || baseline.medianMs === null || result.medianMs === null || result.medianMs <= 0) return null;
  return baseline.medianMs / result.medianMs;
}
