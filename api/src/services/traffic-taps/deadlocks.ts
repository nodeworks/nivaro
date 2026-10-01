// api/src/services/traffic-taps/deadlocks.ts
/**
 * #1171 — deadlock markers. The `system_health` extended-event session's `xml_deadlock_report`
 * events (its event file; the ring buffer DB Health reads is the fallback — see readReports). Each
 * deadlock becomes a sparkline marker at the moment it happened, named by the two (or more)
 * entities whose statements met.
 *
 * Naming a statement after the fact: the deadlock graph carries each side's input buffer and the
 * client process id, but the requests are long gone. So the tap indexes the statements every
 * request ran (statement head → entity, last STATEMENT_TTL_MS, bounded) and resolves a deadlock
 * the first time it is read — while the map is watched that is within POLL_S of the deadlock.
 * Once resolved, the names stay with the cached event.
 *
 * Never in cloud mode (the ring buffer is server-wide). Without VIEW SERVER STATE the list is
 * simply empty and `available` says so.
 */
import { db } from '../../db/index.js'
import { requestStatements } from '../request-trace.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { clipSql, shapeNeedle } from './db-blocking.js'

export const DEADLOCKS_TAP = 'deadlocks'
/** How long a request's statements stay findable by a deadlock that names them. */
export const STATEMENT_TTL_MS = 30 * 60_000
const INDEX_CAP = 3000
const PER_REQUEST = 20
/** Seconds between ring-buffer reads (watched map, or a route asking). */
export const POLL_S = 30
const EVENT_CAP = 100

export interface DeadlockParty {
  spid: number | null
  /** `<lane>/<entity>` when the statement was one this API ran recently. */
  entity: string | null
  /** Program + host when not this API, else a short description. */
  label: string
  sql: string | null
  victim: boolean
}
export interface DeadlockEvent {
  /** Epoch ms. */
  at: number
  /** Tables / indexes the deadlock was over (`schema.table` from the graph). */
  objects: string[]
  parties: DeadlockParty[]
}

interface IndexEntry {
  key: string
  at: number
}
interface State {
  index: Map<string, IndexEntry>
  events: Map<string, DeadlockEvent>
  readAt: number
  reading: Promise<void> | null
  available: boolean
}
const state = (): State =>
  tapState<State>(DEADLOCKS_TAP, () => ({
    index: new Map(),
    events: new Map(),
    readAt: 0,
    reading: null,
    available: true
  }))

/** Remember which entity ran `sql` (newest wins; least-recently-seen falls out first). */
export function indexStatement(
  index: Map<string, IndexEntry>,
  sql: string,
  key: string,
  at: number
): void {
  const needle = shapeNeedle(sql)
  if (!needle) return
  index.delete(needle)
  index.set(needle, { key, at })
  if (index.size > INDEX_CAP) {
    const oldest = index.keys().next().value
    if (oldest !== undefined) index.delete(oldest)
  }
}

const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&apos;': "'",
  '&#x0A;': '\n',
  '&#x0D;': '\r',
  '&#x09;': '\t'
}
function decodeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#x0A|#x0D|#x09);/gi, (m) => ENTITIES[m] ?? m)
}
function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of raw.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1].toLowerCase()] = decodeXml(m[2])
  return out
}

export interface ParsedProcess {
  id: string
  spid: number | null
  hostpid: number | null
  clientapp: string
  hostname: string
  sql: string | null
}

/** The processes, victims and objects of one `xml_deadlock_report` graph. Pure. */
export function parseDeadlockGraph(xml: string): {
  processes: ParsedProcess[]
  victims: Set<string>
  objects: string[]
} {
  const victims = new Set<string>()
  for (const m of xml.matchAll(/<victimProcess\s+id="([^"]+)"/g)) victims.add(m[1])
  // older graphs name one victim on the <deadlock victim="…"> element
  const single = xml.match(/<deadlock[^>]*\svictim="([^"]+)"/)?.[1]
  if (single) victims.add(single)
  const processes: ParsedProcess[] = []
  for (const m of xml.matchAll(/<process\s([^>]*)>([\s\S]*?)<\/process>/g)) {
    const a = attrs(m[1])
    if (!a.id) continue
    const buf = m[2].match(/<inputbuf>([\s\S]*?)<\/inputbuf>/)?.[1]
    const frame = m[2].match(/<frame[^>]*>([\s\S]*?)<\/frame>/)?.[1]
    const text = decodeXml((buf ?? frame ?? '').trim())
    processes.push({
      id: a.id,
      spid: Number.isFinite(Number(a.spid)) ? Number(a.spid) : null,
      hostpid: Number.isFinite(Number(a.hostpid)) ? Number(a.hostpid) : null,
      clientapp: a.clientapp ?? '',
      hostname: a.hostname ?? '',
      sql: clipSql(text)
    })
  }
  const objects = [
    ...new Set(
      [...xml.matchAll(/\sobjectname="([^"]+)"/g)].map((m) =>
        decodeXml(m[1]).split('.').slice(-2).join('.')
      )
    )
  ].slice(0, 6)
  return { processes, victims, objects }
}

/** Name each side of a parsed deadlock through the statement index. Pure. */
export function resolveParties(
  parsed: ReturnType<typeof parseDeadlockGraph>,
  index: Map<string, IndexEntry>,
  me: { pid: number }
): DeadlockParty[] {
  return parsed.processes.map((p) => {
    const victim = parsed.victims.has(p.id)
    const ours = p.hostpid === me.pid
    // the index holds THIS process's statements: another program running the same shape is not
    // one of our entities
    const hit = (ours || p.hostpid == null) && p.sql ? index.get(shapeNeedle(p.sql)) : undefined
    const app = p.clientapp.trim()
    return {
      spid: p.spid,
      entity: hit?.key ?? null,
      label: hit
        ? hit.key
        : ours
          ? 'this API (statement not seen in a recent request)'
          : app
            ? `${app}${p.hostname ? ` on ${p.hostname}` : ''}`
            : 'another program',
      sql: p.sql,
      victim
    }
  })
}

/** A marker's label: "Deadlock: items/workflows ↔ items/workflow_lines (victim: …)". */
export function deadlockLabel(e: DeadlockEvent): string {
  const names = e.parties.map((p) => p.entity ?? p.label)
  const uniq = [...new Set(names)]
  const victim = e.parties.find((p) => p.victim)
  const v = victim ? (victim.entity ?? victim.label) : null
  const one = e.parties[0]
  const sides =
    uniq.length > 1
      ? uniq.slice(0, 3).join(' ↔ ')
      : one?.entity
        ? `two ${one.entity} requests`
        : `two sessions of ${uniq[0] ?? 'another program'}`
  return `Deadlock: ${sides}${v ? ` (victim: ${v})` : ''}`
}

/**
 * The newest deadlock reports. system_health's event FILE first: its ring buffer, read through the
 * DMV, is cut at a few MB (`truncated="1"`) and on a busy server holds no deadlock at all while the
 * file has them (seen on the shared database, 2026-10-01). The ring is the fallback for servers
 * without `timestamp_utc` on the file reader (before SQL Server 2017) or without file access.
 */
async function readReports(): Promise<Array<{ occurred_at: Date | string; graph: string }>> {
  try {
    return (await db.raw(`
      SELECT TOP 50 timestamp_utc AS occurred_at, CAST(event_data AS nvarchar(max)) AS graph
      FROM sys.fn_xe_file_target_read_file('system_health*.xel', NULL, NULL, NULL)
      WHERE object_name = 'xml_deadlock_report'
      ORDER BY timestamp_utc DESC
    `)) as Array<{ occurred_at: Date | string; graph: string }>
  } catch {
    return (await db.raw(`
      SELECT TOP 50
        xed.value('@timestamp', 'datetime2') AS occurred_at,
        CAST(xed.query('.') AS nvarchar(max)) AS graph
      FROM (
        SELECT CAST(target_data AS XML) AS target_data
        FROM sys.dm_xe_session_targets st
        JOIN sys.dm_xe_sessions s ON s.address = st.event_session_address
        WHERE s.name = 'system_health' AND st.target_name = 'ring_buffer'
      ) AS tab
      CROSS APPLY target_data.nodes('RingBufferTarget/event[@name="xml_deadlock_report"]') AS q(xed)
      ORDER BY occurred_at DESC
    `)) as Array<{ occurred_at: Date | string; graph: string }>
  }
}

async function readRing(): Promise<void> {
  const st = state()
  try {
    const rows = await readReports()
    st.available = true
    for (const r of rows) {
      const at = new Date(r.occurred_at).getTime()
      if (!Number.isFinite(at)) continue
      const graph = String(r.graph ?? '')
      const parsed = parseDeadlockGraph(graph)
      const id = `${at}:${parsed.processes.map((p) => p.spid).join(',')}`
      if (st.events.has(id)) continue
      st.events.set(id, {
        at,
        objects: parsed.objects,
        parties: resolveParties(parsed, st.index, { pid: process.pid })
      })
    }
    if (st.events.size > EVENT_CAP) {
      const keep = [...st.events.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, EVENT_CAP)
      st.events = new Map(keep)
    }
  } catch {
    st.available = false
  }
}

/** Refresh the cached events when older than POLL_S (one read at a time). */
export async function refreshDeadlocks(force = false): Promise<void> {
  if (process.env.CLOUD_META_DB_URL) return
  const st = state()
  if (st.reading) return st.reading
  if (!force && Date.now() - st.readAt < POLL_S * 1000) return
  st.readAt = Date.now()
  st.reading = readRing().finally(() => {
    st.reading = null
  })
  return st.reading
}

/** Deadlocks between `from` and `to` (epoch ms), oldest first. */
export async function deadlocksIn(
  from: number,
  to: number
): Promise<{ available: boolean; events: Array<DeadlockEvent & { label: string }> }> {
  await refreshDeadlocks()
  const st = state()
  const events = [...st.events.values()]
    .filter((e) => e.at >= from && e.at <= to)
    .sort((a, b) => a.at - b.at)
    .map((e) => ({ ...e, label: deadlockLabel(e) }))
  return { available: st.available, events }
}

const tap: TrafficTap = {
  id: DEADLOCKS_TAP,
  onRequest(c) {
    const stmts = requestStatements(c.ev.req, PER_REQUEST)
    if (!stmts.length) return
    const index = state().index
    const at = c.ev.at
    for (const sql of stmts) indexStatement(index, sql, c.entityKey, at)
  },
  frame(sec) {
    // while watched: read the ring every POLL_S so a deadlock is named while its statements are
    // still in the index
    if (sec % POLL_S === 0) void refreshDeadlocks()
    return undefined
  },
  sweep(sec) {
    const index = state().index
    const cutoff = sec * 1000 - STATEMENT_TTL_MS
    for (const [k, v] of index) if (v.at < cutoff) index.delete(k)
  }
}
registerTrafficTap(tap)
