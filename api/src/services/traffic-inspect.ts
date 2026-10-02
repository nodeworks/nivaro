// api/src/services/traffic-inspect.ts
/**
 * Traffic Map drill-down: the server side of "inspect this thing". A source answers for one kind
 * of thing the map shows (a request, a record, a cron run, a caller…) — a short peek for hover
 * cards and a full detail for the inspector panel. Sources register at module load from
 * `services/traffic-inspect/<group>.ts`; the generic routes live in
 * `routes/traffic-map-extras/inspect-core.ts` (`/api/traffic-map/inspect/...`).
 *
 * Every id reaching a source has passed that source's `validId` first — a source never sees an
 * id it did not accept, so raw SQL behind it can rely on the shape it declared.
 */
import type { FastifyRequest } from 'fastify'

export interface InspectPeek {
  title: string
  lines: string[]
  /** When the thing happened, as epoch ms — the hover card formats it with fmtClock. */
  at?: number | null
}

export interface InspectCtx {
  req: FastifyRequest
  /** Epoch ms the drill is anchored at (the ticker event's time, a rewind position); null = now. */
  at: number | null
  /** Seconds around `at` a source may look in (default 300, max 86400). */
  windowSec: number
}

export interface InspectSource {
  /** `/^[a-z][a-z0-9-]{1,30}$/` — the `:kind` URL segment. */
  kind: string
  validId(id: string): boolean
  peek?(id: string, ctx: InspectCtx): Promise<InspectPeek | null>
  /** null → 404 INSPECT_NOT_FOUND. */
  detail(id: string, ctx: InspectCtx): Promise<unknown | null>
}

export const INSPECT_KIND_RE = /^[a-z][a-z0-9-]{1,30}$/
export const INSPECT_WINDOW_DEFAULT = 300
export const INSPECT_WINDOW_MAX = 86_400

const sources = new Map<string, InspectSource>()

/** Register (or replace — the same kind registered again wins) an inspect source. */
export function registerInspectSource(s: InspectSource): void {
  if (!s || typeof s.kind !== 'string' || !INSPECT_KIND_RE.test(s.kind)) {
    throw new Error(`Inspect source kind must match ${INSPECT_KIND_RE}: ${String(s?.kind)}`)
  }
  if (typeof s.validId !== 'function' || typeof s.detail !== 'function') {
    throw new Error(`Inspect source ${s.kind} needs validId and detail`)
  }
  sources.set(s.kind, s)
}

export function inspectSource(kind: string): InspectSource | null {
  return sources.get(kind) ?? null
}

/** Every registered kind, sorted. */
export function inspectKinds(): string[] {
  return [...sources.keys()].sort()
}

/** Test hook: forget every source. */
export function resetInspectSources(): void {
  sources.clear()
}

/** `?at=` as epoch ms (null when absent / not a sane time). */
export function parseInspectAt(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n)
}

/** `?window=` in seconds: default 300, clamped to 1..86400. */
export function parseInspectWindow(raw: unknown): number {
  if (raw == null || raw === '') return INSPECT_WINDOW_DEFAULT
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return INSPECT_WINDOW_DEFAULT
  return Math.min(INSPECT_WINDOW_MAX, Math.max(1, Math.round(n)))
}
