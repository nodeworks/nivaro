import { db } from '../../db/index.js'
import { tenantState } from '../ai-tenant-state.js'
import { peopleWith } from './flags.js'
import {
  DONE_REMOVE_MS,
  pinKey,
  REMOVED_KEEP_MS,
  REMOVED_MAX,
  type RemovedPin,
  seenAt,
  type TeamList,
  type WatchListPrefs
} from './store.js'
import { updateWatchList, WATCH_KEY } from './user-store.js'

/** A shared list lives on its owner's row: its members' tabs hear about a change too. */
async function announceTeamMembers(before: WatchListPrefs, after: WatchListPrefs | null) {
  if (!after) return
  const ids = new Set<string>()
  for (const t of after.teams) {
    const old = before.teams.find((x) => x.id === t.id)
    if (old && old.pins === t.pins && old.removed === t.removed) continue
    for (const m of t.members) ids.add(m.u)
  }
  if (ids.size === 0) return
  const { announcePrefsChanged } = await import('../user-sync.js')
  for (const id of ids) {
    try {
      announcePrefsChanged(id, [WATCH_KEY])
    } catch {
      /* a tab that misses it reads the list on its next open */
    }
  }
}

/**
 * "Remove records when they're completed" (Rob, 2026-11-15) — a switch per list: the person's own
 * list (settings.remove_completed, off until turned on) and each shared list (the owner's switch;
 * new lists start on, lists made before it existed read as off).
 *
 * Completed = the record came to rest on a FINAL pipeline step, or — for a collection with no
 * pipeline — the picker badges' automatic "Inactive / Archived" rule says so (services/
 * picker-badges.ts `defaultBadgeRules` + `ruleMatches`: one definition of "closed", not a third).
 *
 *   - marking: the move's rest point (transitions.ts) and the after-update hook (no-pipeline
 *     collections) stamp `done` on every list holding the record that has the switch on; a record
 *     that is reopened loses the stamp. Only lists flagged `wl_done` are looked at, in memory.
 *   - the row says "Completed" (the person sees it finished);
 *   - it leaves the list 24 h after completion, or as soon as the person has seen it after
 *     completion (their own list; a shared list waits the 24 h) — cron `watch-list-completed`
 *     plus the seen route;
 *   - "Recently removed" keeps it 7 days with Undo (put back = kept: never removed for being
 *     completed again).
 *
 * Removal never notifies anyone; the person's tabs (and a shared list's members) hear
 * `prefs:changed` and the row moves quietly.
 */

const sameKey = (a: { c: string; id: string }, c: string, id: string) =>
  a.c === c && String(a.id) === String(id)

/** Stamp (or clear) completion on every list in `list` that removes completed records. Pure. */
export function markDone(
  list: WatchListPrefs,
  c: string,
  id: string,
  done: boolean,
  at: Date
): WatchListPrefs | null {
  const stamp = at.toISOString()
  let changed = false
  const pins = list.pins.map((p) => {
    if (!sameKey(p, c, id) || !list.settings.remove_completed || p.keep) return p
    if (done && !p.done) {
      changed = true
      return { ...p, done: stamp }
    }
    if (!done && p.done) {
      changed = true
      const { done: _d, ...rest } = p
      return rest
    }
    return p
  })
  const teams = list.teams.map((t) => {
    if (!t.remove_completed) return t
    let tChanged = false
    const tp = t.pins.map((p) => {
      if (!sameKey(p, c, id) || p.keep) return p
      if (done && !p.done) {
        tChanged = true
        return { ...p, done: stamp }
      }
      if (!done && p.done) {
        tChanged = true
        const { done: _d, ...rest } = p
        return rest
      }
      return p
    })
    if (!tChanged) return t
    changed = true
    return { ...t, pins: tp }
  })
  return changed ? { ...list, pins, teams } : null
}

function prune(removed: RemovedPin[], now: number): RemovedPin[] {
  return removed
    .filter((r) => now - new Date(r.gone).getTime() < REMOVED_KEEP_MS)
    .slice(0, REMOVED_MAX)
}

/** A completed pin is due to leave: 24 h passed, or (own list) seen after completion. Pure. */
export function isDue(done: string, now: number, seen: string | null): boolean {
  const t = new Date(done).getTime()
  if (!Number.isFinite(t)) return false
  if (now - t >= DONE_REMOVE_MS) return true
  return !!seen && seen > done
}

/**
 * Take off every completed pin that is due (own list + shared lists this person owns) and drop
 * "recently removed" entries past 7 days. null = nothing to change. Pure.
 */
export function dueRemovals(list: WatchListPrefs, now: Date = new Date()): WatchListPrefs | null {
  const ms = now.getTime()
  const gone = now.toISOString()
  let changed = false
  const keepPins = []
  const removed: RemovedPin[] = []
  for (const p of list.pins) {
    if (p.done && !p.keep && isDue(p.done, ms, seenAt(list, p))) {
      changed = true
      removed.push({
        c: p.c,
        id: p.id,
        at: p.at,
        ...(p.auto ? { auto: true } : {}),
        done: p.done,
        gone
      })
    } else keepPins.push(p)
  }
  const prunedOwn = prune([...removed, ...list.removed], ms)
  if (prunedOwn.length !== removed.length + list.removed.length) changed = true
  const teams: TeamList[] = list.teams.map((t) => {
    const stay = []
    const out: RemovedPin[] = []
    for (const p of t.pins) {
      // A shared list has no single "seen": its completed records leave after 24 h.
      if (p.done && !p.keep && isDue(p.done, ms, null)) {
        out.push({ c: p.c, id: p.id, at: p.at, by: p.by, done: p.done, gone })
      } else stay.push(p)
    }
    const pruned = prune([...out, ...t.removed], ms)
    if (out.length === 0 && pruned.length === t.removed.length) return t
    changed = true
    return { ...t, pins: stay, removed: pruned }
  })
  if (!changed) return null
  // A removed pin's seen mark goes with it; its alerts were for a record no longer watched.
  const goneKeys = new Set(removed.map((r) => pinKey(r.c, r.id)))
  const seen = Object.fromEntries(Object.entries(list.seen).filter(([k]) => !goneKeys.has(k)))
  const alerts = list.alerts.filter((a) => !goneKeys.has(pinKey(a.c, a.rid)))
  return { ...list, pins: keepPins, removed: prunedOwn, seen, alerts, teams }
}

/** Undo on the person's own list: the pin comes back as it was, and stays. Pure. */
export function restoreRemoved(
  list: WatchListPrefs,
  c: string,
  id: string,
  now: Date = new Date()
): WatchListPrefs | null {
  const r = list.removed.find((x) => sameKey(x, c, id))
  if (!r) return null
  if (list.pins.some((p) => sameKey(p, c, id)))
    return { ...list, removed: list.removed.filter((x) => x !== r) }
  return {
    ...list,
    pins: [
      { c: r.c, id: r.id, at: r.at, ...(r.auto ? { auto: true } : {}), keep: true },
      ...list.pins
    ],
    removed: list.removed.filter((x) => x !== r),
    seen: { ...list.seen, [pinKey(c, id)]: now.toISOString() }
  }
}

/** Undo on a shared list. Pure. */
export function restoreTeamRemoved(team: TeamList, c: string, id: string): TeamList | null {
  const r = team.removed.find((x) => sameKey(x, c, id))
  if (!r) return null
  const back = team.pins.some((p) => sameKey(p, c, id))
    ? team.pins
    : [{ c: r.c, id: r.id, at: r.at, by: r.by ?? team.owner, keep: true }, ...team.pins]
  return { ...team, pins: back, removed: team.removed.filter((x) => x !== r) }
}

// ── Runtime ───────────────────────────────────────────────────────────────────────

/** Every list (by person) that holds this record and removes completed records. */
async function holders(c: string, id: string): Promise<string[]> {
  const people = await peopleWith('wl_done')
  const out: string[] = []
  for (const [user, list] of people) {
    const own = list.settings.remove_completed && list.pins.some((p) => sameKey(p, c, id))
    const team = list.teams.some((t) => t.remove_completed && t.pins.some((p) => sameKey(p, c, id)))
    if (own || team) out.push(user)
  }
  return out
}

/** Stamp or clear completion for one record on every list that holds it. Never throws. */
export async function applyCompletion(
  c: string,
  id: string,
  done: boolean,
  at: Date = new Date()
): Promise<number> {
  try {
    const users = await holders(c, id)
    let n = 0
    for (const u of users) {
      let before: WatchListPrefs | null = null
      const saved = await updateWatchList(u, (l) => {
        before = l
        return markDone(l, c, id, done, at)
      }).catch(() => null)
      if (saved && before) {
        n++
        await announceTeamMembers(before, saved)
      }
    }
    return n
  } catch {
    return 0
  }
}

/** Collections someone watches with the switch on (a cheap gate for the write hook). */
export async function watchedForDone(): Promise<Set<string>> {
  const people = await peopleWith('wl_done')
  const out = new Set<string>()
  for (const list of people.values()) {
    if (list.settings.remove_completed) for (const p of list.pins) out.add(p.c)
    for (const t of list.teams) if (t.remove_completed) for (const p of t.pins) out.add(p.c)
  }
  return out
}

const pipelineCache = tenantState(() => new Map<string, { at: number; bound: boolean }>())

/** Is the collection bound to a pipeline (then the final step decides, not a column)? */
async function hasPipeline(c: string): Promise<boolean> {
  const hit = pipelineCache().get(c)
  if (hit && Date.now() - hit.at < 60_000) return hit.bound
  const row = await db('nivaro_workflow_bindings')
    .where({ collection: c })
    .first('id')
    .catch(() => undefined)
  const bound = !!row
  pipelineCache().set(c, { at: Date.now(), bound })
  return bound
}

/**
 * For a collection with no pipeline: does this row read "closed" by the picker badges' own
 * automatic rule (Inactive / Archived)? null = the collection has no such rule (or a pipeline).
 */
export async function closedByRule(
  c: string,
  row: Record<string, unknown>
): Promise<boolean | null> {
  if (await hasPipeline(c)) return null
  const { getFields } = await import('../collections.js')
  const fields = (await getFields(c).catch(() => [])) as Array<{
    field: string
    type?: string | null
  }>
  const { defaultBadgeRules, ruleMatches } = await import('../picker-badges.js')
  const rules = defaultBadgeRules({ pipeline: false, fields }).filter(
    (r) => r.key === 'closed' || r.key === 'inactive'
  )
  if (rules.length === 0) return null
  const fieldsRead = rules.map((r) => r.when.field).filter((f): f is string => !!f)
  if (!fieldsRead.some((f) => f in row)) return null
  return rules.some((r) => ruleMatches(r, row, false))
}

/** The 10-minute pass: take off due completed pins; prune "recently removed". */
export async function runCompletedSweep(
  now: Date = new Date()
): Promise<{ people: number; changed: number }> {
  const people = await peopleWith('wl_done')
  let changed = 0
  for (const [user] of people) {
    let before: WatchListPrefs | null = null
    const saved = await updateWatchList(user, (l) => {
      before = l
      return dueRemovals(l, now)
    }).catch(() => null)
    if (saved && before) {
      changed++
      await announceTeamMembers(before, saved)
    }
  }
  return { people: people.size, changed }
}
