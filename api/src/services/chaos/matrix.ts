import type { FaultDefinition, FaultParams } from './catalog.js'
import { isVerdictRun, runTime } from './claims.js'
import type { ChaosRun } from './runs.js'

/**
 * The resilience matrix (#2850): dependencies × fault kinds, each cell holding the newest
 * verdict of a run whose fault lands there. Where a fault lands comes from a small placement
 * table (fault key + optional parameter test → dependency, kind) with a word-based fallback
 * for faults this table has not met yet (area + key / mode words), so a new fault cluster's
 * runs show up without touching this file. `registerPlacement` lets a fault file place itself.
 */

export const MATRIX_KINDS = ['down', 'slow', 'errors', 'partitioned'] as const
export type MatrixKind = (typeof MATRIX_KINDS)[number]

export const MATRIX_DEPENDENCIES = [
  { id: 'database', label: 'Database' },
  { id: 'redis', label: 'Redis' },
  { id: 'files', label: 'File share' },
  { id: 'partners', label: 'Partners' },
  { id: 'ai', label: 'AI gateway' },
  { id: 'sign-in', label: 'Sign-in' },
  { id: 'sockets', label: 'Sockets' },
  { id: 'mail', label: 'Mail' }
] as const
export type MatrixDependency = (typeof MATRIX_DEPENDENCIES)[number]['id']

export interface Placement {
  fault_key: string
  dependency: MatrixDependency
  kind: MatrixKind
  /** Parameters that make the fault act as this kind (the re-run pre-fill). */
  params?: FaultParams
  /** Does a run with these params land here? (default: yes) */
  match?: (params: FaultParams) => boolean
}

const placements: Placement[] = []

export function registerPlacement(p: Placement): void {
  const i = placements.findIndex(
    (x) => x.fault_key === p.fault_key && x.dependency === p.dependency && x.kind === p.kind
  )
  if (i >= 0) placements[i] = p
  else placements.push(p)
}

const words = (params: FaultParams): string =>
  Object.values(params)
    .filter((v) => typeof v === 'string')
    .join(' ')
    .toLowerCase()

/** The kind a mode word names, else null. */
export function kindFromWords(text: string): MatrixKind | null {
  const t = text.toLowerCase()
  if (/partition|split|isolat|cut.?off/.test(t)) return 'partitioned'
  if (/slow|latency|delay|lag/.test(t)) return 'slow'
  if (/down|pause|outage|unreachable|gone|unmount|timeout|disconnect|exhaust|hold/.test(t))
    return 'down'
  if (
    /error|fail|5\d\d|429|refus|readonly|enospc|erofs|malformed|tls|deadlock|reset|loss|evict/.test(
      t
    )
  )
    return 'errors'
  return null
}

/** The dependency a fault's area / key names, else null. */
export function dependencyFromWords(
  area: string | null | undefined,
  key: string
): MatrixDependency | null {
  const t = `${area ?? ''} ${key}`.toLowerCase()
  if (/\bai\b|ai_|gateway|model/.test(t)) return 'ai'
  if (/oidc|sign.?in|idp|auth/.test(t)) return 'sign-in'
  if (/partner|external|erp/.test(t)) return 'partners'
  if (/redis|cron|lease/.test(t)) return 'redis'
  if (/socket|realtime|replica/.test(t)) return 'sockets'
  if (/mail|smtp/.test(t)) return 'mail'
  if (/storage|files?\b|share|disk/.test(t)) return 'files'
  if (/\bdb\b|db_|database|pool|sql/.test(t)) return 'database'
  return null
}

const PARTNER_PARAMS = ['api', 'api_id', 'external_api', 'external_api_id', 'partner']

/** The partner a run aimed at (an external API id or name), when its params say. */
export function partnerOf(params: FaultParams): string | null {
  for (const k of PARTNER_PARAMS) {
    const v = params[k]
    if (v != null && v !== '') return String(v)
  }
  return null
}

/** Where one run lands (several cells when its parameters combine kinds). */
export function placeRun(
  run: Pick<ChaosRun, 'fault_key' | 'params'>,
  def?: Pick<FaultDefinition, 'area'> | null
): Array<{ dependency: MatrixDependency; kind: MatrixKind }> {
  const key = run.fault_key
  if (!key) return []
  const params = run.params ?? {}
  const own = placements.filter((p) => p.fault_key === key)
  if (own.length) {
    return own
      .filter((p) => (p.match ? p.match(params) : true))
      .map((p) => ({ dependency: p.dependency, kind: p.kind }))
  }
  const dependency = dependencyFromWords(def?.area, key)
  const kind = kindFromWords(`${words(params)} ${key}`)
  return dependency && kind ? [{ dependency, kind }] : []
}

/** What re-runs a cell: placements first, then catalog faults whose words land there. */
export function rerunFor(
  dependency: MatrixDependency,
  kind: MatrixKind,
  catalog: Array<Pick<FaultDefinition, 'key' | 'area' | 'params'>>
): { fault_key: string; params: FaultParams } | null {
  const inCatalog = new Set(catalog.map((f) => f.key))
  const p = placements.find(
    (x) => x.dependency === dependency && x.kind === kind && inCatalog.has(x.fault_key)
  )
  if (p) return { fault_key: p.fault_key, params: p.params ?? {} }
  for (const f of catalog) {
    if (placements.some((x) => x.fault_key === f.key)) continue
    if (dependencyFromWords(f.area, f.key) !== dependency) continue
    // Try the key, then each enum option as the mode.
    if (kindFromWords(f.key) === kind) return { fault_key: f.key, params: {} }
    for (const [name, spec] of Object.entries(f.params)) {
      if (spec.type !== 'enum') continue
      const opt = spec.options.find((o) => kindFromWords(o) === kind)
      if (opt) return { fault_key: f.key, params: { [name]: opt } }
    }
  }
  return null
}

export interface MatrixCell {
  dependency: string
  kind: MatrixKind
  last: {
    run_id: string
    fault_key: string | null
    verdict: ChaosRun['verdict']
    at: string
    age_days: number
  } | null
  runs: number
  rerun: { fault_key: string; params: FaultParams } | null
}

export interface MatrixRow {
  id: string
  label: string
  /** Partner rows: the external API's id. */
  partner?: string
}

export interface Matrix {
  kinds: readonly MatrixKind[]
  rows: MatrixRow[]
  cells: MatrixCell[]
}

/**
 * Build the grid. `partners` = the external APIs to give a row each (id + name); runs aimed at
 * a partner land on its row, partner runs that name none land on the "Partners" row.
 */
export function buildMatrix(
  runs: ChaosRun[],
  catalog: FaultDefinition[],
  partners: Array<{ id: string; name: string }> = [],
  now = Date.now()
): Matrix {
  const defs = new Map(catalog.map((f) => [f.key, f]))
  const rows: MatrixRow[] = []
  for (const d of MATRIX_DEPENDENCIES) {
    rows.push({ id: d.id, label: d.label })
    if (d.id === 'partners')
      for (const p of partners) rows.push({ id: `partner:${p.id}`, label: p.name, partner: p.id })
  }
  const partnerIds = new Map(partners.map((p) => [p.id.toLowerCase(), p.id]))
  for (const p of partners) partnerIds.set(p.name.toLowerCase(), p.id)

  const cells = new Map<string, MatrixCell>()
  const cellKey = (dep: string, kind: string) => `${dep}|${kind}`
  for (const row of rows) {
    const dep = (row.partner ? 'partners' : row.id) as MatrixDependency
    for (const kind of MATRIX_KINDS) {
      const rerun = rerunFor(dep, kind, catalog)
      if (rerun && row.partner) {
        const def = defs.get(rerun.fault_key)
        const param = Object.keys(def?.params ?? {}).find((k) => PARTNER_PARAMS.includes(k))
        if (param) rerun.params = { ...rerun.params, [param]: row.partner }
      }
      cells.set(cellKey(row.id, kind), {
        dependency: row.id,
        kind,
        last: null,
        runs: 0,
        rerun
      })
    }
  }

  for (const run of runs) {
    if (!isVerdictRun(run)) continue
    for (const place of placeRun(run, defs.get(run.fault_key as string))) {
      let rowId: string = place.dependency
      if (place.dependency === 'partners') {
        const named = partnerOf(run.params ?? {})
        const id = named ? partnerIds.get(named.toLowerCase()) : null
        if (id) rowId = `partner:${id}`
      }
      const cell = cells.get(cellKey(rowId, place.kind))
      if (!cell) continue
      cell.runs++
      const t = runTime(run)
      if (!cell.last || t > new Date(cell.last.at).getTime()) {
        cell.last = {
          run_id: run.id,
          fault_key: run.fault_key,
          verdict: run.verdict,
          at: new Date(t).toISOString(),
          age_days: Math.round((Math.max(0, now - t) / 86_400_000) * 10) / 10
        }
      }
    }
  }
  return { kinds: MATRIX_KINDS, rows, cells: [...cells.values()] }
}

// ─── Where today's faults land ─────────────────────────────────────────────────
// Keys not in the catalog yet are the names the fault clusters register (SEAM.md §4); a
// placement for a missing fault is simply never used.

const sp = (params: FaultParams, k: string) => String(params[k] ?? '')

registerPlacement({ fault_key: 'redis_pause', dependency: 'redis', kind: 'down' })
registerPlacement({ fault_key: 'redis_latency', dependency: 'redis', kind: 'slow' })
registerPlacement({ fault_key: 'redis_readonly', dependency: 'redis', kind: 'errors' })
registerPlacement({ fault_key: 'redis_key_loss', dependency: 'redis', kind: 'errors' })
registerPlacement({ fault_key: 'replica_partition', dependency: 'redis', kind: 'partitioned' })
registerPlacement({ fault_key: 'replica_partition', dependency: 'sockets', kind: 'partitioned' })
registerPlacement({ fault_key: 'mail_down', dependency: 'mail', kind: 'down' })
registerPlacement({ fault_key: 'db_latency', dependency: 'database', kind: 'slow' })
registerPlacement({ fault_key: 'db_errors', dependency: 'database', kind: 'errors' })
registerPlacement({ fault_key: 'pool_exhaustion', dependency: 'database', kind: 'down' })
registerPlacement({
  fault_key: 'socket_drill',
  dependency: 'sockets',
  kind: 'down',
  params: { disconnect: 'once' },
  match: (p) => sp(p, 'disconnect') !== '' && sp(p, 'disconnect') !== 'none'
})
registerPlacement({
  fault_key: 'socket_drill',
  dependency: 'sockets',
  kind: 'slow',
  params: { latency_ms: 1500 },
  match: (p) => Number(p.latency_ms) > 0
})
registerPlacement({
  fault_key: 'socket_drill',
  dependency: 'sockets',
  kind: 'errors',
  params: { drop_pct: 20 },
  match: (p) => Number(p.drop_pct) > 0
})
