/**
 * In-process ring of recent row-rule evaluate timings, per child collection.
 * The per-request trace ring only keeps requests slower than TRACE_SLOW_MS,
 * so a rule pass that costs 800ms on every keystroke never shows up there —
 * this is the surface that would have caught the 2.7s workflow-lines pass.
 * Per replica, like the trace buffer; nothing is persisted.
 */
interface Sample {
  at: number
  ms: number
  queries: number
  rules: number
  mode: 'live' | 'open' | 'probe' | 'explain' | 'create' | 'update' | 'apply'
}

const RING = 500
const samples = new Map<string, Sample[]>()

export function recordRuleEvalSample(collection: string, sample: Sample): void {
  const list = samples.get(collection) ?? []
  list.push(sample)
  if (list.length > RING) list.splice(0, list.length - RING)
  samples.set(collection, list)
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
  return sorted[i]
}

export function ruleEvalStats() {
  const out: Array<{
    collection: string
    count: number
    avg_ms: number
    p50_ms: number
    p95_ms: number
    max_ms: number
    avg_queries: number
    rules: number
    last_at: number
    by_mode: Record<string, number>
  }> = []
  for (const [collection, list] of samples) {
    const ms = list.map((s) => s.ms).sort((a, b) => a - b)
    const byMode: Record<string, number> = {}
    for (const s of list) byMode[s.mode] = (byMode[s.mode] ?? 0) + 1
    out.push({
      collection,
      count: list.length,
      avg_ms: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length),
      p50_ms: pct(ms, 0.5),
      p95_ms: pct(ms, 0.95),
      max_ms: ms[ms.length - 1],
      avg_queries: Math.round((list.reduce((a, s) => a + s.queries, 0) / list.length) * 10) / 10,
      rules: list[list.length - 1].rules,
      last_at: list[list.length - 1].at,
      by_mode: byMode
    })
  }
  return out.sort((a, b) => b.p95_ms - a.p95_ms)
}

export function clearRuleEvalStats(): void {
  samples.clear()
}
