import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import { recordVisibleTo } from '../services/revision-access.js'
import { viewAsAdminOf } from '../services/view-as-attribution.js'
import { addAlert, alertOptions, removeAlert } from '../services/watch-list/alerts.js'
import { readMentions } from '../services/watch-list/mentions.js'
import { readWatchRows } from '../services/watch-list/rows.js'
import {
  addPin,
  markSeen,
  normalizeDock,
  normalizeSettings,
  pinKey,
  pinnable,
  removePin,
  reorderPins,
  TEAM_ID,
  type TeamList,
  WATCH_PINS_MAX,
  type WatchListPrefs
} from '../services/watch-list/store.js'
import {
  createTeam,
  directReports,
  isMember,
  listablePeople,
  loadTeam,
  markTeamSeen,
  mayManage,
  maySee,
  memberIds,
  moveTeam,
  newTeam,
  ownerGone,
  peopleInfo,
  readablePins,
  saveTeam,
  takenOver,
  teamAddPin,
  teamAsWatchList,
  teamName,
  teamRemovePin,
  teamsFor,
  withMembers
} from '../services/watch-list/teams.js'
import { loadWatchList, saveWatchList } from '../services/watch-list/user-store.js'
import { readWaiting } from '../services/watch-list/waiting.js'
import type { User } from '../types.js'

/**
 * The watch list dock (rt5 #1 / #2, rt6) — the person's own pinned records, read and written for
 * themselves only (`/api/watch-list`). Storage: `preferences.watch_list` (services/watch-list/
 * store.ts); every save tells the person's other tabs and devices (`prefs:changed`).
 *
 *   GET    /watch-list/prefs               stored list: pins, dock, settings, alerts, shared lists
 *   GET    /watch-list?summary=1           rows as the viewer (summary: changed keys + others_at)
 *   POST   /watch-list/pins {collection,id} pin (the record must be readable; cap 50)
 *   DELETE /watch-list/pins/:collection/:id
 *   PUT    /watch-list/order {keys}        "My order"
 *   PATCH  /watch-list/dock {state,width,tab,sort}
 *   POST   /watch-list/seen {keys?}        changed marks seen (no keys = all)
 *   GET    /watch-list/waiting             records the person raised that wait on others
 *   GET    /watch-list/mentions            mentions + replies; POST /watch-list/replies-seen
 *   PATCH  /watch-list/settings {desktop, auto_add, auto_remove, digest}         (rt6 #4 #6 #9)
 *   GET    /watch-list/alert-options/:collection/:id   steps + readable fields    (rt6 #5)
 *   POST   /watch-list/alerts {collection,id,kind,step|field,label,repeat}; DELETE /alerts/:id
 *   POST   /watch-list/teams {name, members, reports?}                              (rt6 #1)
 *   PATCH  /watch-list/teams/:id {name?, members?}   DELETE /watch-list/teams/:id  (owner/admin)
 *   POST   /watch-list/teams/:id/leave
 *   GET    /watch-list/teams/:id/rows       the list's rows as the viewer
 *   POST   /watch-list/teams/:id/pins {collection,id}; DELETE /teams/:id/pins/:collection/:rid
 *   POST   /watch-list/teams/:id/seen {keys?}
 *
 * View-as: everything reads as the person; nothing is written (a pin, a seen mark or a dock
 * move made while viewing as someone is theirs to make, not the administrator's).
 */

interface PublicTeam {
  id: string
  name: string
  owner: { id: string; name: string }
  members: Array<{ id: string; name: string }>
  pins: Array<{ key: string; collection: string; id: string; pinned_at: string; by: string }>
  can_manage: boolean
  is_member: boolean
  /** The person who made it can no longer sign in: read-only until an administrator takes it. */
  owner_gone: boolean
  can_take_over: boolean
}

async function publicTeams(teams: TeamList[], user: User, isAdmin: boolean): Promise<PublicTeam[]> {
  if (teams.length === 0) return []
  const userId = String(user.id)
  const info = await peopleInfo(teams.flatMap((t) => [t.owner, ...t.members.map((m) => m.u)]))
  const nameOf = (id: string) => info[id.toLowerCase()]?.name ?? 'Someone'
  return Promise.all(
    teams.map(async (t) => {
      const gone = info[t.owner.toLowerCase()]?.gone ?? true
      // Only the records this viewer may open: never a key, a count or a name of another.
      const pins = await readablePins(t, user, isAdmin).catch(() => [])
      return {
        id: t.id,
        name: t.name,
        owner: { id: t.owner, name: nameOf(t.owner) },
        members: t.members.map((m) => ({ id: m.u, name: nameOf(m.u) })),
        pins: pins.map((p) => ({
          key: pinKey(p.c, p.id),
          collection: p.c,
          id: p.id,
          pinned_at: p.at,
          by: p.by
        })),
        can_manage: mayManage(t, userId, isAdmin) && !gone,
        is_member: isMember(t, userId),
        owner_gone: gone,
        can_take_over: gone && isAdmin
      }
    })
  )
}

async function answer(req: FastifyRequest, list: WatchListPrefs) {
  const userId = String(req.user!.id)
  const isAdmin = !!req.isAdmin
  const teams = await teamsFor(userId, list).catch(() => [] as TeamList[])
  return {
    pins: list.pins.map((p) => ({
      key: pinKey(p.c, p.id),
      collection: p.c,
      id: p.id,
      pinned_at: p.at,
      ...(p.auto ? { auto: true } : {})
    })),
    dock: list.dock,
    replies_seen_at: list.replies_seen_at,
    max: WATCH_PINS_MAX,
    settings: list.settings,
    alerts: list.alerts.map((a) => ({
      id: a.id,
      key: pinKey(a.c, a.rid),
      kind: a.kind,
      step: a.step ?? null,
      field: a.field ?? null,
      label: a.label ?? null,
      repeat: a.repeat,
      fired_at: a.fired ?? null
    })),
    teams: await publicTeams(teams, req.user!, isAdmin).catch(() => [])
  }
}

/** True (and answered) when this request may not change the list. */
function refusedWrite(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!viewAsAdminOf(req)) return false
  void reply.code(403).send({
    error: 'While viewing as someone, their watch list can be looked at but not changed',
    code: 'VIEW_AS_READ_ONLY'
  })
  return true
}

/** A list the caller may see, or the reply already sent (404 — never says it exists). */
async function teamFor(
  req: FastifyRequest,
  reply: FastifyReply,
  id: string,
  need: 'see' | 'member' | 'manage'
): Promise<TeamList | null> {
  const userId = String(req.user!.id)
  const isAdmin = !!req.isAdmin
  const team = TEAM_ID.test(id) ? await loadTeam(id) : null
  if (!team || !maySee(team, userId, isAdmin)) {
    void reply.code(404).send({ error: 'Not found' })
    return null
  }
  if (need === 'manage' && !mayManage(team, userId, isAdmin)) {
    void reply.code(403).send({
      error: 'Only the person who made this list (or an administrator) can change it',
      code: 'NOT_LIST_OWNER'
    })
    return null
  }
  if ((need === 'member' || need === 'manage') && (await ownerGone(team))) {
    void reply.code(409).send({
      error:
        'The person who made this list can no longer sign in. It is read-only until an administrator takes it over.',
      code: 'LIST_OWNER_GONE'
    })
    return null
  }
  if (need === 'member' && !isMember(team, userId) && !mayManage(team, userId, isAdmin)) {
    void reply.code(403).send({ error: 'Only people on this list can change its records' })
    return null
  }
  return team
}

export async function watchListRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth)

  app.get('/prefs', async (req) => {
    const { list } = await loadWatchList(String(req.user!.id))
    const reports = await directReports(String(req.user!.id))
      .then((r) => r.length)
      .catch(() => 0)
    const u = req.user as unknown as { first_name?: string | null; last_name?: string | null }
    const me = {
      id: String(req.user!.id),
      name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || 'You'
    }
    return { data: { ...(await answer(req, list)), direct_reports: reports, me } }
  })

  app.get<{ Querystring: { summary?: string } }>('/', async (req) => {
    const { list } = await loadWatchList(String(req.user!.id))
    const summary = req.query?.summary === '1' || req.query?.summary === 'true'
    const base = {
      pins: list.pins.map((p) => ({
        key: pinKey(p.c, p.id),
        collection: p.c,
        id: p.id,
        pinned_at: p.at
      })),
      max: WATCH_PINS_MAX
    }
    if (list.pins.length === 0) return { data: { ...base, rows: [], changed: [], others: {} } }
    const { rows, changed, others } = await readWatchRows(list, {
      user: req.user!,
      isAdmin: !!req.isAdmin,
      workspaceId: req.workspaceId ?? undefined,
      summary
    })
    return {
      data: {
        ...base,
        rows: summary ? undefined : rows,
        changed,
        ...(summary ? { others } : {})
      }
    }
  })

  app.post<{ Body: { collection?: unknown; id?: unknown } }>('/pins', async (req, reply) => {
    if (refusedWrite(req, reply)) return
    const collection = req.body?.collection
    const id = req.body?.id
    if (!pinnable(collection, id))
      return reply.code(400).send({ error: 'Name a record to watch', code: 'NOT_PINNABLE' })
    // Only a record the person can open (row filters, User Scopes): never confirms a hidden one.
    if (!(await recordVisibleTo(req, String(collection), String(id))))
      return reply.code(404).send({ error: 'Not found' })
    const userId = String(req.user!.id)
    const { list } = await loadWatchList(userId)
    const res = addPin(list, String(collection), String(id))
    if (!res.ok) return reply.code(409).send({ error: res.message, code: res.code })
    if (res.changed) await saveWatchList(userId, res.list)
    return reply.send({ data: await answer(req, res.list) })
  })

  app.delete<{ Params: { collection: string; id: string } }>(
    '/pins/:collection/:id',
    async (req, reply) => {
      if (refusedWrite(req, reply)) return
      const userId = String(req.user!.id)
      const { list } = await loadWatchList(userId)
      // Unpinning needs no read access: a record they can no longer open can still go.
      const res = removePin(list, req.params.collection, req.params.id)
      if (res.changed) await saveWatchList(userId, res.list)
      return reply.send({ data: await answer(req, res.list) })
    }
  )

  app.put<{ Body: { keys?: unknown } }>('/order', async (req, reply) => {
    if (refusedWrite(req, reply)) return
    if (!Array.isArray(req.body?.keys))
      return reply.code(400).send({ error: 'keys must be a list' })
    const userId = String(req.user!.id)
    const { list } = await loadWatchList(userId)
    const next = reorderPins(list, req.body.keys)
    await saveWatchList(userId, next)
    return reply.send({ data: await answer(req, next) })
  })

  app.patch<{ Body: Record<string, unknown> }>('/dock', async (req, reply) => {
    const userId = String(req.user!.id)
    const { list } = await loadWatchList(userId)
    const dock = normalizeDock(req.body ?? {}, list.dock)
    const next = { ...list, dock }
    // View-as: the dock moves on screen but the person's saved arrangement stays theirs.
    if (!viewAsAdminOf(req)) await saveWatchList(userId, next)
    return reply.send({ data: await answer(req, next) })
  })

  app.post<{ Body: { keys?: unknown } }>('/seen', async (req, reply) => {
    const userId = String(req.user!.id)
    const { list } = await loadWatchList(userId)
    if (viewAsAdminOf(req)) return reply.send({ data: await answer(req, list) })
    const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String).slice(0, 100) : null
    const res = markSeen(list, keys)
    if (res.changed) await saveWatchList(userId, res.list)
    return reply.send({ data: await answer(req, res.list) })
  })

  app.get<{ Querystring: { fresh?: string } }>('/waiting', async (req) => {
    const rows = await readWaiting(req.user!, !!req.isAdmin, { fresh: req.query?.fresh === '1' })
    return { data: { rows } }
  })

  app.get('/mentions', async (req) => {
    const { list } = await loadWatchList(String(req.user!.id))
    return { data: await readMentions(req.user!, !!req.isAdmin, list.replies_seen_at) }
  })

  app.post('/replies-seen', async (req, reply) => {
    const userId = String(req.user!.id)
    const { list } = await loadWatchList(userId)
    if (viewAsAdminOf(req)) return reply.send({ data: await answer(req, list) })
    const next = { ...list, replies_seen_at: new Date().toISOString() }
    await saveWatchList(userId, next)
    return reply.send({ data: await answer(req, next) })
  })

  // ── Settings (desktop alerts, auto-add / remove, daily email) ────────────────
  app.patch<{ Body: Record<string, unknown> }>('/settings', async (req, reply) => {
    if (refusedWrite(req, reply)) return
    const userId = String(req.user!.id)
    const { list } = await loadWatchList(userId)
    const settings = normalizeSettings(req.body ?? {}, list.settings)
    // Removing automatically needs adding automatically.
    if (!settings.auto_add) settings.auto_remove = false
    const next = { ...list, settings }
    await saveWatchList(userId, next)
    return reply.send({ data: await answer(req, next) })
  })

  // ── Alert rules on pinned records ────────────────────────────────────────────
  app.get<{ Params: { collection: string; id: string } }>(
    '/alert-options/:collection/:id',
    async (req, reply) => {
      const { collection, id } = req.params
      if (!pinnable(collection, id)) return reply.code(400).send({ error: 'Name a record' })
      if (!(await recordVisibleTo(req, collection, id)))
        return reply.code(404).send({ error: 'Not found' })
      return {
        data: await alertOptions(req.user!, !!req.isAdmin, collection, id)
      }
    }
  )

  app.post<{ Body: Record<string, unknown> }>('/alerts', async (req, reply) => {
    if (refusedWrite(req, reply)) return
    const b = req.body ?? {}
    if (!pinnable(b.collection, b.id))
      return reply.code(400).send({ error: 'Name a record', code: 'NOT_PINNABLE' })
    if (!(await recordVisibleTo(req, String(b.collection), String(b.id))))
      return reply.code(404).send({ error: 'Not found' })
    // A field alert only on a field the person may read (it would otherwise answer a
    // question about a hidden value).
    if (b.kind === 'field') {
      const opts = await alertOptions(req.user!, !!req.isAdmin, String(b.collection), String(b.id))
      if (!opts.fields.some((f) => f.field === b.field))
        return reply.code(400).send({ error: 'Choose a field you can see', code: 'BAD_ALERT' })
    }
    const userId = String(req.user!.id)
    const { list } = await loadWatchList(userId)
    const res = addAlert(list, b as never)
    if (!res.ok) return reply.code(409).send({ error: res.message, code: res.code })
    await saveWatchList(userId, res.list)
    return reply.send({ data: await answer(req, res.list) })
  })

  app.delete<{ Params: { alertId: string } }>('/alerts/:alertId', async (req, reply) => {
    if (refusedWrite(req, reply)) return
    const userId = String(req.user!.id)
    const { list } = await loadWatchList(userId)
    const res = removeAlert(list, req.params.alertId)
    if (res.changed) await saveWatchList(userId, res.list)
    return reply.send({ data: await answer(req, res.list) })
  })

  // ── Shared lists for a team ──────────────────────────────────────────────────
  app.post<{ Body: { name?: unknown; members?: unknown; reports?: unknown } }>(
    '/teams',
    async (req, reply) => {
      if (refusedWrite(req, reply)) return
      const userId = String(req.user!.id)
      const name = teamName(req.body?.name)
      if (!name) return reply.code(400).send({ error: 'Give the list a name' })
      const reports = await directReports(userId).catch(() => [] as string[])
      const asked = memberIds(req.body?.members)
      const wanted = memberIds([...asked, ...(req.body?.reports === true ? reports : [])])
      const people = await listablePeople(wanted)
      const team = newTeam({
        owner: userId,
        name,
        members: people,
        // An administrator or a manager may make a list for a team they are not on.
        creatorMayStayOff: !!req.isAdmin || reports.length > 0,
        now: new Date()
      })
      const res = await createTeam(team)
      if (!res.ok) return reply.code(409).send({ error: res.message, code: 'TEAM_LISTS_FULL' })
      const { list } = await loadWatchList(userId)
      return reply.send({ data: { ...(await answer(req, list)), created: team.id } })
    }
  )

  app.patch<{ Params: { id: string }; Body: { name?: unknown; members?: unknown } }>(
    '/teams/:id',
    async (req, reply) => {
      if (refusedWrite(req, reply)) return
      const team = await teamFor(req, reply, req.params.id, 'manage')
      if (!team) return
      let next: TeamList = team
      if (req.body?.name !== undefined) {
        const name = teamName(req.body.name)
        if (!name) return reply.code(400).send({ error: 'Give the list a name' })
        next = { ...next, name }
      }
      if (req.body?.members !== undefined) {
        const wanted = memberIds(req.body.members)
        // People already on it stay even if their account changed; new people must be listable.
        const fresh = await listablePeople(
          wanted.filter((w) => !team.members.some((m) => m.u.toLowerCase() === w.toLowerCase()))
        )
        const keep = wanted.filter(
          (w) =>
            team.members.some((m) => m.u.toLowerCase() === w.toLowerCase()) || fresh.includes(w)
        )
        next = withMembers(next, keep, new Date())
      }
      await saveTeam(team, next)
      const { list } = await loadWatchList(String(req.user!.id))
      return reply.send({ data: await answer(req, list) })
    }
  )

  app.delete<{ Params: { id: string } }>('/teams/:id', async (req, reply) => {
    if (refusedWrite(req, reply)) return
    // An administrator may delete a list whose owner is gone; otherwise owner or admin.
    const team = await teamFor(req, reply, req.params.id, 'see')
    if (!team) return
    if (!mayManage(team, String(req.user!.id), !!req.isAdmin))
      return reply.code(403).send({
        error: 'Only the person who made this list (or an administrator) can delete it',
        code: 'NOT_LIST_OWNER'
      })
    await saveTeam(team, null)
    const { list } = await loadWatchList(String(req.user!.id))
    return reply.send({ data: await answer(req, list) })
  })

  // An administrator takes over a list whose owner can no longer sign in (it moves to their row).
  app.post<{ Params: { id: string } }>('/teams/:id/take-over', async (req, reply) => {
    if (refusedWrite(req, reply)) return
    if (!req.isAdmin)
      return reply.code(403).send({ error: 'Only an administrator can take over a shared list' })
    const team = await teamFor(req, reply, req.params.id, 'see')
    if (!team) return
    if (!(await ownerGone(team)))
      return reply.code(409).send({
        error: 'The person who made this list can still sign in; they own it',
        code: 'LIST_OWNER_ACTIVE'
      })
    const next = takenOver(team, String(req.user!.id))
    await moveTeam(team, next)
    const { list } = await loadWatchList(String(req.user!.id))
    return reply.send({ data: { ...(await answer(req, list)), moved: next.id } })
  })

  app.post<{ Params: { id: string } }>('/teams/:id/leave', async (req, reply) => {
    if (refusedWrite(req, reply)) return
    const team = await teamFor(req, reply, req.params.id, 'see')
    if (!team) return
    const userId = String(req.user!.id)
    if (isMember(team, userId)) {
      await saveTeam(
        team,
        withMembers(
          team,
          team.members.filter((m) => m.u.toLowerCase() !== userId.toLowerCase()).map((m) => m.u),
          new Date()
        )
      )
    }
    const { list } = await loadWatchList(userId)
    return reply.send({ data: await answer(req, list) })
  })

  app.get<{ Params: { id: string } }>('/teams/:id/rows', async (req, reply) => {
    const team = await teamFor(req, reply, req.params.id, 'see')
    if (!team) return
    const userId = String(req.user!.id)
    const { list } = await loadWatchList(userId)
    if (team.pins.length === 0) return reply.send({ data: { rows: [], changed: [] } })
    // Read AS THE VIEWER: each person sees only the rows they may read.
    const { rows, changed } = await readWatchRows(teamAsWatchList(team, userId, list), {
      user: req.user!,
      isAdmin: !!req.isAdmin,
      workspaceId: req.workspaceId ?? undefined
    })
    // Each person sees only what they may read: a record they cannot open is left out, not
    // shown as "no longer available" (that would name it).
    const readable = rows.filter((r) => r.available)
    const keys = new Set(readable.map((r) => r.key))
    return reply.send({ data: { rows: readable, changed: changed.filter((k) => keys.has(k)) } })
  })

  app.post<{ Params: { id: string }; Body: { collection?: unknown; id?: unknown } }>(
    '/teams/:id/pins',
    async (req, reply) => {
      if (refusedWrite(req, reply)) return
      const team = await teamFor(req, reply, req.params.id, 'member')
      if (!team) return
      const c = req.body?.collection
      const rid = req.body?.id
      if (!pinnable(c, rid))
        return reply.code(400).send({ error: 'Name a record to watch', code: 'NOT_PINNABLE' })
      if (!(await recordVisibleTo(req, String(c), String(rid))))
        return reply.code(404).send({ error: 'Not found' })
      const res = teamAddPin(team, String(c), String(rid), String(req.user!.id), new Date())
      if (!res.ok) return reply.code(409).send({ error: res.message, code: res.code })
      if (res.changed) await saveTeam(team, res.team)
      const { list } = await loadWatchList(String(req.user!.id))
      return reply.send({ data: await answer(req, list) })
    }
  )

  app.delete<{ Params: { id: string; collection: string; rid: string } }>(
    '/teams/:id/pins/:collection/:rid',
    async (req, reply) => {
      if (refusedWrite(req, reply)) return
      const team = await teamFor(req, reply, req.params.id, 'member')
      if (!team) return
      const next = teamRemovePin(team, req.params.collection, req.params.rid)
      if (next.pins.length !== team.pins.length) await saveTeam(team, next)
      const { list } = await loadWatchList(String(req.user!.id))
      return reply.send({ data: await answer(req, list) })
    }
  )

  app.post<{ Params: { id: string }; Body: { keys?: unknown } }>(
    '/teams/:id/seen',
    async (req, reply) => {
      const team = await teamFor(req, reply, req.params.id, 'see')
      if (!team) return
      const userId = String(req.user!.id)
      const { list } = await loadWatchList(userId)
      if (viewAsAdminOf(req)) return reply.send({ data: { ok: true } })
      const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String).slice(0, 100) : null
      await saveWatchList(userId, markTeamSeen(list, team, keys, new Date()), { announce: false })
      return reply.send({ data: { ok: true } })
    }
  )
}
