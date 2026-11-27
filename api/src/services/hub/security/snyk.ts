import { db } from '../../../db/index.js'
import { contextFor, openConnection } from '../providers/engine/plan.js'
import type { SnykFindings, SnykProjectFindings } from '../providers/snyk/index.js'
import { listConnections } from '../providers/store.js'

/**
 * Task 43: Snyk findings in the Hub vulnerability tab, as source `snyk`. Per Snyk connection the
 * Hub reads the organisation's projects with their open-issue counts (readSnykProjectFindings:
 * counts only, never issue text) and keeps the last answer per connection in
 * nivaro_extension_settings `nivaro-hub` / `snyk_findings` (no table: a few hundred rows of
 * counts). Findings are per Snyk project, not per image digest, so the tab lists them by
 * connection + project and never joins them to nivaro_hub_vuln_findings.
 *
 * Read daily with the image scan (`hub-vuln-scan`, 04:40) whether or not an image scanner is set,
 * and when an administrator starts a scan. Hub administrators only: a Snyk organisation is not an
 * app's. A connection that fails keeps its last good projects and shows the scrubbed error.
 */

export const SNYK_FINDINGS_STATE = { extension_id: 'nivaro-hub', key: 'snyk_findings' } as const
const CONNECTION_MS = 120_000
/** At most this many projects are kept per connection (counts only). */
const MAX_PROJECTS = 500

export interface SnykConnectionFindings {
  connection_id: number
  name: string
  read_at: string | null
  ok: boolean
  error: string | null
  totals: SnykFindings | null
  projects: SnykProjectFindings[]
}

type State = Record<string, SnykConnectionFindings>

export async function readSnykState(): Promise<State> {
  try {
    const row = (await db('nivaro_extension_settings').where(SNYK_FINDINGS_STATE).first('value')) as
      | { value: string | null }
      | undefined
    const v = row?.value ? JSON.parse(row.value) : {}
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

async function writeSnykState(state: State): Promise<void> {
  const value = JSON.stringify(state)
  const existing = (await db('nivaro_extension_settings').where(SNYK_FINDINGS_STATE).first('id')) as
    | { id: number }
    | undefined
  if (existing)
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date() })
  else
    await db('nivaro_extension_settings').insert({
      ...SNYK_FINDINGS_STATE,
      value,
      updated_at: new Date()
    })
}

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Reads every Snyk connection's findings now. Never throws; answers how many were read. */
export async function snykFindingsTick(
  deps: { now?: () => Date; timeoutMs?: number } = {}
): Promise<{ connections: number; failed: number }> {
  const now = deps.now ?? (() => new Date())
  let conns: Awaited<ReturnType<typeof listConnections>>
  try {
    conns = await listConnections({ provider: 'snyk' })
  } catch {
    return { connections: 0, failed: 0 }
  }
  const before = await readSnykState()
  const next: State = {}
  let failed = 0
  const { readSnykProjectFindings } = await import('../providers/snyk/index.js')
  for (const c of conns) {
    if (c.status === 'disabled') continue
    const prev = before[String(c.id)]
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), deps.timeoutMs ?? CONNECTION_MS)
    timer.unref?.()
    let scrub = (t: string) => t
    try {
      const open = await openConnection(c.id)
      const ctx = contextFor(open, null, { signal: ac.signal })
      scrub = ctx.scrub
      const r = await readSnykProjectFindings(ctx)
      next[String(c.id)] = {
        connection_id: c.id,
        name: c.name,
        read_at: now().toISOString(),
        ok: true,
        error: null,
        totals: r.totals,
        projects: r.projects
          .sort((a, b) => b.critical - a.critical || b.high - a.high || a.id.localeCompare(b.id))
          .slice(0, MAX_PROJECTS)
      }
    } catch (e) {
      failed += 1
      next[String(c.id)] = {
        connection_id: c.id,
        name: c.name,
        read_at: prev?.read_at ?? null,
        ok: false,
        // Scrubbed BEFORE it is clipped.
        error: clip(scrub(e instanceof Error ? e.message : String(e))),
        totals: prev?.totals ?? null,
        projects: prev?.projects ?? []
      }
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    await writeSnykState(next)
  } catch {
    failed += 1
  }
  return { connections: conns.length, failed }
}

/** What the vulnerability tab shows (Hub administrators only). */
export async function listSnykFindings(): Promise<SnykConnectionFindings[]> {
  const state = await readSnykState()
  const live = new Set(
    (await listConnections({ provider: 'snyk' }).catch(() => [])).map((c) => String(c.id))
  )
  return Object.values(state)
    .filter((s) => live.has(String(s.connection_id)))
    .sort((a, b) => a.connection_id - b.connection_id)
}
