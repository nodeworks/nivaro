import { isReplicatedArticle } from '../../replication.js'
import {
  fkBackedIndexes,
  indexDefinition,
  indexUsage,
  type RedundantRow,
  redundantIndexes,
  serverUptimeDays,
  type UsageRow
} from '../dmv.js'
import { type Candidate, IDENT, KIND_RISK } from '../types.js'

/**
 * Index-drop observer: a plain nonclustered index that nothing has read since the server
 * started (and that is written to), or whose keys are a strict prefix of another index's.
 * Usage stats reset on restart, so nothing is proposed before MIN_UPTIME_DAYS. Unique, PK and
 * foreign-key-backing indexes are never proposed, nor any index without a rebuilt CREATE
 * (from indexDefinition) to undo with.
 */

export interface IndexDropEvidence {
  usage: UsageRow[]
  redundant: RedundantRow[]
  uptimeDays: number | null
  fkBacked: Set<string>
  /** `table.index` (lower-cased) → the CREATE that recreates it. */
  definitions: Map<string, string>
  replicated: Set<string>
}

export const MIN_UPTIME_DAYS = 30
const MIN_WRITES = 100
/** ms of write work saved per avoided index maintenance — a stated approximation. */
const WRITE_MS = 0.1

const droppable = (u: UsageRow) =>
  u.type === 'NONCLUSTERED' && !u.unique && !u.pk && IDENT.test(u.table) && IDENT.test(u.index)

export function observeIndexDrop(ev: IndexDropEvidence): Candidate[] {
  if (ev.uptimeDays == null || ev.uptimeDays < MIN_UPTIME_DAYS) return []
  const days = ev.uptimeDays
  const out: Candidate[] = []
  const redundantBy = new Map(
    ev.redundant.map((r) => [`${r.table}.${r.index}`.toLowerCase(), r.covered_by])
  )
  for (const u of ev.usage) {
    const key = `${u.table}.${u.index}`.toLowerCase()
    if (!droppable(u)) continue
    if (ev.fkBacked.has(key)) continue
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
        : `Drop ${u.table}.${u.index} — ${u.writes.toLocaleString()} writes, zero reads in ${Math.floor(days)} days`,
      evidence: {
        reads: u.reads,
        writes: u.writes,
        size_mb: u.size_mb,
        uptime_days: Math.floor(days),
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

export async function loadIndexDropEvidence(): Promise<IndexDropEvidence> {
  const [usage, redundant, uptimeDays, fkBacked] = await Promise.all([
    indexUsage(),
    redundantIndexes(),
    serverUptimeDays(),
    fkBackedIndexes()
  ])
  const definitions = new Map<string, string>()
  const replicated = new Set<string>()
  // Rebuilding a definition costs a catalog read each — only for indexes that could qualify.
  if (uptimeDays == null || uptimeDays < MIN_UPTIME_DAYS)
    return { usage, redundant, uptimeDays, fkBacked, definitions, replicated }
  const redundantKeys = new Set(redundant.map((r) => `${r.table}.${r.index}`.toLowerCase()))
  const candidates = usage.filter((u) => {
    const key = `${u.table}.${u.index}`.toLowerCase()
    return droppable(u) && !fkBacked.has(key) && (u.reads === 0 || redundantKeys.has(key))
  })
  for (const u of candidates) {
    const def = await indexDefinition(u.table, u.index)
    if (def) definitions.set(`${u.table}.${u.index}`.toLowerCase(), def)
    if (await isReplicatedArticle(u.table)) replicated.add(u.table.toLowerCase())
  }
  return { usage, redundant, uptimeDays, fkBacked, definitions, replicated }
}
