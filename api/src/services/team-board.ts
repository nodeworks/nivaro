/**
 * Admin team board (realtime round 5, item 21): who is working on which record right now.
 *
 * ADMINISTRATORS ONLY (routes/team-board.ts). Nothing here is stored: every answer is built from
 * what presence already keeps — the Online rows (`presenceOnlineFor`, the admin signature), each
 * open tab's latest page ping (`getPagePresenceSnapshot`, every realtime process), the record
 * rooms people sit in (`getRecordViewerSnapshot`) and live edit locks (`lockIsLive`).
 *
 * View-as: a tab an administrator opened "as" someone pings, joins rooms and edits AS that
 * person, so the board shows the viewed person only — marked `view_as`, never naming the
 * administrator behind it.
 *
 * `assembleTeamBoard` is pure (tests); `loadTeamBoard` reads the inputs.
 */

export interface TeamBoardPresenceRow {
  user_id?: unknown
  display_name?: unknown
  role_name?: unknown
  current_path?: unknown
  page?: unknown
  state?: unknown
  stuck?: { minutes?: number; label?: string | null } | null
  idle_minutes?: unknown
  last_active?: unknown
  app?: unknown
  masquerade?: unknown
  custom_status?: { text?: string; emoji?: string | null } | null
  in_huddle?: unknown
  scopes_by_dimension?: unknown
}

export interface TeamBoardPage {
  user: { id: string; name: string }
  path: string
  since: number
  app?: string | null
  socket: string
}

export interface TeamBoardViewerRoom {
  collection: string
  item: string
  viewers: Array<{ id: string; name: string }>
}

export interface TeamBoardLock {
  collection: string
  item: string
  user: string
  locked_at?: Date | string | null
}

export interface TeamBoardRecord {
  collection: string
  item: string
  /** The record's display label as the asking administrator reads it; null = not known. */
  label: string | null
  /** Holds a live edit lock on it. */
  editing: boolean
  /** When the person opened it (earliest open tab), ms; null when only the room says so. */
  since: number | null
  /** Open tabs on it (page pings), at least 1. */
  tabs: number
}

export interface TeamBoardPerson {
  id: string
  name: string
  role: string | null
  manager: { id: string; name: string } | null
  state: 'active' | 'idle' | 'stuck'
  idle_minutes: number | null
  stuck_minutes: number | null
  last_active: string | null
  /** Where the person is when not on a record ("Workflows", "Queues › Approvals"). */
  page: string | null
  app: string | null
  /** An administrator is viewing as this person right now (who is never named here). */
  view_as: boolean
  status: { text: string; emoji: string | null } | null
  in_huddle: boolean
  scopes: Record<string, string[]>
  records: TeamBoardRecord[]
  /** Open tabs (page pings) across apps. */
  tabs: number
}

export interface TeamBoard {
  people: TeamBoardPerson[]
  counts: { online: number; on_record: number; editing: number; idle: number; stuck: number }
  dimensions: Array<{ name: string; label: string }>
  at: string
}

const RECORD_PATH = /^\/(?:admin\/)?(?:records|collections)\/([A-Za-z0-9_]+)\/([^/?#]+)/
const SYSTEM = /^(nivaro_|directus_)/i

/** The record a page path opens, or null (a list, a new-record form, a system table). */
export function recordOfPath(
  path: string | null | undefined
): { collection: string; item: string } | null {
  if (!path) return null
  const m = RECORD_PATH.exec(path)
  if (!m || m[2] === 'new' || SYSTEM.test(m[1])) return null
  let item = m[2]
  try {
    item = decodeURIComponent(item)
  } catch {
    /* keep it as sent */
  }
  return { collection: m[1], item }
}

const up = (v: unknown) => String(v ?? '').toUpperCase()
const recKey = (collection: string, item: string) => `${collection}:${item}`
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const num = (v: unknown): number | null => {
  const n = Number(v)
  return v != null && Number.isFinite(n) ? n : null
}

function scopesOf(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>))
    if (Array.isArray(v)) out[k] = v.map(String)
  return out
}

/** Pure: one board from the presence inputs. */
export function assembleTeamBoard(input: {
  presence: TeamBoardPresenceRow[]
  pages: TeamBoardPage[]
  viewers: TeamBoardViewerRoom[]
  locks: TeamBoardLock[]
  managers: Map<string, { id: string; name: string }>
  labels: Map<string, string>
  dimensions?: Array<{ name: string; label: string }>
  now?: number
}): TeamBoard {
  const now = input.now ?? Date.now()
  const people = new Map<string, TeamBoardPerson & { _recs: Map<string, TeamBoardRecord> }>()

  const ensure = (id: string, name: string) => {
    const key = up(id)
    let p = people.get(key)
    if (!p) {
      p = {
        id,
        name: name || 'Someone',
        role: null,
        manager: input.managers.get(key) ?? null,
        state: 'active',
        idle_minutes: null,
        stuck_minutes: null,
        last_active: null,
        page: null,
        app: null,
        view_as: false,
        status: null,
        in_huddle: false,
        scopes: {},
        records: [],
        tabs: 0,
        _recs: new Map()
      }
      people.set(key, p)
    }
    return p
  }
  const noteRecord = (
    p: TeamBoardPerson & { _recs: Map<string, TeamBoardRecord> },
    collection: string,
    item: string,
    patch: { since?: number | null; tab?: boolean; editing?: boolean }
  ) => {
    if (SYSTEM.test(collection)) return
    const k = recKey(collection, item)
    let r = p._recs.get(k)
    if (!r) {
      r = {
        collection,
        item,
        label: input.labels.get(k) ?? null,
        editing: false,
        since: null,
        tabs: 0
      }
      p._recs.set(k, r)
    }
    if (patch.since != null && (r.since == null || patch.since < r.since)) r.since = patch.since
    if (patch.tab) r.tabs++
    if (patch.editing) r.editing = true
  }

  // The roster: everyone the Online list knows about (admin signature — current_path included).
  for (const row of input.presence) {
    const id = str(row.user_id)
    if (!id) continue
    const p = ensure(id, str(row.display_name) ?? '')
    p.name = str(row.display_name) ?? p.name
    p.role = str(row.role_name)
    p.state = row.state === 'idle' ? 'idle' : row.state === 'stuck' ? 'stuck' : 'active'
    p.idle_minutes = num(row.idle_minutes)
    p.stuck_minutes = row.stuck ? (num(row.stuck.minutes) ?? null) : null
    p.last_active =
      str(row.last_active) ??
      (row.last_active instanceof Date ? row.last_active.toISOString() : null)
    p.page = str(row.page)
    p.app = str(row.app)
    // Who the administrator behind a View-as tab is stays out of the board.
    p.view_as = !!row.masquerade
    p.status = row.custom_status?.text
      ? { text: String(row.custom_status.text), emoji: row.custom_status.emoji ?? null }
      : null
    p.in_huddle = !!row.in_huddle
    p.scopes = scopesOf(row.scopes_by_dimension)
  }

  // Every open tab's page: one record per tab, how long it has been open.
  for (const pg of input.pages) {
    if (!pg?.user?.id) continue
    const p = ensure(pg.user.id, pg.user.name)
    p.tabs++
    if (!p.app && pg.app) p.app = pg.app
    const rec = recordOfPath(pg.path)
    if (rec) noteRecord(p, rec.collection, rec.item, { since: num(pg.since), tab: true })
  }

  // The Online row's page names a record only for someone with no page pings (a host that
  // does not send them): with live tabs it is just the last page any of them reported, often
  // one that is already closed.
  for (const row of input.presence) {
    const id = str(row.user_id)
    const p = id ? people.get(up(id)) : undefined
    if (!p || p.tabs > 0) continue
    const rec = recordOfPath(str(row.current_path))
    if (rec) noteRecord(p, rec.collection, rec.item, {})
  }

  // Record rooms (portal tabs that join without a page ping, other processes).
  for (const room of input.viewers)
    for (const v of room.viewers) {
      if (!v?.id) continue
      noteRecord(ensure(v.id, v.name), room.collection, room.item, {})
    }

  // Live edit locks: only for people the board already holds (a lock alone is no presence).
  for (const l of input.locks) {
    const p = people.get(up(l.user))
    if (!p) continue
    const at = l.locked_at ? new Date(l.locked_at).getTime() : null
    noteRecord(p, l.collection, String(l.item), {
      editing: true,
      since: at != null && Number.isFinite(at) ? at : null
    })
  }

  const out: TeamBoardPerson[] = []
  for (const p of people.values()) {
    const { _recs, ...rest } = p
    const records = [..._recs.values()]
      .map((r) => ({ ...r, tabs: Math.max(1, r.tabs) }))
      // Editing first, then the one opened most recently.
      .sort(
        (a, b) =>
          Number(b.editing) - Number(a.editing) ||
          (b.since ?? 0) - (a.since ?? 0) ||
          a.collection.localeCompare(b.collection) ||
          a.item.localeCompare(b.item)
      )
      .slice(0, 12)
    out.push({ ...rest, records })
  }
  // A stable order (name, then id): live refreshes never shuffle rows under the reader.
  out.sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id)
  )
  return {
    people: out,
    counts: {
      online: out.length,
      on_record: out.filter((p) => p.records.length > 0).length,
      editing: out.filter((p) => p.records.some((r) => r.editing)).length,
      idle: out.filter((p) => p.state === 'idle').length,
      stuck: out.filter((p) => p.state === 'stuck').length
    },
    dimensions: input.dimensions ?? [],
    at: new Date(now).toISOString()
  }
}
