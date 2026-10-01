// api/src/services/traffic-ai.ts
/**
 * The Ask AI `traffic_snapshot` tool (#1168, administrators only): "who hit forecasts hardest
 * today", "which callers are erroring right now". Live figures come from the Traffic Map ring
 * (last 15 minutes, this store); anything longer reads the request log (traffic-window.ts).
 * Read-only, and compact — the model gets the top rows with labels, never raw logs.
 */
import { buildSnapshot } from './traffic-map.js'
import { labelCallers, readWindowGrouped, summarizeWindow } from './traffic-window.js'

const TOP = 10

export interface TrafficToolInput {
  entity?: unknown
  hours?: unknown
  top?: unknown
}

/** `workflows`, `items/workflows` or a GraphQL operation name → a matcher on entity keys. */
export function entityMatcher(raw: unknown): ((key: string) => boolean) | null {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!s) return null
  return (key: string) => {
    const k = key.toLowerCase()
    return k === s || k.endsWith(`/${s}`)
  }
}

export async function trafficSnapshotTool(
  input: TrafficToolInput
): Promise<{ result: unknown; summary: string }> {
  const hours = Math.min(24, Math.max(0, Math.round(Number(input.hours ?? 0)) || 0))
  const top = Math.min(25, Math.max(1, Math.round(Number(input.top ?? TOP)) || TOP))
  const match = entityMatcher(input.entity)

  type Row = {
    key: string
    req: number
    error: number
    p95?: number
    callers: Array<{ key: string; n: number }>
  }
  let source: string
  let rows: Row[]
  let callers: Array<{ key: string; req: number; error: number }>
  let truncated = false
  if (hours === 0) {
    const s = buildSnapshot(900, { sockets: 0, users: 0, journalSeq: null })
    source = 'live map, last 15 minutes, this API process'
    rows = s.entities.map((e) => ({
      key: e.key,
      req: e.req,
      error: e.error,
      p95: e.p95,
      callers: e.callers
    }))
    callers = s.callers
  } else {
    const to = new Date()
    const from = new Date(to.getTime() - hours * 3600_000)
    const g = await readWindowGrouped(from, to)
    const w = summarizeWindow(g.rows, from, to, g.truncated)
    source = `request log, last ${hours} hour${hours === 1 ? '' : 's'}`
    truncated = w.truncated
    rows = w.entities.map((e) => ({ key: e.key, req: e.req, error: e.error, callers: e.callers }))
    callers = w.callers.map((c) => ({ key: c.key, req: c.req, error: c.error }))
  }
  const picked = (match ? rows.filter((r) => match(r.key)) : rows).slice(0, top)
  const keys = new Set<string>()
  for (const r of picked) for (const c of r.callers) keys.add(c.key)
  const topCallers = match ? [] : callers.slice(0, top)
  for (const c of topCallers) keys.add(c.key)
  const labels = await labelCallers([...keys]).catch(() => ({}) as Record<string, string>)
  const lab = (k: string) => labels[k] ?? k
  const result = {
    source,
    truncated,
    entities: picked.map((r) => ({
      entity: r.key,
      requests: r.req,
      errors: r.error,
      ...(r.p95 != null ? { p95_ms: r.p95 } : {}),
      top_callers: r.callers.map((c) => ({ caller: lab(c.key), requests: c.n }))
    })),
    ...(match
      ? {}
      : {
          top_callers: topCallers.map((c) => ({
            caller: lab(c.key),
            requests: c.req,
            errors: c.error
          }))
        })
  }
  const summary = match
    ? picked.length
      ? `${picked[0].key}: ${picked[0].req} requests (${source})`
      : `No traffic for "${String(input.entity)}" (${source})`
    : `${picked.length} busiest entities (${source})`
  return { result, summary }
}
