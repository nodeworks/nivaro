// api/src/services/traffic-down-history.ts
/**
 * 1h/6h/24h history for down nodes beyond the map's own (`ext:<id>` reads nivaro_outbound_log in
 * the core route). A feature that adds a down node with a log behind it (email → nivaro_mail_log,
 * AI → nivaro_ai_calls, webhooks → nivaro_webhook_deliveries, extension nodes → outbound log)
 * registers a provider; GET /traffic-map/down/:id asks the providers before its own branch.
 *
 * `summarizeDownRows` turns timestamped rows into the DownHistory shape the inspector draws.
 */
import { pathTemplate } from './traffic-entities.js'

export interface DownHistoryRow {
  at: Date | string
  ok: boolean
  ms?: number | null
  /** Status code / outcome shown in the codes strip ('sent', '429', 'network'…). */
  code?: string | null
  /** Path / template / model, for the top list. */
  path?: string | null
}
export interface DownHistoryBody {
  key: string
  hours: number
  bucket_s?: number
  series: Array<{ t: string; req: number; error: number; p95: number }>
  totals?: { req: number; error: number }
  status_codes?: Record<string, number>
  top_paths?: Array<{ path: string; n: number }>
  note?: string
  truncated?: boolean
}
type Provider = {
  test: (id: string) => boolean
  read: (id: string, hours: 1 | 6 | 24) => Promise<DownHistoryBody>
}
const providers: Provider[] = []

/** Register a history provider for the down ids `test` accepts (first registered wins). */
export function registerDownHistory(
  test: (id: string) => boolean,
  read: (id: string, hours: 1 | 6 | 24) => Promise<DownHistoryBody>
): void {
  providers.push({ test, read })
}

/** The provider's body for `id`, or undefined when no provider claims it. */
export async function downHistoryFor(
  id: string,
  hours: 1 | 6 | 24
): Promise<DownHistoryBody | undefined> {
  const p = providers.find((x) => {
    try {
      return x.test(id)
    } catch {
      return false
    }
  })
  return p ? p.read(id, hours) : undefined
}

export const DOWN_HISTORY_ROW_CAP = 20_000

/** Bucket timestamped rows like the core partner history (1h → 1 min, 6h → 5, 24h → 15). */
export function summarizeDownRows(
  key: string,
  hours: 1 | 6 | 24,
  rows: DownHistoryRow[],
  now = new Date(),
  opts: { templatePaths?: boolean; truncated?: boolean } = {}
): DownHistoryBody {
  const bucketS = hours === 1 ? 60 : hours === 6 ? 300 : 900
  const since = Math.floor(now.getTime() / 1000) - hours * 3600
  const points = (hours * 3600) / bucketS
  const series = Array.from({ length: points }, (_, i) => ({
    t: new Date((since + i * bucketS) * 1000).toISOString(),
    req: 0,
    error: 0,
    lat: [] as number[]
  }))
  const paths = new Map<string, number>()
  const codes: Record<string, number> = {}
  let total = 0
  let error = 0
  for (const r of rows) {
    const t = Math.floor(new Date(r.at).getTime() / 1000)
    const i = Math.floor((t - since) / bucketS)
    if (!Number.isFinite(i) || i < 0 || i >= points) continue
    total++
    series[i].req++
    if (!r.ok) {
      series[i].error++
      error++
    }
    if (r.ms != null && Number.isFinite(Number(r.ms))) series[i].lat.push(Number(r.ms))
    if (r.code != null) codes[String(r.code)] = (codes[String(r.code)] ?? 0) + 1
    if (r.path) {
      const p = (opts.templatePaths ? pathTemplate(r.path) : r.path).slice(0, 120)
      paths.set(p, (paths.get(p) ?? 0) + 1)
    }
  }
  const p95 = (a: number[]) =>
    a.length
      ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.95))]
      : 0
  return {
    key,
    hours,
    bucket_s: bucketS,
    series: series.map((s) => ({ t: s.t, req: s.req, error: s.error, p95: p95(s.lat) })),
    totals: { req: total, error },
    status_codes: codes,
    top_paths: [...paths]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([path, n]) => ({ path, n })),
    truncated: opts.truncated ?? rows.length >= DOWN_HISTORY_ROW_CAP
  }
}
