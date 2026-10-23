// The test harness: named cases, each a list of checks; a case that throws is a failed check with
// the error; cases can be skipped with a reason (an untestable feature in this mode). Results are
// plain JSON for report.mjs.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class Suite {
  constructor(name, { only = null } = {}) {
    this.name = name
    this.only = only
    this.cases = []
    this.metrics = {}
    this.notes = []
    this.started_at = new Date().toISOString()
  }

  /**
   * Run one case. fn(t) gets { check, metric, note, cleanup }; cleanups run even when fn throws.
   * @param {string} name
   * @param {(t: any) => Promise<void>} fn
   * @param {{ skip?: string|false, timeoutMs?: number }} [o]
   */
  async case(name, fn, { skip = false, timeoutMs = 120_000 } = {}) {
    if (this.only && !this.only.some((o) => name.includes(o))) return
    const c = { name, status: 'pass', checks: [], metrics: {}, ms: 0, error: null, skip: null }
    this.cases.push(c)
    if (skip) {
      c.status = 'skip'
      c.skip = skip
      console.log(`SKIP  ${this.name} › ${name} — ${skip}`)
      return
    }
    const cleanups = []
    const t = {
      check: (label, ok, detail) => {
        c.checks.push({ label, ok: !!ok, detail: detail === undefined ? null : detail })
        return !!ok
      },
      metric: (k, v) => {
        c.metrics[k] = v
      },
      note: (text) => this.notes.push(`${name}: ${text}`),
      cleanup: (f) => cleanups.push(f)
    }
    const t0 = performance.now()
    try {
      await Promise.race([
        fn(t),
        sleep(timeoutMs).then(() => {
          throw new Error(`case timed out after ${timeoutMs} ms`)
        })
      ])
    } catch (e) {
      c.error = e?.stack?.split('\n').slice(0, 3).join(' | ') ?? String(e)
    }
    for (const f of cleanups.reverse()) {
      try {
        await f()
      } catch (e) {
        c.checks.push({ label: 'cleanup', ok: false, detail: e.message })
      }
    }
    c.ms = Math.round(performance.now() - t0)
    if (c.error || c.checks.some((x) => !x.ok)) c.status = 'fail'
    if (!c.error && c.checks.length === 0) c.status = 'fail'
    const icon = c.status === 'pass' ? 'PASS' : 'FAIL'
    console.log(`${icon}  ${this.name} › ${name} (${c.ms} ms)`)
    for (const x of c.checks)
      if (!x.ok || process.env.RTCI_VERBOSE)
        console.log(`        ${x.ok ? 'ok ' : 'NOT'} ${x.label}${x.detail != null ? ` — ${fmt(x.detail)}` : ''}`)
    if (c.error) console.log(`        error: ${c.error}`)
  }

  result(extra = {}) {
    const counts = { pass: 0, fail: 0, skip: 0 }
    for (const c of this.cases) counts[c.status]++
    return {
      suite: this.name,
      started_at: this.started_at,
      ended_at: new Date().toISOString(),
      verdict: counts.fail ? 'fail' : 'pass',
      counts,
      cases: this.cases,
      metrics: this.metrics,
      notes: this.notes,
      ...extra
    }
  }
}

function fmt(d) {
  const s = typeof d === 'string' ? d : JSON.stringify(d)
  return s.length > 300 ? `${s.slice(0, 300)}…` : s
}

/** Percentiles of a numeric array: { n, p50, p95, p99, max, mean }. */
export function pct(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return { n: 0, p50: null, p95: null, p99: null, max: null, mean: null }
  const at = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))]
  return {
    n: v.length,
    p50: Math.round(at(0.5)),
    p95: Math.round(at(0.95)),
    p99: Math.round(at(0.99)),
    max: Math.round(v[v.length - 1]),
    mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length)
  }
}

export async function poll(fn, { timeoutMs = 10_000, everyMs = 250 } = {}) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    try {
      last = await fn()
      if (last) return last
    } catch {}
    await sleep(everyMs)
  }
  return last ?? null
}
