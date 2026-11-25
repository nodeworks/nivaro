import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { insertReturningId } from '../db/dialect/ef.js'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { idParam, isAppOwner, readApp } from '../services/hub/apps.js'
import {
  freezeActive,
  freezeOff,
  freezeOn,
  hideBanner,
  IncidentError,
  openIncident,
  resolveIncident,
  SEV_LABEL,
  showBanner,
  toneFor,
  validateOpen
} from '../services/hub/incident/incidents.js'
import { acknowledgePage, listPages, PageError, readPage } from '../services/hub/incident/paging.js'
import {
  draftPostMortem,
  normalizePostMortem,
  type PostMortem,
  postMortemHtml,
  postMortemMarkdown
} from '../services/hub/incident/postmortem.js'
import {
  onCallAt,
  upcomingShifts,
  validateOverride,
  validateRota
} from '../services/hub/incident/rota.js'
import {
  listStatusPages,
  mintToken,
  readStatusPage,
  statusAnswer,
  validateStatusPage
} from '../services/hub/incident/status-page.js'
import {
  activeAccounts,
  activeAdminIds,
  addEvent,
  EVENTS,
  INCIDENTS,
  type Incident,
  listEvents,
  listIncidents,
  listOverrides,
  listRotas,
  OVERRIDES,
  PAGES,
  patchIncident,
  ROTAS,
  readIncident,
  readRota,
  SEVERITIES,
  STATUS_PAGES
} from '../services/hub/incident/store.js'
import { runIncidentTick } from '../services/hub/incident/tick.js'
import { hubModeEnabled } from '../services/hub/mode.js'
import { personNames } from '../services/hub/releases/person.js'
import { plainBannerText } from '../services/hub-link/status-banner.js'

/**
 * Hub incidents, on-call and status pages (Hub enhancements 32–35), mounted at /api/hub beside
 * routes/hub.ts, only with HUB=on (never in cloud mode).
 *
 * Who: reads are the Hub administrators' and each app's owners' (an app they do not own answers
 * 404); a person on call reads the pages sent to them and the rotas they are on. Every write is
 * admin-only and logged (logActivity) — except acknowledging a page, which a person it was sent
 * to may do too (a receipt, not a change). Internal status pages open for every signed-in person.
 * The credential gate (services/hub/api/gate.ts) swaps requireAuth / requireAdmin here as on
 * every /api/hub route.
 *
 * Moves: an incident is allowed while a move is open (that is when one is needed); a banner push
 * goes to the environment's current link and is retried.
 *
 * Job: hub-incident-tick (every minute, one leader; services/hub/incident/tick.ts).
 */

type Body = Record<string, unknown>

function body(req: FastifyRequest): Body {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {}
}

function fail(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.code(status).send({ error, code })
}

const notFound = (reply: FastifyReply) => fail(reply, 404, 'NOT_FOUND', 'Not found')
const userId = (req: FastifyRequest) => String(req.user?.id ?? '')

async function ownedAppIds(req: FastifyRequest): Promise<number[]> {
  const rows = (await db('nivaro_hub_app_owners')
    .where({ user_id: userId(req) })
    .select('app_id')) as Array<{ app_id: number }>
  return rows.map((r) => Number(r.app_id))
}

/** Apps the caller may read: null = every app (admin). */
async function readableAppIds(req: FastifyRequest): Promise<number[] | null> {
  return req.isAdmin ? null : ownedAppIds(req)
}

async function canReadApp(req: FastifyRequest, appId: number): Promise<boolean> {
  return !!req.isAdmin || (await isAppOwner(appId, userId(req)))
}

function refusal(reply: FastifyReply, err: unknown) {
  if (err instanceof IncidentError || err instanceof PageError)
    return fail(reply, err.status, err.code, err.message)
  throw err
}

async function readableIncident(req: FastifyRequest): Promise<Incident | null> {
  const id = idParam((req.params as { id?: string }).id)
  const inc = id === null ? null : await readIncident(id)
  if (!inc || !(await canReadApp(req, inc.app_id))) return null
  return inc
}

async function adminIncident(req: FastifyRequest): Promise<Incident | null> {
  const id = idParam((req.params as { id?: string }).id)
  return id === null ? null : readIncident(id)
}

const nameOf = (names: Map<string, string>, id: string | null | undefined) =>
  id ? (names.get(id.toLowerCase()) ?? null) : null

async function appInfo(ids: number[]) {
  const rows = (await db('nivaro_hub_apps')
    .whereIn('id', ids.length ? ids : [-1])
    .select('id', 'key', 'name')) as Array<{ id: number; key: string; name: string }>
  return new Map(
    rows.map((r) => [Number(r.id), { key: String(r.key), name: String(r.name || r.key) }])
  )
}

async function envInfo(ids: number[]) {
  const rows = (await db('nivaro_hub_environments')
    .whereIn('id', ids.length ? ids : [-1])
    .select('id', 'key')) as Array<{ id: number; key: string }>
  return new Map(rows.map((r) => [Number(r.id), String(r.key)]))
}

async function exportFacts(inc: Incident) {
  const apps = await appInfo([inc.app_id])
  const envs = await envInfo(inc.environment_id != null ? [inc.environment_id] : [])
  return {
    app: apps.get(inc.app_id)?.name ?? `app ${inc.app_id}`,
    environment: inc.environment_id != null ? (envs.get(inc.environment_id) ?? null) : null,
    severity: inc.severity,
    status: inc.status,
    opened_at: inc.opened_at,
    resolved_at: inc.resolved_at
  }
}

function fileName(inc: Incident, ext: string): string {
  const slug = inc.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return `incident-${inc.id}${slug ? `-${slug}` : ''}.${ext}`
}

export async function hubIncidentRoutes(app: FastifyInstance): Promise<void> {
  if (!hubModeEnabled()) return

  if (app.cron) {
    app.cron.schedule(
      'hub-incident-tick',
      '* * * * *',
      async () => {
        const r = await runIncidentTick()
        if (r.errors.length) throw new Error(`hub-incident-tick: ${r.errors.join('; ')}`)
      },
      {
        quiet: true,
        idempotent: 'safe',
        description:
          'Every minute (Hub only) — escalates on-call pages nobody acknowledged, refreshes and retries incident status banners over the hub link, keeps open incidents’ deploy freezes on, and pages on-call when a production environment of an app with a rota stops answering. State lives in nivaro_hub_pages / _incidents, so a missed tick is picked up by the next.'
      }
    )
  }

  // ─── Incidents ─────────────────────────────────────────────────────────────

  app.get('/incidents', { preHandler: requireAuth }, async (req) => {
    const q = (req.query ?? {}) as { status?: string; app_id?: string }
    const ids = await readableAppIds(req)
    const appFilter = q.app_id ? idParam(q.app_id) : null
    const scope = appFilter != null ? (ids ? ids.filter((x) => x === appFilter) : [appFilter]) : ids
    const rows = await listIncidents({
      appIds: scope,
      status: q.status === 'open' || q.status === 'resolved' ? q.status : undefined,
      limit: 200
    })
    const apps = await appInfo([...new Set(rows.map((r) => r.app_id))])
    const envs = await envInfo(
      rows.map((r) => r.environment_id).filter((x): x is number => x != null)
    )
    const names = await personNames(rows.flatMap((r) => [r.opened_by, r.acknowledged_by]))
    const now = Date.now()
    return {
      data: await Promise.all(
        rows.map(async (r) => ({
          id: r.id,
          app_id: r.app_id,
          app_name: apps.get(r.app_id)?.name ?? null,
          environment_id: r.environment_id,
          environment_key: r.environment_id != null ? (envs.get(r.environment_id) ?? null) : null,
          title: r.title,
          severity: r.severity,
          status: r.status,
          opened_at: r.opened_at,
          opened_by_name: nameOf(names, r.opened_by),
          acknowledged_at: r.acknowledged_at,
          acknowledged_by_name: nameOf(names, r.acknowledged_by),
          resolved_at: r.resolved_at,
          banner: !!r.banner_text && r.status === 'open',
          frozen: r.status === 'open' && (await freezeActive(r, now)),
          postmortem: r.postmortem != null
        }))
      )
    }
  })

  app.get('/incidents/:id', { preHandler: requireAuth }, async (req, reply) => {
    const inc = await readableIncident(req)
    if (!inc) return notFound(reply)
    const events = await listEvents(inc.id)
    const page = inc.page_id != null ? await readPage(inc.page_id) : null
    const names = await personNames([
      inc.opened_by,
      inc.acknowledged_by,
      inc.resolved_by,
      inc.postmortem_by,
      ...events.map((e) => e.user_id),
      ...(page?.sent_to.flatMap((s) => s.users) ?? [])
    ])
    const apps = await appInfo([inc.app_id])
    const envKeys = await envInfo(
      [inc.environment_id, ...Object.keys(inc.banner_state).map(Number)].filter(
        (x): x is number => x != null
      )
    )
    return {
      data: {
        ...inc,
        app_name: apps.get(inc.app_id)?.name ?? null,
        environment_key:
          inc.environment_id != null ? (envKeys.get(inc.environment_id) ?? null) : null,
        opened_by_name: nameOf(names, inc.opened_by),
        acknowledged_by_name: nameOf(names, inc.acknowledged_by),
        resolved_by_name: nameOf(names, inc.resolved_by),
        postmortem_by_name: nameOf(names, inc.postmortem_by),
        frozen: inc.status === 'open' && (await freezeActive(inc)),
        banner_envs: Object.entries(inc.banner_state).map(([id, s]) => ({
          environment_id: Number(id),
          environment_key: envKeys.get(Number(id)) ?? null,
          ...s
        })),
        events: events.map((e) => ({ ...e, user_name: nameOf(names, e.user_id) })),
        page: page
          ? {
              id: page.id,
              status: page.status,
              level: page.level,
              next_at: page.next_at,
              acknowledged_at: page.acknowledged_at,
              acknowledged_by_name: nameOf(names, page.acknowledged_by),
              sent_to: page.sent_to.map((s) => ({
                ...s,
                names: s.users.map((u) => nameOf(names, u) ?? 'Someone')
              }))
            }
          : null,
        can_write: !!req.isAdmin
      }
    }
  })

  app.post('/apps/:id/incidents', { preHandler: requireAdmin }, async (req, reply) => {
    const appId = idParam((req.params as { id: string }).id)
    const found = appId === null ? null : await readApp(appId)
    if (!found || appId === null) return notFound(reply)
    const v = validateOpen(body(req))
    if ('error' in v) return fail(reply, 400, 'BAD_INCIDENT', v.error)
    try {
      const inc = await openIncident({ ...v, app_id: appId }, userId(req))
      await logActivity({
        action: 'hub-incident-open',
        user: userId(req),
        collection: INCIDENTS,
        item: String(inc.id),
        comment: `${found.key}: ${SEV_LABEL[inc.severity]} ${inc.title}`,
        req
      })
      return reply.code(201).send({ data: inc })
    } catch (err) {
      return refusal(reply, err)
    }
  })

  app.patch('/incidents/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const inc = await adminIncident(req)
    if (!inc) return notFound(reply)
    const b = body(req)
    const patch: Record<string, unknown> = {}
    const said: string[] = []
    if (b.title !== undefined) {
      const t = typeof b.title === 'string' ? b.title.trim().replace(/\s+/g, ' ') : ''
      if (!t || t.length > 200)
        return fail(reply, 400, 'BAD_INCIDENT', 'title is 1 to 200 characters')
      if (t !== inc.title) {
        patch.title = t
        said.push(`title “${t}”`)
      }
    }
    if (b.severity !== undefined) {
      if (!(SEVERITIES as readonly unknown[]).includes(b.severity))
        return fail(reply, 400, 'BAD_INCIDENT', 'severity is sev1, sev2 or sev3')
      if (b.severity !== inc.severity) {
        patch.severity = b.severity
        if (inc.banner_text) patch.banner_tone = toneFor(b.severity as never)
        said.push(SEV_LABEL[b.severity as keyof typeof SEV_LABEL])
      }
    }
    if (b.summary !== undefined) {
      const s = typeof b.summary === 'string' ? b.summary.trim().slice(0, 8000) : ''
      patch.summary = s || null
      said.push('summary')
    }
    if (!Object.keys(patch).length) return { data: inc }
    await patchIncident(inc.id, patch)
    await addEvent(inc.id, 'changed', `Changed ${said.join(', ')}`, userId(req))
    await logActivity({
      action: 'hub-incident-update',
      user: userId(req),
      collection: INCIDENTS,
      item: String(inc.id),
      comment: said.join(', '),
      req
    })
    let after = (await readIncident(inc.id)) as Incident
    // A new tone reaches the app at once.
    if (patch.banner_tone && after.status === 'open') after = await showBanner(after, userId(req))
    return { data: after }
  })

  app.post('/incidents/:id/notes', { preHandler: requireAdmin }, async (req, reply) => {
    const inc = await adminIncident(req)
    if (!inc) return notFound(reply)
    const text = typeof body(req).text === 'string' ? String(body(req).text).trim() : ''
    if (!text || text.length > 2000)
      return fail(reply, 400, 'BAD_NOTE', 'text is 1 to 2000 characters')
    await addEvent(inc.id, 'note', text, userId(req))
    await logActivity({
      action: 'hub-incident-note',
      user: userId(req),
      collection: EVENTS,
      item: String(inc.id),
      comment: text.slice(0, 200),
      req
    })
    return reply.code(201).send({ data: { ok: true } })
  })

  app.put('/incidents/:id/banner', { preHandler: requireAdmin }, async (req, reply) => {
    const inc = await adminIncident(req)
    if (!inc) return notFound(reply)
    if (inc.status !== 'open')
      return fail(reply, 409, 'INCIDENT_RESOLVED', 'The incident is resolved; it has no banner')
    const raw = body(req).text
    if (raw == null || raw === '') {
      await patchIncident(inc.id, { banner_text: null })
      const after = await hideBanner({ ...inc, banner_text: null }, userId(req))
      await logActivity({
        action: 'hub-incident-banner',
        user: userId(req),
        collection: INCIDENTS,
        item: String(inc.id),
        comment: 'removed',
        req
      })
      return { data: after }
    }
    const text = plainBannerText(raw)
    if (!text) return fail(reply, 400, 'BAD_BANNER', 'text is plain text, at most 280 characters')
    await patchIncident(inc.id, { banner_text: text, banner_tone: toneFor(inc.severity) })
    const after = await showBanner(
      { ...inc, banner_text: text, banner_tone: toneFor(inc.severity) },
      userId(req)
    )
    await logActivity({
      action: 'hub-incident-banner',
      user: userId(req),
      collection: INCIDENTS,
      item: String(inc.id),
      comment: text,
      req
    })
    return { data: after }
  })

  app.post('/incidents/:id/freeze', { preHandler: requireAdmin }, async (req, reply) => {
    const inc = await adminIncident(req)
    if (!inc) return notFound(reply)
    if (inc.status !== 'open')
      return fail(reply, 409, 'INCIDENT_RESOLVED', 'The incident is resolved; its freeze is lifted')
    const on = body(req).on === true
    try {
      if (on) await freezeOn(inc.id, userId(req))
      else await freezeOff(inc, userId(req), 'Deploy freeze lifted early by an administrator')
    } catch (err) {
      return refusal(reply, err)
    }
    await logActivity({
      action: on ? 'hub-incident-freeze' : 'hub-incident-unfreeze',
      user: userId(req),
      collection: INCIDENTS,
      item: String(inc.id),
      comment: inc.title,
      req
    })
    const after = (await readIncident(inc.id)) as Incident
    return { data: { ...after, frozen: await freezeActive(after) } }
  })

  app.post('/incidents/:id/acknowledge', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam((req.params as { id?: string }).id)
    const inc = id === null ? null : await readIncident(id)
    if (!inc) return notFound(reply)
    const owner = !!req.isAdmin || (await isAppOwner(inc.app_id, userId(req)))
    try {
      if (inc.page_id != null) await acknowledgePage(inc.page_id, userId(req), owner)
      else if (!owner) return notFound(reply)
      else if (!inc.acknowledged_at) {
        await patchIncident(inc.id, { acknowledged_by: userId(req), acknowledged_at: new Date() })
        await addEvent(inc.id, 'acknowledged', null, userId(req))
      }
    } catch (err) {
      return refusal(reply, err)
    }
    await logActivity({
      action: 'hub-incident-ack',
      user: userId(req),
      collection: INCIDENTS,
      item: String(inc.id),
      req
    })
    return { data: await readIncident(inc.id) }
  })

  app.post('/incidents/:id/resolve', { preHandler: requireAdmin }, async (req, reply) => {
    const inc = await adminIncident(req)
    if (!inc) return notFound(reply)
    const note = typeof body(req).note === 'string' ? String(body(req).note) : null
    try {
      const after = await resolveIncident(inc.id, userId(req), note)
      await logActivity({
        action: 'hub-incident-resolve',
        user: userId(req),
        collection: INCIDENTS,
        item: String(inc.id),
        comment: inc.title,
        req
      })
      return { data: after }
    } catch (err) {
      return refusal(reply, err)
    }
  })

  // ─── Post-mortem ───────────────────────────────────────────────────────────

  app.post('/incidents/:id/postmortem/draft', { preHandler: requireAdmin }, async (req, reply) => {
    const inc = await adminIncident(req)
    if (!inc) return notFound(reply)
    if (inc.postmortem != null && body(req).replace !== true)
      return fail(
        reply,
        409,
        'POSTMORTEM_EXISTS',
        'A post-mortem is already written; send replace: true to draft it again'
      )
    const doc = await draftPostMortem(inc, await listEvents(inc.id))
    await patchIncident(inc.id, {
      postmortem: doc,
      postmortem_by: userId(req),
      postmortem_at: new Date()
    })
    await addEvent(inc.id, 'postmortem', 'Post-mortem drafted from the Hub’s records', userId(req))
    await logActivity({
      action: 'hub-postmortem-draft',
      user: userId(req),
      collection: INCIDENTS,
      item: String(inc.id),
      comment: `${doc.timeline.length} timeline entries`,
      req
    })
    return { data: doc }
  })

  app.put('/incidents/:id/postmortem', { preHandler: requireAdmin }, async (req, reply) => {
    const inc = await adminIncident(req)
    if (!inc) return notFound(reply)
    const doc = normalizePostMortem(body(req).postmortem)
    if ('error' in doc) return fail(reply, 400, 'BAD_POSTMORTEM', doc.error)
    await patchIncident(inc.id, {
      postmortem: doc,
      postmortem_by: userId(req),
      postmortem_at: new Date()
    })
    await logActivity({
      action: 'hub-postmortem-save',
      user: userId(req),
      collection: INCIDENTS,
      item: String(inc.id),
      comment: doc.title,
      req
    })
    return { data: doc }
  })

  app.get('/incidents/:id/postmortem.md', { preHandler: requireAuth }, async (req, reply) => {
    const inc = await readableIncident(req)
    if (!inc) return notFound(reply)
    if (inc.postmortem == null) return fail(reply, 404, 'NO_POSTMORTEM', 'No post-mortem yet')
    const doc = normalizePostMortem(inc.postmortem)
    if ('error' in doc) return fail(reply, 409, 'BAD_POSTMORTEM', doc.error)
    reply.header('Content-Type', 'text/markdown; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="${fileName(inc, 'md')}"`)
    reply.header('Cache-Control', 'no-store')
    return reply.send(postMortemMarkdown(doc, await exportFacts(inc)))
  })

  app.get(
    '/incidents/:id/postmortem.pdf',
    { preHandler: requireAuth, compress: false },
    async (req, reply) => {
      const inc = await readableIncident(req)
      if (!inc) return notFound(reply)
      if (inc.postmortem == null) return fail(reply, 404, 'NO_POSTMORTEM', 'No post-mortem yet')
      const doc = normalizePostMortem(inc.postmortem) as PostMortem | { error: string }
      if ('error' in doc) return fail(reply, 409, 'BAD_POSTMORTEM', doc.error)
      const { htmlToPdf } = await import('../services/pdf-layout.js')
      try {
        const pdf = await htmlToPdf(postMortemHtml(doc, await exportFacts(inc)), {})
        reply.header('Content-Type', 'application/pdf')
        reply.header('Content-Disposition', `attachment; filename="${fileName(inc, 'pdf')}"`)
        reply.header('Cache-Control', 'no-store')
        return reply.send(pdf)
      } catch (err) {
        const e = err as { statusCode?: unknown; code?: unknown }
        if (e?.statusCode === 503)
          return fail(
            reply,
            503,
            String(e.code ?? 'RENDER_UNAVAILABLE'),
            'PDFs cannot be made on this server (no Chromium and no render peer). Download the Markdown instead.'
          )
        throw err
      }
    }
  )

  // ─── On-call ───────────────────────────────────────────────────────────────

  app.get('/on-call', { preHandler: requireAuth }, async (req) => {
    const me = userId(req)
    const owned = req.isAdmin ? null : await ownedAppIds(req)
    const all = await listRotas(null)
    const rotas = all.filter(
      (r) =>
        !owned ||
        owned.includes(r.app_id) ||
        r.people.some((p) => p.toUpperCase() === me.toUpperCase())
    )
    const now = Date.now()
    const out = await Promise.all(
      rotas.map(async (r) => {
        const overrides = await listOverrides(r.app_id, new Date(now - 86_400_000))
        const oc = onCallAt(r, overrides, now)
        return {
          rota: r,
          on_call: oc,
          overrides: overrides.filter((o) => Date.parse(o.ends_at) > now),
          shifts: upcomingShifts(r, overrides, now, 8),
          can_write: !!req.isAdmin
        }
      })
    )
    const pages = await listPages({
      userId: me,
      isAdmin: !!req.isAdmin,
      ownedAppIds: owned ?? [],
      status: 'active',
      limit: 100
    })
    const recent = await listPages({
      userId: me,
      isAdmin: !!req.isAdmin,
      ownedAppIds: owned ?? [],
      limit: 50
    })
    const appIds = [...new Set([...out.map((o) => o.rota.app_id), ...recent.map((p) => p.app_id)])]
    // Apps the caller may set a rota on (admins: every app; others: none).
    const appRows = req.isAdmin
      ? ((await db('nivaro_hub_apps').orderBy('name', 'asc').select('id', 'key', 'name')) as Array<{
          id: number
          key: string
          name: string
        }>)
      : []
    const apps = await appInfo([...new Set([...appIds, ...appRows.map((a) => Number(a.id))])])
    const names = await personNames([
      ...out.flatMap((o) => [...o.rota.people, ...o.overrides.map((x) => x.user_id)]),
      ...recent.flatMap((p) => [p.acknowledged_by, ...p.sent_to.flatMap((s) => s.users)])
    ])
    return {
      data: {
        apps: [...apps.entries()]
          .map(([id, a]) => ({ id, key: a.key, name: a.name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        rotas: out,
        pages: pages.map((p) => ({ ...p, app_name: apps.get(p.app_id)?.name ?? null })),
        recent: recent.map((p) => ({ ...p, app_name: apps.get(p.app_id)?.name ?? null })),
        names: Object.fromEntries(names),
        me,
        now: new Date(now).toISOString()
      }
    }
  })

  // Hub accounts a rota may name: the people directory's Hub accounts plus every admin + owner.
  app.get('/on-call/people', { preHandler: requireAdmin }, async () => {
    const owners = (await db('nivaro_hub_app_owners').distinct('user_id')) as Array<{
      user_id: string
    }>
    const signins = (await db('nivaro_hub_signins')
      .whereNotNull('hub_user_id')
      .distinct('hub_user_id')
      .limit(2000)
      .catch(() => [])) as Array<{ hub_user_id: string }>
    const ids = [
      ...new Set(
        [
          ...(await activeAdminIds()),
          ...owners.map((o) => String(o.user_id)),
          ...signins.map((s) => String(s.hub_user_id))
        ].map((x) => x.toLowerCase())
      )
    ]
    const live = await activeAccounts(ids)
    const rows = (await db('nivaro_users')
      .whereIn('id', ids.filter((i) => live.has(i.toUpperCase())).slice(0, 200))
      .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
    return {
      data: rows
        .map((u) => ({
          id: String(u.id),
          name:
            [u.first_name, u.last_name]
              .filter((x) => typeof x === 'string' && x.trim())
              .join(' ')
              .trim() || String(u.email ?? u.id),
          email: (u.email as string | null) ?? null
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    }
  })

  app.put('/apps/:id/on-call', { preHandler: requireAdmin }, async (req, reply) => {
    const appId = idParam((req.params as { id: string }).id)
    const found = appId === null ? null : await readApp(appId)
    if (!found || appId === null) return notFound(reply)
    const v = validateRota(body(req))
    if ('error' in v) return fail(reply, 400, 'BAD_ROTA', v.error)
    const live = await activeAccounts(v.people)
    const gone = v.people.filter((p) => !live.has(p.toUpperCase()))
    if (gone.length)
      return fail(reply, 400, 'BAD_ROTA', 'Every person on a rota is an active Hub account')
    const row = {
      enabled: v.enabled,
      people: JSON.stringify(v.people),
      time_zone: v.time_zone,
      handover_weekday: v.handover_weekday,
      handover_time: v.handover_time,
      starts_on: v.starts_on,
      escalate_minutes: v.escalate_minutes,
      steps: JSON.stringify(v.steps),
      updated_by: userId(req),
      updated_at: new Date()
    }
    const existing = await readRota(appId)
    if (existing) await db(ROTAS).where({ id: existing.id }).update(row)
    else await insertReturningId(db, ROTAS, { app_id: appId, ...row })
    await logActivity({
      action: 'hub-oncall-rota',
      user: userId(req),
      collection: ROTAS,
      item: String(appId),
      comment: `${found.key}: ${v.people.length} people, ${v.enabled ? 'on' : 'off'}`,
      req
    })
    return { data: await readRota(appId) }
  })

  app.post('/apps/:id/on-call/overrides', { preHandler: requireAdmin }, async (req, reply) => {
    const appId = idParam((req.params as { id: string }).id)
    const found = appId === null ? null : await readApp(appId)
    if (!found || appId === null) return notFound(reply)
    const v = validateOverride(body(req))
    if ('error' in v) return fail(reply, 400, 'BAD_OVERRIDE', v.error)
    if (!(await activeAccounts([v.user_id])).has(v.user_id.toUpperCase()))
      return fail(reply, 400, 'BAD_OVERRIDE', 'user_id is an active Hub account')
    const id = Number(
      await insertReturningId(db, OVERRIDES, {
        app_id: appId,
        user_id: v.user_id,
        starts_at: v.starts_at,
        ends_at: v.ends_at,
        note: v.note,
        created_by: userId(req),
        created_at: new Date()
      })
    )
    await logActivity({
      action: 'hub-oncall-override',
      user: userId(req),
      collection: OVERRIDES,
      item: String(id),
      comment: `${found.key}: ${v.starts_at.toISOString()} → ${v.ends_at.toISOString()}`,
      req
    })
    return reply.code(201).send({ data: { id } })
  })

  app.delete('/on-call/overrides/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null || !(await db(OVERRIDES).where({ id }).first('id'))) return notFound(reply)
    await db(OVERRIDES).where({ id }).del()
    await logActivity({
      action: 'hub-oncall-override-delete',
      user: userId(req),
      collection: OVERRIDES,
      item: String(id),
      req
    })
    return { data: { deleted: true } }
  })

  app.post('/pages/:id/acknowledge', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const page = id === null ? null : await readPage(id)
    if (!page || id === null) return notFound(reply)
    const owner = !!req.isAdmin || (await isAppOwner(page.app_id, userId(req)))
    try {
      const after = await acknowledgePage(id, userId(req), owner)
      await logActivity({
        action: 'hub-page-ack',
        user: userId(req),
        collection: PAGES,
        item: String(id),
        comment: page.subject.slice(0, 200),
        req
      })
      return { data: after }
    } catch (err) {
      return refusal(reply, err)
    }
  })

  // ─── Status pages ──────────────────────────────────────────────────────────

  // Admins: every page (never a token). Anyone else signed in: the internal pages.
  app.get('/status-pages', { preHandler: requireAuth }, async (req) => {
    const pages = await listStatusPages()
    const now = Date.now()
    const visible = req.isAdmin
      ? pages
      : pages.filter((p) => p.audience === 'internal' && !p.revoked_at)
    return {
      data: visible.map((p) => ({
        ...p,
        live: !p.revoked_at && (!p.expires_at || Date.parse(p.expires_at) > now),
        ...(req.isAdmin ? {} : { token_hint: null, created_by: null })
      })),
      can_write: !!req.isAdmin
    }
  })

  app.get('/status-pages/:id/view', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const page = id === null ? null : await readStatusPage(id)
    if (!page || page.revoked_at) return notFound(reply)
    if (!req.isAdmin && page.audience !== 'internal') return notFound(reply)
    return { data: await statusAnswer(page) }
  })

  app.post('/status-pages', { preHandler: requireAdmin }, async (req, reply) => {
    const v = validateStatusPage(body(req))
    if ('error' in v) return fail(reply, 400, 'BAD_STATUS_PAGE', v.error)
    const minted = v.audience === 'public' ? mintToken() : null
    const id = Number(
      await insertReturningId(db, STATUS_PAGES, {
        name: v.name,
        audience: v.audience,
        token_hash: minted?.hash ?? null,
        token_hint: minted?.hint ?? null,
        app_ids: v.app_ids ? JSON.stringify(v.app_ids) : null,
        expires_at: v.expires_at,
        created_by: userId(req),
        created_at: new Date()
      })
    )
    await logActivity({
      action: 'hub-status-page-create',
      user: userId(req),
      collection: STATUS_PAGES,
      item: String(id),
      comment: `${v.name} (${v.audience})`,
      req
    })
    // The token is answered once, here; only its hash is stored.
    return reply
      .code(201)
      .send({ data: { ...(await readStatusPage(id)), token: minted?.token ?? null } })
  })

  app.patch('/status-pages/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const page = id === null ? null : await readStatusPage(id)
    if (!page || id === null) return notFound(reply)
    const b = body(req)
    const v = validateStatusPage({
      name: b.name ?? page.name,
      audience: page.audience,
      app_ids: b.app_ids === undefined ? page.app_ids : b.app_ids
    })
    if ('error' in v) return fail(reply, 400, 'BAD_STATUS_PAGE', v.error)
    await db(STATUS_PAGES)
      .where({ id })
      .update({ name: v.name, app_ids: v.app_ids ? JSON.stringify(v.app_ids) : null })
    await logActivity({
      action: 'hub-status-page-update',
      user: userId(req),
      collection: STATUS_PAGES,
      item: String(id),
      comment: v.name,
      req
    })
    return { data: await readStatusPage(id) }
  })

  app.post('/status-pages/:id/rotate', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const page = id === null ? null : await readStatusPage(id)
    if (!page || id === null) return notFound(reply)
    if (page.audience !== 'public')
      return fail(reply, 409, 'NOT_PUBLIC', 'An internal page has no link to replace')
    const v = validateStatusPage({
      name: page.name,
      audience: 'public',
      expires_in_days: body(req).expires_in_days
    })
    if ('error' in v) return fail(reply, 400, 'BAD_STATUS_PAGE', v.error)
    const minted = mintToken()
    await db(STATUS_PAGES).where({ id }).update({
      token_hash: minted.hash,
      token_hint: minted.hint,
      expires_at: v.expires_at,
      revoked_at: null
    })
    await logActivity({
      action: 'hub-status-page-rotate',
      user: userId(req),
      collection: STATUS_PAGES,
      item: String(id),
      comment: page.name,
      req
    })
    return { data: { ...(await readStatusPage(id)), token: minted.token } }
  })

  app.delete('/status-pages/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const page = id === null ? null : await readStatusPage(id)
    if (!page || id === null) return notFound(reply)
    await db(STATUS_PAGES).where({ id }).del()
    await logActivity({
      action: 'hub-status-page-delete',
      user: userId(req),
      collection: STATUS_PAGES,
      item: String(id),
      comment: page.name,
      req
    })
    return { data: { deleted: true } }
  })
}
