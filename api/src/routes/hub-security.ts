import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { appBox } from '../services/app-state.js'
import { idParam, isAppOwner } from '../services/hub/apps.js'
import { moveOpenRefusal } from '../services/hub/move-open.js'
import { deliverHubNotice, hubEventRecipients } from '../services/hub/notify-events.js'
import { freezeRefusal } from '../services/hub/releases/freeze.js'
import {
  approveBreakGlass,
  BreakGlassError,
  breakGlassTick,
  cancelBreakGlass,
  denyBreakGlass,
  listBreakGlass,
  readBreakGlass,
  requestBreakGlass,
  revokeEarly
} from '../services/hub/security/break-glass.js'
import { buildCompliancePack } from '../services/hub/security/compliance.js'
import {
  cancelReview,
  completeReview,
  decideItems,
  evidenceCsv,
  hubNames,
  listReviews,
  REVIEWS,
  ReviewError,
  readDecisions,
  readReview,
  retryRemovals,
  reviewCounts,
  reviewItems,
  reviewTick,
  startReview
} from '../services/hub/security/reviews.js'
import { onCallIncident } from '../services/hub/security/seams.js'
import {
  loadSecuritySettings,
  nextSettings,
  publicSettings,
  readAppSecurity,
  SettingsError,
  saveAppSecurity,
  saveSecuritySettings
} from '../services/hub/security/settings.js'
import { listCerts, tlsWatchTick } from '../services/hub/security/tls.js'
import {
  lastScan,
  openFindings,
  pinnedImages,
  severityCounts,
  startScan,
  VulnError
} from '../services/hub/security/vuln.js'

/**
 * Nivaro Hub security (enhancements 41–45), mounted under /api/hub by routes/hub.ts (hub mode
 * only). Reads: admins see every app, owners their own (an app they do not own answers 404).
 *
 *   GET  /security/overview                      counts for the Security page
 *   GET  /security/settings  PUT (admin)          scanner endpoint (token masked), break-glass
 *                                                 longest grant, TLS watch switch
 *   GET  /apps/:id/security  PUT (admin)          the app's access review cadence
 *
 * Access reviews (41) — owners and admins:
 *   GET  /access-reviews?app_id=                  reviews, newest first
 *   POST /apps/:id/access-reviews {note?}         start one (202; reads every environment)
 *   GET  /access-reviews/:id                      the review + every account + counts
 *   POST /access-reviews/:id/decisions {items:[{id, decision: keep|remove|pending, note?}]}
 *   POST /access-reviews/:id/complete             all decided → removals through the app's
 *                                                 people suspend route (202)
 *   POST /access-reviews/:id/retry                failed removals again (202)
 *   POST /access-reviews/:id/cancel
 *   GET  /access-reviews/:id/evidence.csv | evidence.pdf
 *
 * Compliance pack (42): GET /apps/:id/compliance-pack?months=12 → zip (owners + admins, logged)
 * Image scan (43): GET /security/vulnerabilities · POST /security/vulnerabilities/scan (admin)
 * TLS / DNS (44): GET /security/certificates · POST /security/certificates/check (admin)
 *
 * Break-glass (45) — requests and decisions ONLY on the person's own browser session (never
 * View-as, an API key, a phone/OAuth token or an MCP call: 403 OWN_SESSION_ONLY):
 *   GET  /break-glass                             requests (admins: all; owners: their apps; and
 *                                                 always the caller's own)
 *   POST /environments/:envId/break-glass {hours, reason, self_approve?}   ask (owner, admin, or
 *                                                 on call during an open incident)
 *   POST /break-glass/:id/approve {note?}         a Hub admin; nobody approves their own request
 *                                                 (except on call during an incident)
 *   POST /break-glass/:id/deny {note?}            a Hub admin
 *   POST /break-glass/:id/cancel                  the requester, while pending
 *   POST /break-glass/:id/revoke                  end it now (a Hub admin, or the requester)
 *
 * Jobs (Hub only, one leader through the cron lease, ticking where cronTicksEnabled()):
 * hub-break-glass (every minute), hub-security-tick (every 30 minutes: access-review resume /
 * schedule / reminders; TLS watch every 6 hours), hub-vuln-scan (04:40 daily, only with a
 * scanner endpoint set).
 */

function fail(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.code(status).send({ error, code })
}

const userId = (req: FastifyRequest) => String(req.user?.id ?? '')
const query = (req: FastifyRequest) => (req.query ?? {}) as Record<string, string | undefined>
const body = (req: FastifyRequest): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {}

/**
 * The person on their own browser session: never View-as / run-as-key, an API key, a static or
 * phone token, an OAuth (connected app) token, an MCP tool call or a machine account.
 */
export function ownSession(req: FastifyRequest): boolean {
  if (req.authMethod !== 'session') return false
  if (req.masqueradeAdminId || req.mcpInner) return false
  const r = req as FastifyRequest & { apiKeyId?: unknown; apiKeySimulatedId?: unknown }
  if (r.apiKeyId != null || r.apiKeySimulatedId != null) return false
  return !(req.user as { account_kind?: string | null } | undefined)?.account_kind
}

const OWN_SESSION =
  'Break-glass requests and decisions are made only by the person, signed in on their own browser session (not View-as, an API key, a phone or a connected app).'

/** App ids the caller may read (null = all, for an admin). */
async function visibleApps(req: FastifyRequest): Promise<number[] | null> {
  if (req.isAdmin) return null
  const rows = (await db('nivaro_hub_app_owners')
    .where({ user_id: userId(req) })
    .select('app_id')) as Array<{ app_id: number }>
  return rows.map((r) => Number(r.app_id))
}

async function mayReadApp(req: FastifyRequest, appId: number): Promise<boolean> {
  if (!(await db('nivaro_hub_apps').where({ id: appId }).first('id'))) return false
  return req.isAdmin === true || (await isAppOwner(appId, userId(req)))
}

export interface EnvLabel {
  environment_id: number
  env_key: string
  app_id: number
  app_key: string
  app_name: string
  position: number
}

/** Every non-archived environment of these apps (null = all), with its app's name. */
async function envDirectory(appIds: number[] | null): Promise<EnvLabel[]> {
  if (appIds && !appIds.length) return []
  const q = db('nivaro_hub_environments as e')
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .whereNot('e.status', 'archived')
    .select(
      'e.id',
      'e.key',
      'e.position',
      'a.id as app_id',
      'a.key as app_key',
      'a.name as app_name'
    )
  if (appIds) q.whereIn('e.app_id', appIds)
  const rows = (await q) as Array<Record<string, unknown>>
  return rows
    .map((r) => ({
      environment_id: Number(r.id),
      env_key: String(r.key),
      app_id: Number(r.app_id),
      app_key: String(r.app_key),
      app_name: String(r.app_name || r.app_key),
      position: Number(r.position ?? 0)
    }))
    .sort((a, b) => a.app_name.localeCompare(b.app_name) || a.position - b.position)
}

/** The apps of an environment list, each once, in its order. */
function appsOf(envs: EnvLabel[]): Array<{ id: number; key: string; name: string }> {
  const out: Array<{ id: number; key: string; name: string }> = []
  for (const e of envs)
    if (!out.some((a) => a.id === e.app_id))
      out.push({ id: e.app_id, key: e.app_key, name: e.app_name })
  return out
}

async function envIdsOf(appIds: number[] | null): Promise<number[] | null> {
  if (!appIds) return null
  if (!appIds.length) return []
  const rows = (await db('nivaro_hub_environments')
    .whereIn('app_id', appIds)
    .select('id')) as Array<{ id: unknown }>
  return rows.map((r) => Number(r.id))
}

function refusal(reply: FastifyReply, err: unknown) {
  if (err instanceof ReviewError || err instanceof BreakGlassError || err instanceof VulnError)
    return fail(reply, err.status, err.code, err.message)
  if (err instanceof SettingsError) return fail(reply, 400, err.code, err.message)
  const code = (err as { code?: unknown } | null)?.code
  const status = (err as { statusCode?: unknown } | null)?.statusCode
  if (code === 'EMAIL_OFFBOARDED')
    return fail(reply, 409, 'EMAIL_OFFBOARDED', 'This account was offboarded.')
  if (typeof status === 'number' && status >= 400 && status < 500 && typeof code === 'string')
    return fail(reply, status, code, (err as Error).message)
  throw err
}

async function reviewNotify(appId: number, subject: string, message: string, reviewId: number) {
  const people = await hubEventRecipients(appId)
  await deliverHubNotice(people, {
    subject,
    message,
    path: `/hub/access?review=${reviewId}`,
    action: 'review',
    source: { kind: 'hub_access_review', label: 'Access review', id: reviewId },
    why: 'You are a Hub administrator or an owner of this app; its access is reviewed regularly.'
  })
}

/** The last scan as this caller may see it: admins whole; owners only their own images' rows. */
async function scanFor(req: FastifyRequest, mine: string[]) {
  const last = await lastScan()
  if (!last || req.isAdmin) return last
  const own = new Set(mine)
  const result = Array.isArray(last.result)
    ? (last.result as Array<{ image?: unknown }>).filter((r) => own.has(String(r.image)))
    : []
  return {
    id: last.id,
    status: last.status,
    started_at: last.started_at,
    finished_at: last.finished_at,
    images: result.length,
    findings: null,
    error: null,
    result
  }
}

/** Task 34: the registrar domain watch, beside the TLS one (never throws). */
async function domainTick(): Promise<{ checked: number; warned: number }> {
  try {
    const { domainWatchTick } = await import('../services/hub/providers/domains.js')
    return await domainWatchTick()
  } catch {
    return { checked: 0, warned: 0 }
  }
}

/** When the last manual certificate check started (this process; Hub mode is one app). */
const tlsCheck = appBox<number>(() => 0)
const TLS_EVERY_MS = 6 * 3_600_000
const tlsLast = appBox<number>(() => 0)

export function hubSecurityRoutes(app: FastifyInstance) {
  // ─── Overview + settings ───────────────────────────────────────────────────────────────
  app.get('/security/overview', { preHandler: requireAuth }, async (req) => {
    const apps = await visibleApps(req)
    const envIds = await envIdsOf(apps)
    const reviews = await listReviews({ appIds: apps, limit: 200 })
    const grants = await listBreakGlass({ appIds: apps, requesterId: userId(req), limit: 200 })
    const certs = await listCerts(envIds)
    const images = (await pinnedImages()).filter(
      (i) => !envIds || i.environment_ids.some((e) => envIds.includes(e))
    )
    const findings = await openFindings(images.map((i) => i.digest))
    const settings = await loadSecuritySettings()
    return {
      data: {
        reviews: {
          open: reviews.filter((r) => ['reading', 'open', 'completing'].includes(r.status)).length,
          overdue: reviews.filter(
            (r) => r.status === 'open' && r.due_at && Date.parse(r.due_at) < Date.now()
          ).length
        },
        break_glass: {
          pending: grants.filter((g) => g.status === 'pending').length,
          active: grants.filter((g) => g.status === 'active' || g.status === 'granting').length
        },
        certificates: {
          total: certs.length,
          warning: certs.filter((c) => c.state === 'warning').length,
          expired: certs.filter((c) => c.state === 'expired').length,
          error: certs.filter((c) => c.state === 'error').length
        },
        vulnerabilities: { images: images.length, ...severityCounts(findings) },
        scanner: !!settings.scanner_url,
        last_scan: req.isAdmin ? await lastScan() : null
      }
    }
  })

  app.get('/security/settings', { preHandler: requireAdmin }, async () => ({
    data: publicSettings(await loadSecuritySettings())
  }))

  app.put('/security/settings', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const next = nextSettings(req.body, await loadSecuritySettings())
      await saveSecuritySettings(next)
      await logActivity({
        action: 'hub-security-settings',
        user: userId(req),
        comment: `Security settings saved (scanner ${next.scanner_url ? 'set' : 'off'}, longest break-glass ${next.break_glass_max_hours} h, TLS watch ${next.tls_watch ? 'on' : 'off'})`,
        req
      })
      return { data: publicSettings(next) }
    } catch (err) {
      return refusal(reply, err)
    }
  })

  app.get<{ Params: { id: string } }>(
    '/apps/:id/security',
    { preHandler: requireAuth },
    async (req, reply) => {
      const id = idParam(req.params.id)
      if (id == null || !(await mayReadApp(req, id)))
        return fail(reply, 404, 'NOT_FOUND', 'No such app')
      return { data: await readAppSecurity(id) }
    }
  )

  app.put<{ Params: { id: string } }>(
    '/apps/:id/security',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = idParam(req.params.id)
      if (id == null || !(await db('nivaro_hub_apps').where({ id }).first('id')))
        return fail(reply, 404, 'NOT_FOUND', 'No such app')
      try {
        const out = await saveAppSecurity(id, req.body, userId(req))
        await logActivity({
          action: 'hub-access-review-cadence',
          user: userId(req),
          collection: 'nivaro_hub_apps',
          item: String(id),
          comment: out.review_every_months
            ? `Access review every ${out.review_every_months} month(s), ${out.review_due_days} days to finish`
            : 'Scheduled access reviews off',
          req
        })
        return { data: out }
      } catch (err) {
        return refusal(reply, err)
      }
    }
  )

  // ─── Access reviews ────────────────────────────────────────────────────────────────────
  app.get('/access-reviews', { preHandler: requireAuth }, async (req, reply) => {
    const apps = await visibleApps(req)
    const only = query(req).app_id ? idParam(query(req).app_id) : null
    if (query(req).app_id && only == null) return fail(reply, 400, 'BAD_APP', 'app_id is an id')
    const scope = only == null ? apps : apps && !apps.includes(only) ? [] : [only]
    const reviews = await listReviews({ appIds: scope, limit: 100 })
    const counts = await Promise.all(
      reviews.map(async (r) => reviewCounts(await reviewItems(r.id)))
    )
    return {
      data: reviews.map((r, i) => ({ ...r, counts: counts[i] })),
      apps: appsOf(await envDirectory(apps))
    }
  })

  app.post<{ Params: { id: string } }>(
    '/apps/:id/access-reviews',
    { preHandler: requireAuth },
    async (req, reply) => {
      const id = idParam(req.params.id)
      if (id == null || !(await mayReadApp(req, id)))
        return fail(reply, 404, 'NOT_FOUND', 'No such app')
      try {
        const note = typeof body(req).note === 'string' ? String(body(req).note) : null
        const r = await startReview(
          id,
          { by: userId(req), via: 'person', note },
          {
            notify: reviewNotify
          }
        )
        await logActivity({
          action: 'hub-access-review-start',
          user: userId(req),
          collection: REVIEWS,
          item: String(r.id),
          comment: `Access review of app ${id} started`,
          req
        })
        return reply.code(202).send({ data: r })
      } catch (err) {
        return refusal(reply, err)
      }
    }
  )

  const reviewFor = async (req: FastifyRequest, reply: FastifyReply, raw: string) => {
    const id = idParam(raw)
    const r = id == null ? null : await readReview(id)
    if (!r || !(await mayReadApp(req, r.app_id))) {
      fail(reply, 404, 'NOT_FOUND', 'No such access review')
      return null
    }
    return r
  }

  app.get<{ Params: { id: string } }>(
    '/access-reviews/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const r = await reviewFor(req, reply, req.params.id)
      if (!r) return reply
      const items = await reviewItems(r.id)
      const people = await hubNames([
        r.started_by,
        r.completed_by,
        ...items.map((i) => i.decided_by)
      ])
      return {
        data: {
          ...r,
          items,
          counts: reviewCounts(items),
          people: Object.fromEntries(people),
          app_name: (await envDirectory([r.app_id]))[0]?.app_name ?? null
        }
      }
    }
  )

  app.post<{ Params: { id: string } }>(
    '/access-reviews/:id/decisions',
    { preHandler: requireAuth },
    async (req, reply) => {
      const r = await reviewFor(req, reply, req.params.id)
      if (!r) return reply
      const decisions = readDecisions(req.body)
      if (!decisions)
        return fail(
          reply,
          400,
          'BAD_DECISIONS',
          'items: 1–1000 of {id, decision: keep | remove | pending, note?}'
        )
      try {
        const n = await decideItems(r.id, decisions, userId(req))
        const removes = decisions.filter((d) => d.decision === 'remove').length
        await logActivity({
          action: 'hub-access-review-decide',
          user: userId(req),
          collection: REVIEWS,
          item: String(r.id),
          comment: `${n} decision(s) (${removes} remove)`,
          req
        })
        const items = await reviewItems(r.id)
        return { data: { changed: n, counts: reviewCounts(items) } }
      } catch (err) {
        return refusal(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string } }>(
    '/access-reviews/:id/complete',
    { preHandler: requireAuth },
    async (req, reply) => {
      const r = await reviewFor(req, reply, req.params.id)
      if (!r) return reply
      const envIds = r.environments.map((e) => e.environment_id)
      const moving = await moveOpenRefusal({ envIds })
      if (moving) return fail(reply, 409, moving.code, moving.message)
      const frozen = await freezeRefusal({ appIds: [r.app_id], action: 'access_change' })
      if (frozen) return fail(reply, frozen.status, frozen.code, frozen.message)
      try {
        const out = await completeReview(r.id, userId(req))
        await logActivity({
          action: 'hub-access-review-complete',
          user: userId(req),
          collection: REVIEWS,
          item: String(r.id),
          comment: `Access review ${r.id} completed; removals started`,
          req
        })
        return reply.code(202).send({ data: out })
      } catch (err) {
        return refusal(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string } }>(
    '/access-reviews/:id/retry',
    { preHandler: requireAuth },
    async (req, reply) => {
      const r = await reviewFor(req, reply, req.params.id)
      if (!r) return reply
      const frozen = await freezeRefusal({ appIds: [r.app_id], action: 'access_change' })
      if (frozen) return fail(reply, frozen.status, frozen.code, frozen.message)
      try {
        const out = await retryRemovals(r.id)
        await logActivity({
          action: 'hub-access-review-retry',
          user: userId(req),
          collection: REVIEWS,
          item: String(r.id),
          comment: 'Failed removals tried again',
          req
        })
        return reply.code(202).send({ data: out })
      } catch (err) {
        return refusal(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string } }>(
    '/access-reviews/:id/cancel',
    { preHandler: requireAuth },
    async (req, reply) => {
      const r = await reviewFor(req, reply, req.params.id)
      if (!r) return reply
      try {
        await cancelReview(r.id)
        await logActivity({
          action: 'hub-access-review-cancel',
          user: userId(req),
          collection: REVIEWS,
          item: String(r.id),
          comment: 'Access review cancelled',
          req
        })
        return { data: await readReview(r.id) }
      } catch (err) {
        return refusal(reply, err)
      }
    }
  )

  const evidence = async (req: FastifyRequest, raw: string, reply: FastifyReply) => {
    const r = await reviewFor(req, reply, raw)
    if (!r) return null
    const items = await reviewItems(r.id)
    const people = await hubNames([r.started_by, r.completed_by, ...items.map((i) => i.decided_by)])
    const appRow = (await db('nivaro_hub_apps').where({ id: r.app_id }).first('key', 'name')) as
      | { key: string; name: string }
      | undefined
    await logActivity({
      action: 'hub-access-review-evidence',
      user: userId(req),
      collection: REVIEWS,
      item: String(r.id),
      comment: 'Evidence downloaded',
      req
    })
    return {
      r,
      items,
      people,
      appName: appRow?.name || appRow?.key || `app ${r.app_id}`,
      key: appRow?.key ?? String(r.app_id)
    }
  }

  app.get<{ Params: { id: string } }>(
    '/access-reviews/:id/evidence.csv',
    { preHandler: requireAuth },
    async (req, reply) => {
      const e = await evidence(req, req.params.id, reply)
      if (!e) return reply
      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header(
        'Content-Disposition',
        `attachment; filename="access-review-${e.key}-${e.r.id}.csv"`
      )
      reply.header('Cache-Control', 'no-store')
      return reply.send(evidenceCsv(e.r, e.appName, e.items, e.people))
    }
  )

  app.get<{ Params: { id: string } }>(
    '/access-reviews/:id/evidence.pdf',
    { preHandler: requireAuth },
    async (req, reply) => {
      const e = await evidence(req, req.params.id, reply)
      if (!e) return reply
      const { summaryHtml } = await import('../services/hub/security/compliance.js')
      const c = reviewCounts(e.items)
      const lines = e.items
        .filter((i) => i.admin || i.decision === 'remove')
        .slice(0, 400)
        .map(
          (i) =>
            `${i.name ?? i.email ?? i.app_user_id} — ${i.role ?? 'no role'}${i.admin ? ' (admin)' : ''}: ${i.decision}${i.decided_by ? ` by ${e.people.get(i.decided_by.toUpperCase()) ?? i.decided_by}` : ''}${i.removal_state ? ` · removal ${i.removal_state}` : ''}`
        )
      const html = summaryHtml(
        `${e.appName} — access review ${e.r.id}`,
        new Date(),
        new Date(e.r.started_at ?? Date.now()),
        [
          {
            title: 'Summary',
            rows: c.total,
            lines: [
              `Status ${e.r.status}; started ${e.r.started_at ?? '?'}${e.r.completed_at ? `, completed ${e.r.completed_at} by ${e.people.get(String(e.r.completed_by).toUpperCase()) ?? 'an owner'}` : ''}.`,
              `${c.total} account(s): ${c.admins} administrator(s); ${c.keep} kept, ${c.remove} to remove, ${c.removed} removed, ${c.pending} undecided.`,
              ...e.r.environments.map(
                (x) =>
                  `${x.environment_key}${x.production ? ' (production)' : ''}: ${x.state === 'read' ? `${x.count} account(s)` : `not read (${x.code ?? x.state})`}`
              )
            ]
          },
          {
            title: 'Administrators and removals',
            rows: lines.length,
            lines: lines.length ? lines : ['None.']
          }
        ]
      )
      try {
        const { htmlToPdf } = await import('../services/pdf-layout.js')
        const pdf = await htmlToPdf(html, { format: 'A4' })
        reply.header('Content-Type', 'application/pdf')
        reply.header(
          'Content-Disposition',
          `attachment; filename="access-review-${e.key}-${e.r.id}.pdf"`
        )
        reply.header('Cache-Control', 'no-store')
        return reply.send(pdf)
      } catch {
        return fail(
          reply,
          503,
          'RENDER_UNAVAILABLE',
          'This Hub cannot make PDFs (no Chromium and no render peer): download the CSV.'
        )
      }
    }
  )

  // ─── Compliance pack ───────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/apps/:id/compliance-pack',
    { preHandler: requireAuth, compress: false },
    async (req, reply) => {
      const id = idParam(req.params.id)
      if (id == null || !(await mayReadApp(req, id)))
        return fail(reply, 404, 'NOT_FOUND', 'No such app')
      const m = Number(query(req).months ?? 12)
      if (!Number.isInteger(m) || m < 1 || m > 36)
        return fail(reply, 400, 'BAD_MONTHS', 'months is 1 to 36')
      let pack: Awaited<ReturnType<typeof buildCompliancePack>>
      try {
        pack = await buildCompliancePack(id, m)
      } catch (err) {
        if ((err as { code?: unknown }).code === 'PACK_TOO_BIG')
          return fail(reply, 413, 'PACK_TOO_BIG', (err as Error).message)
        throw err
      }
      await logActivity({
        action: 'hub-compliance-pack',
        user: userId(req),
        collection: 'nivaro_hub_apps',
        item: String(id),
        comment: `Compliance pack downloaded (${m} months${pack.pdf ? '' : ', HTML summary: no PDF renderer'})`,
        req
      })
      reply.header('Content-Type', 'application/zip')
      reply.header('Content-Disposition', `attachment; filename="${pack.filename}"`)
      reply.header('Cache-Control', 'no-store')
      // Streamed piece by piece (each file, then the directory): no second whole copy.
      return reply.send(Readable.from(pack.parts))
    }
  )

  // ─── Image vulnerabilities ─────────────────────────────────────────────────────────────
  app.get('/security/vulnerabilities', { preHandler: requireAuth }, async (req) => {
    const envIds = await envIdsOf(await visibleApps(req))
    const images = (await pinnedImages())
      .map((i) => ({
        ...i,
        environment_ids: envIds
          ? i.environment_ids.filter((e) => envIds.includes(e))
          : i.environment_ids
      }))
      .filter((i) => i.environment_ids.length)
    const findings = await openFindings(images.map((i) => i.digest))
    const settings = await loadSecuritySettings()
    return {
      data: {
        scanner: !!settings.scanner_url,
        environments: await envDirectory(await visibleApps(req)),
        // Owners: when the last scan ran, never which images of other apps it covered.
        last_scan: await scanFor(
          req,
          images.map((i) => i.image)
        ),
        images: images.map((i) => {
          const mine = findings.filter((f) => f.digest === i.digest)
          return { ...i, counts: severityCounts(mine) }
        }),
        findings
      }
    }
  })

  app.post('/security/vulnerabilities/scan', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const id = await startScan({ by: userId(req), via: 'person' })
      await logActivity({
        action: 'hub-vuln-scan',
        user: userId(req),
        collection: 'nivaro_hub_vuln_scans',
        item: String(id),
        comment: 'Image scan started',
        req
      })
      return reply.code(202).send({ data: { scan_id: id } })
    } catch (err) {
      return refusal(reply, err)
    }
  })

  // ─── Certificates / DNS ────────────────────────────────────────────────────────────────
  app.get('/security/certificates', { preHandler: requireAuth }, async (req) => {
    const envIds = await envIdsOf(await visibleApps(req))
    return {
      data: {
        // Resolved addresses are internal detail: Hub admins only.
        certificates: (await listCerts(envIds)).map((c) =>
          req.isAdmin ? c : { ...c, addresses: null, subject: null }
        ),
        // Task 34: registrar domains the Hub manages (expiry, auto-renew, transfer lock).
        domains: await (await import('../services/hub/providers/domains.js')).listDomains(
          await visibleApps(req)
        ),
        environments: await envDirectory(await visibleApps(req)),
        running: tlsCheck.value > Date.now() - 10 * 60_000
      }
    }
  })

  app.post('/security/certificates/check', { preHandler: requireAdmin }, async (req, reply) => {
    if (tlsCheck.value > Date.now() - 10 * 60_000)
      return fail(reply, 409, 'CHECK_RUNNING', 'A certificate check is already running.')
    tlsCheck.value = Date.now()
    await logActivity({ action: 'hub-tls-check', user: userId(req), req })
    void tlsWatchTick()
      .catch(() => undefined)
      .then(() => domainTick())
      .finally(() => {
        tlsCheck.value = 0
        tlsLast.value = Date.now()
      })
    return reply.code(202).send({ data: { status: 'running' } })
  })

  // ─── Break-glass ───────────────────────────────────────────────────────────────────────
  app.get('/break-glass', { preHandler: requireAuth }, async (req) => {
    const apps = await visibleApps(req)
    const rows = await listBreakGlass({ appIds: apps, requesterId: userId(req), limit: 200 })
    const people = await hubNames(rows.flatMap((r) => [r.requester_id, r.decided_by, r.revoked_by]))
    // Where the caller may ask: their apps (admins: every app).
    const requestable = await envDirectory(apps)
    const known = new Set(requestable.map((e) => e.environment_id))
    const extra = rows.filter((r) => !known.has(r.environment_id)).map((r) => r.app_id)
    const environments = [
      ...requestable,
      ...(extra.length ? await envDirectory([...new Set(extra)]) : [])
    ]
    const settings = await loadSecuritySettings()
    return {
      data: {
        requests: rows,
        people: Object.fromEntries(people),
        environments,
        requestable: requestable.map((e) => e.environment_id),
        max_hours: settings.break_glass_max_hours
      }
    }
  })

  app.post<{ Params: { envId: string } }>(
    '/environments/:envId/break-glass',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!ownSession(req)) return fail(reply, 403, 'OWN_SESSION_ONLY', OWN_SESSION)
      const envId = idParam(req.params.envId)
      const env =
        envId == null
          ? null
          : ((await db('nivaro_hub_environments').where({ id: envId }).first('id', 'app_id')) as
              | { id: unknown; app_id: unknown }
              | undefined)
      if (!env) return fail(reply, 404, 'NOT_FOUND', 'No such environment')
      const appId = Number(env.app_id)
      const may = req.isAdmin === true || (await isAppOwner(appId, userId(req)))
      try {
        const b = body(req)
        const row = await requestBreakGlass({
          appId,
          envId: Number(env.id),
          requesterId: userId(req),
          hours: b.hours,
          reason: b.reason,
          mayRequest: may,
          selfApprove: b.self_approve === true
        })
        return reply.code(201).send({ data: row })
      } catch (err) {
        return refusal(reply, err)
      }
    }
  )

  const grantFor = async (req: FastifyRequest, reply: FastifyReply, raw: string) => {
    const id = idParam(raw)
    const row = id == null ? null : await readBreakGlass(id)
    const mine = !!row && row.requester_id.toUpperCase() === userId(req).toUpperCase()
    if (!row || !(mine || (await mayReadApp(req, row.app_id)))) {
      fail(reply, 404, 'NOT_FOUND', 'No such request')
      return null
    }
    return { row, mine }
  }

  app.post<{ Params: { id: string } }>(
    '/break-glass/:id/approve',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!ownSession(req)) return fail(reply, 403, 'OWN_SESSION_ONLY', OWN_SESSION)
      const g = await grantFor(req, reply, req.params.id)
      if (!g) return reply
      // A Hub admin approves; the requester only through the incident seam (checked inside).
      if (!req.isAdmin && !g.mine)
        return fail(reply, 403, 'ADMIN_ONLY', 'A Hub administrator approves.')
      if (g.mine && !(await onCallIncident(g.row.app_id, userId(req))))
        return fail(
          reply,
          403,
          'SELF_APPROVAL',
          'Nobody approves their own request (only the person on call, during an open incident).'
        )
      try {
        const note = typeof body(req).note === 'string' ? String(body(req).note) : null
        return { data: await approveBreakGlass(g.row.id, userId(req), { note }) }
      } catch (err) {
        return refusal(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string } }>(
    '/break-glass/:id/deny',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!ownSession(req)) return fail(reply, 403, 'OWN_SESSION_ONLY', OWN_SESSION)
      const g = await grantFor(req, reply, req.params.id)
      if (!g) return reply
      try {
        const note = typeof body(req).note === 'string' ? String(body(req).note) : null
        return { data: await denyBreakGlass(g.row.id, userId(req), note) }
      } catch (err) {
        return refusal(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string } }>(
    '/break-glass/:id/cancel',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!ownSession(req)) return fail(reply, 403, 'OWN_SESSION_ONLY', OWN_SESSION)
      const g = await grantFor(req, reply, req.params.id)
      if (!g) return reply
      try {
        return { data: await cancelBreakGlass(g.row.id, userId(req)) }
      } catch (err) {
        return refusal(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string } }>(
    '/break-glass/:id/revoke',
    { preHandler: requireAuth },
    async (req, reply) => {
      const g = await grantFor(req, reply, req.params.id)
      if (!g) return reply
      // Ending access early is always safe: a Hub admin (any credential the Hub gate lets
      // write), or the requester on their own session.
      if (!req.isAdmin && !(g.mine && ownSession(req)))
        return fail(reply, 403, 'ADMIN_ONLY', 'A Hub administrator, or the requester, ends it.')
      try {
        return { data: await revokeEarly(g.row.id, userId(req)) }
      } catch (err) {
        return refusal(reply, err)
      }
    }
  )

  // ─── Jobs ──────────────────────────────────────────────────────────────────────────────
  if (app.cron) {
    app.cron.schedule(
      'hub-break-glass',
      '* * * * *',
      async () => {
        const r = await breakGlassTick()
        if (r.revoked.length || r.retried.length || r.withdrawn.length)
          app.log.info(
            `hub-break-glass: ${r.revoked.length} ended, ${r.retried.length} retried, ${r.withdrawn.length} withdrawn`
          )
      },
      {
        quiet: true,
        idempotent: 'safe',
        description:
          'Every minute (Hub only) — ends break-glass grants whose time ran out (over the hub link; the app ends them by itself too), retries grants and revokes, withdraws requests nobody decided within 24 hours.'
      }
    )
    app.cron.schedule(
      'hub-security-tick',
      '*/30 * * * *',
      async () => {
        const r = await reviewTick({ notify: reviewNotify })
        let tls = { checked: 0, warned: 0 }
        if (
          (await loadSecuritySettings()).tls_watch &&
          Date.now() - tlsLast.value > TLS_EVERY_MS - 60_000
        ) {
          tlsLast.value = Date.now()
          tls = await tlsWatchTick()
          const d = await domainTick()
          tls = { checked: tls.checked + d.checked, warned: tls.warned + d.warned }
        }
        if (r.resumed.length || r.started.length || r.reminded.length || tls.warned)
          app.log.info(
            `hub-security-tick: reviews ${r.started.length} started, ${r.resumed.length} resumed, ${r.reminded.length} reminded; ${tls.checked} names checked, ${tls.warned} warnings`
          )
      },
      {
        quiet: true,
        idempotent: 'safe',
        description:
          'Every 30 minutes (Hub only) — starts the access reviews each app’s cadence makes due, resumes review runs whose process stopped, reminds owners of overdue reviews; every 6 hours checks certificate expiry and DNS of every environment name, and the expiry of every registrar domain the Hub manages (nivaro_hub_domain_checks).'
      }
    )
    app.cron.schedule(
      'hub-vuln-scan',
      '40 4 * * *',
      async () => {
        const settings = await loadSecuritySettings()
        if (!settings.scanner_url) return
        try {
          await startScan({ by: null, via: 'schedule' }, { background: false })
        } catch {
          // A scan already running, or the scanner unset meanwhile.
        }
      },
      {
        quiet: true,
        idempotent: 'safe',
        description:
          'Daily 04:40 (Hub only, only with a scanner endpoint set) — sends every pinned Nivaro and extension image digest to the scanner and keeps its known vulnerabilities.'
      }
    )
  }
}
