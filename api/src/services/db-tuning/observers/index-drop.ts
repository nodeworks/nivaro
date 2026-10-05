import { indexName } from '../../index-advisor.js'
import { isReplicatedArticle } from '../../replication.js'
import {
  fkBackedIndexes,
  indexDefinition,
  indexNamesInModules,
  indexUsage,
  type RedundantRow,
  redundantIndexes,
  serverStartTime,
  type UsageRow
} from '../dmv.js'
import { listProposals } from '../ledger.js'
import { type Candidate, IDENT, KIND_RISK, type ProposalRow } from '../types.js'

/**
 * Index-drop observer: a plain nonclustered index that nothing has read since the server
 * started (and that is written to), or whose keys are a strict prefix of a live index's.
 * Usage stats reset on restart, so nothing is proposed before MIN_UPTIME_DAYS. Never proposed:
 * unique, PK and foreign-key-backing indexes; an index this ledger created within
 * RECENT_CREATE_DAYS (its zero reads cover less than the uptime); an index named anywhere in a
 * module definition (a WITH (INDEX(…)) hint fails with error 308 once it is gone); and any
 * index without a rebuilt CREATE (from indexDefinition) to undo with.
 */

export interface IndexDropEvidence {
  usage: UsageRow[]
  redundant: RedundantRow[]
  uptimeDays: number | null
  /** The day usage stats start from (sqlserver_start_time), YYYY-MM-DD. */
  since: string | null
  fkBacked: Set<string>
  /** `table.index` (lower-cased) → the CREATE that recreates it. */
  definitions: Map<string, string>
  replicated: Set<string>
  /** `table.index` (lower-cased) the ledger created recently. */
  recentlyCreated: Set<string>
  /** Index names (lower-cased) some module definition mentions. */
  hinted: Set<string>
}

export const MIN_UPTIME_DAYS = 30
export const RECENT_CREATE_DAYS = 60
const MIN_WRITES = 100
/** ms of write work saved per avoided index maintenance — a stated approximation. */
const WRITE_MS = 0.1

const droppable = (u: UsageRow) =>
  u.type === 'NONCLUSTERED' && !u.unique && !u.pk && IDENT.test(u.table) && IDENT.test(u.index)

export function observeIndexDrop(ev: IndexDropEvidence): Candidate[] {
  if (ev.uptimeDays == null || ev.uptimeDays < MIN_UPTIME_DAYS || !ev.since) return []
  const days = ev.uptimeDays
  const out: Candidate[] = []
  const live = new Set(ev.usage.map((u) => `${u.table}.${u.index}`.toLowerCase()))
  const redundantBy = new Map(
    ev.redundant
      // The coverer must be a live index on the same table, or the "prefix" claim is hollow.
      .filter((r) => live.has(`${r.table}.${r.covered_by}`.toLowerCase()))
      .map((r) => [`${r.table}.${r.index}`.toLowerCase(), r.covered_by])
  )
  for (const u of ev.usage) {
    const key = `${u.table}.${u.index}`.toLowerCase()
    if (!droppable(u)) continue
    if (ev.fkBacked.has(key) || ev.recentlyCreated.has(key)) continue
    if (ev.hinted.has(u.index.toLowerCase())) continue
    const covered = redundantBy.get(key)
    const unused = u.reads === 0 && u.writes > MIN_WRITES
    if (!unused && !covered) continue
    const undo = ev.definitions.get(key)
    if (!undo) continue
    out.push({
      kind: 'index_drop',
      target: `${u.table}.${u.index}`,
      change_key: u.index,
      title: covered
        ? `Drop ${u.table}.${u.index} — a prefix of ${covered}`
        : `Drop ${u.table}.${u.index} — ${u.writes.toLocaleString()} writes, no reads since ${ev.since}`,
      evidence: {
        reads: u.reads,
        writes: u.writes,
        size_mb: u.size_mb,
        uptime_days: Math.floor(days),
        since: ev.since,
        covered_by: covered ?? null
      },
      estimate_ms_per_day: Math.round((u.writes / days) * WRITE_MS),
      risk: KIND_RISK.index_drop,
      apply: { type: 'sql', statements: [`DROP INDEX [${u.index}] ON [${u.table}]`] },
      undo: { type: 'sql', statements: [undo] },
      replicated: ev.replicated.has(u.table.toLowerCase())
    })
  }
  return out
}

/** `table.index` keys of index_create proposals applied (or watching) within
 *  RECENT_CREATE_DAYS — named from the undo statement and from the target, both lower-cased.
 *  A row with no applied_at counts as recent. */
export function recentlyCreatedKeys(
  rows: Array<Pick<ProposalRow, 'kind' | 'status' | 'target' | 'applied_at' | 'undo'>>,
  now = Date.now()
): Set<string> {
  const out = new Set<string>()
  const cutoff = now - RECENT_CREATE_DAYS * 86_400_000
  for (const r of rows) {
    if (r.kind !== 'index_create' || (r.status !== 'applied' && r.status !== 'watching')) continue
    const at = r.applied_at ? new Date(r.applied_at).getTime() : Number.NaN
    if (Number.isFinite(at) && at < cutoff) continue
    if (r.undo?.type === 'sql')
      for (const s of r.undo.statements) {
        const m = s.match(
          /^DROP INDEX \[([A-Za-z_][A-Za-z0-9_]*)\] ON \[([A-Za-z_][A-Za-z0-9_]*)\]$/
        )
        if (m) out.add(`${m[2]}.${m[1]}`.toLowerCase())
      }
    const dot = r.target.indexOf('.')
    if (dot > 0) {
      const table = r.target.slice(0, dot)
      out.add(`${table}.${indexName(table, r.target.slice(dot + 1))}`.toLowerCase())
    }
  }
  return out
}

export async function loadIndexDropEvidence(): Promise<IndexDropEvidence> {
  const [usage, redundant, startedAt, fkBacked, created] = await Promise.all([
    indexUsage(),
    redundantIndexes(),
    serverStartTime(),
    fkBackedIndexes(),
    listProposals({ kind: 'index_create', status: ['applied', 'watching'] }).catch(() => null)
  ])
  const uptimeDays = startedAt ? (Date.now() - startedAt.getTime()) / 86_400_000 : null
  const since = startedAt ? startedAt.toISOString().slice(0, 10) : null
  const definitions = new Map<string, string>()
  const replicated = new Set<string>()
  const recentlyCreated = recentlyCreatedKeys(created ?? [])
  const evidence = (hinted = new Set<string>()): IndexDropEvidence => ({
    usage,
    redundant,
    uptimeDays,
    since,
    fkBacked,
    definitions,
    replicated,
    recentlyCreated,
    hinted
  })
  // Fail closed: without the ledger (what we created recently) no drop is safe to propose.
  // Rebuilding a definition costs a catalog read each — only for indexes that could qualify.
  if (!created || uptimeDays == null || uptimeDays < MIN_UPTIME_DAYS) return evidence()
  const redundantKeys = new Set(redundant.map((r) => `${r.table}.${r.index}`.toLowerCase()))
  const candidates = usage.filter((u) => {
    const key = `${u.table}.${u.index}`.toLowerCase()
    return (
      droppable(u) &&
      !fkBacked.has(key) &&
      !recentlyCreated.has(key) &&
      ((u.reads === 0 && u.writes > MIN_WRITES) || redundantKeys.has(key))
    )
  })
  // One query for every candidate name; unreadable modules → no drops (fail closed).
  const hinted = await indexNamesInModules(candidates.map((u) => u.index))
  if (!hinted) return evidence()
  for (const u of candidates) {
    if (hinted.has(u.index.toLowerCase())) continue
    const def = await indexDefinition(u.table, u.index)
    if (def) definitions.set(`${u.table}.${u.index}`.toLowerCase(), def)
    if (await isReplicatedArticle(u.table)) replicated.add(u.table.toLowerCase())
  }
  return evidence(hinted)
}
