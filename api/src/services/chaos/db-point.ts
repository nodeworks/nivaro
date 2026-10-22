import { inBackgroundPool } from '../../db/pool-context.js'
import { currentTraceMeta } from '../request-trace.js'
import type { ArmedFault } from './catalog.js'
import { armedFaults, type ChaosPointContext, chaosPoint, targetMatches } from './registry.js'

/**
 * What the database driver seam (`db/chaos-seam.ts`) asks on every statement (#1773): is a
 * database fault acting on this one, and what does it do? Two points — `db.query` (added
 * latency) and `db.error` (a deadlock victim, a request timeout or a connection reset, shaped
 * like the errors tedious really throws) — so latency and errors can be armed together.
 *
 * Nothing is parsed or allocated unless a fault is armed at one of the two points: the context
 * is one reused object whose `table` (the statement's first FROM / UPDATE / INTO target),
 * `route` and `userId` (the request ALS) are getters, read only by a target that needs them.
 */

export type DbErrorKind = 'deadlock' | 'timeout' | 'reset'

export interface DbChaos {
  delay_ms: number
  error: Error | null
}

/** The drill's own bookkeeping never fails or slows: run store, run events, job runs. */
const OWN_TABLES = /nivaro_chaos_|nivaro_job_runs/i

const TABLE_RE =
  /\b(?:from|update|into)\s+((?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w#@$]+)(?:\.(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w#@$]+))*)/i

/** The statement's first FROM / UPDATE / INTO target, without schema or quoting (cheap). */
export function firstTable(sql: string): string | undefined {
  const m = TABLE_RE.exec(sql)
  if (!m) return undefined
  const parts = m[1].split('.')
  const last = parts[parts.length - 1]
  const name = last.replace(/^[[`"]|[\]`"]$/g, '')
  return name || undefined
}

let curSql = ''
let curTable: string | undefined | null = null

const ctx: ChaosPointContext = {
  get table() {
    if (curTable === null) curTable = firstTable(curSql)
    return curTable
  },
  get route() {
    const hint = currentTraceMeta()?.urlHint
    return hint ? hint.split('?')[0] : undefined
  },
  get userId() {
    return currentTraceMeta()?.userId ?? null
  }
}

function poolMatches(f: ArmedFault, background: boolean): boolean {
  const pool = String(f.params.pool ?? 'any')
  return pool === 'any' || (pool === 'background') === background
}

/** The fault acting at `point` for the current statement, honouring the pool parameter. */
function pick(point: string, faultKey: string, background: boolean): ArmedFault | null {
  const first = chaosPoint(point, ctx)
  if (!first) return null
  if (poolMatches(first, background)) return first
  // Several faults of this kind armed with different pools: look past the first.
  for (const f of armedFaults()) {
    if (f.id !== first.id && f.fault_key === faultKey && poolMatches(f, background)) {
      if (targetMatches(f, ctx)) return f
    }
  }
  return null
}

/** The error tedious throws for each kind, so retry / transient / trace paths see the real shape. */
export function makeDbError(kind: DbErrorKind): Error {
  if (kind === 'deadlock') {
    return Object.assign(
      new Error(
        'Transaction (Process ID 0) was deadlocked on lock resources with another process and has been chosen as the deadlock victim. Rerun the transaction.'
      ),
      { name: 'RequestError', code: 'EREQUEST', number: 1205, state: 51, class: 13, chaos: true }
    )
  }
  if (kind === 'timeout') {
    return Object.assign(new Error('Timeout: Request failed to complete in 15000ms'), {
      name: 'RequestError',
      code: 'ETIMEOUT',
      chaos: true
    })
  }
  return Object.assign(new Error('Connection lost - read ECONNRESET'), {
    name: 'ConnectionError',
    code: 'ESOCKET',
    chaos: true
  })
}

/** The seam's question. Null = run the statement untouched (the usual answer). */
export function dbChaos(sql: string): DbChaos | null {
  curSql = sql
  curTable = null
  const background = inBackgroundPool()
  const slow = pick('db.query', 'db_latency', background)
  const failing = pick('db.error', 'db_errors', background)
  if (!slow && !failing) return null
  if (OWN_TABLES.test(sql)) return null
  let delay = slow ? Number(slow.params.delay_ms) || 0 : 0
  let error: Error | null = null
  if (failing) {
    const rate = Number(failing.params.rate_pct ?? 100)
    if (Math.random() * 100 < rate) {
      error = makeDbError(String(failing.params.error) as DbErrorKind)
      delay += Number(failing.params.wait_ms) || 0
    }
  }
  if (!delay && !error) return null
  return { delay_ms: delay, error }
}
