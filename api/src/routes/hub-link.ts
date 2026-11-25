import type { FastifyInstance, FastifyReply } from 'fastify'
import { config } from '../config.js'
import { failedAuthLimiter } from '../lib/auth-fail-limiter.js'
import { isMultiTenant } from '../services/deployment-mode.js'
import { hubLinkToken } from '../services/hub/mode.js'
import { seedFirstAdmin } from '../services/hub-link/first-admin.js'
import { recentMinutesParam } from '../services/hub-link/release-params.js'
import { isRetiredSync, setRetired } from '../services/hub-link/retire.js'
import { instanceKey } from '../services/instance-key.js'
import { poolCounters } from '../services/pool-attribution.js'
import { readReadiness } from '../services/readiness.js'
import { bearerMatches } from '../services/render-peer.js'
import { NIVARO_VERSION } from '../version.js'
import { hubLinkDataRoutes } from './hub-link-data.js'
import { hubLinkTemplateRoute } from './hub-link-template.js'
import { runPreflight } from './preflight.js'

/**
 * Hub link (app side) — what a Nivaro Hub may read about this install.
 *
 *   GET /api/hub-link/status → { version, environment, instance,
 *                                preflight: { status, failing }, readiness_score,
 *                                open_issues (0.3.215+: issue-log rows open or in progress),
 *                                maintenance, retired,
 *                                process: { uptime_s, memory_mb, pool },
 *                                recent?, release_facts? }
 *   ?recent_minutes=N (1–60) adds `recent` {minutes, requests, errors_5xx, crashes} and
 *   ?release_facts=1 adds `release_facts` {migrations, env_keys} (Hub release operations).
 *
 * Phase 6 (moves): POST /maintenance (strict), POST + DELETE /retire, GET /shared-readiness —
 * see each route below.
 *
 * Mounted only where HUB_TOKEN (at least 32 characters) is set, never in cloud mode. Every
 * request needs `Authorization: Bearer <HUB_TOKEN>` (timing-safe; 401 HUB_LINK_REFUSED, 429
 * after 20 failures a minute from one address). Health figures only, never business data and
 * never a check's detail (hosts, database names): failing preflight checks are named by id. The
 * readiness score is the CACHED scorecard (never a live run); the preflight is reused for
 * PREFLIGHT_REUSE_MS so a Hub polling every few seconds costs one run. Both are waited for at
 * most ~4 s (preflight `timeout`, score null past it), so the answer always beats the Hub's 8 s.
 * /status is a GET (never frozen by maintenance); POST /first-admin is a write: the freeze applies.
 * The phase-6 writes are exempt from the freeze and from the retire gate (the Hub lifts both).
 */

export const HUB_LINK_REFUSED = 'HUB_LINK_REFUSED'
const PREFLIGHT_REUSE_MS = 15_000

interface PreflightSummary {
  status: string
  failing: string[]
}

/** How long the route waits for the preflight and the readiness score (in parallel): well inside
 *  the Hub's 8 s, so a sick app (pool exhausted, Redis down) reads as degraded, not unreachable. */
let boundMs = 4_000
/** A preflight run older than this is treated as hung: the next request starts a fresh one. */
let flightStaleMs = 30_000

let lastPreflight: { at: number; value: PreflightSummary } | null = null
let preflightFlight: { started: number; promise: Promise<PreflightSummary> } | null = null

export function _resetHubLinkForTests(opts: { boundMs?: number; staleMs?: number } = {}): void {
  lastPreflight = null
  preflightFlight = null
  boundMs = opts.boundMs ?? 4_000
  flightStaleMs = opts.staleMs ?? 30_000
}

const TIMED_OUT = Symbol('timed-out')

/** `p`, or TIMED_OUT after `ms`. The work behind `p` goes on; nobody waits for it here. */
function bounded<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

function startPreflight(app: FastifyInstance): Promise<PreflightSummary> {
  const flight = {
    started: Date.now(),
    promise: Promise.resolve()
      .then(() => runPreflight(app))
      .then(({ status, checks }) => {
        const value = {
          status,
          failing: checks.filter((c) => c.status === 'fail').map((c) => c.id)
        }
        lastPreflight = { at: Date.now(), value }
        return value
      })
      .catch(() => ({ status: 'unknown', failing: [] as string[] }))
      .finally(() => {
        if (preflightFlight === flight) preflightFlight = null
      })
  }
  preflightFlight = flight
  return flight.promise
}

async function preflightSummary(app: FastifyInstance): Promise<PreflightSummary> {
  if (lastPreflight && Date.now() - lastPreflight.at < PREFLIGHT_REUSE_MS) {
    return lastPreflight.value
  }
  // Join the run in flight unless it has hung; a hung one is let go (it clears nothing later:
  // its finally only clears its own slot).
  const flying =
    preflightFlight && Date.now() - preflightFlight.started < flightStaleMs
      ? preflightFlight.promise
      : startPreflight(app)
  const v = await bounded(flying, boundMs)
  return v === TIMED_OUT ? { status: 'timeout', failing: [] } : v
}

async function readinessScore(): Promise<number | null> {
  try {
    const report = await bounded(readReadiness(), boundMs)
    if (report === TIMED_OUT) return null
    return typeof report.score === 'number' ? report.score : null
  } catch {
    return null
  }
}

/** Open + in-progress issue-log rows (a count only, never a title); null past the bound or on
 *  a read error. The Hub's fleet page shows it (services/hub/fleet). */
async function openIssueCount(): Promise<number | null> {
  try {
    const { db } = await import('../db/index.js')
    const read = db('nivaro_issues')
      .whereIn('status', ['open', 'in_progress'])
      .count<Array<{ n: number | string }>>({ n: '*' })
      .then((rows) => Number(rows[0]?.n ?? 0))
    const n = await bounded(read, boundMs)
    return n === TIMED_OUT || !Number.isFinite(n) ? null : n
  } catch {
    return null
  }
}

function poolFigures(): { used: number; free: number; pending: number } | null {
  try {
    const p = poolCounters('main')
    return p ? { used: p.used, free: p.free, pending: p.pending_acquires } : null
  } catch {
    return null
  }
}

async function maintenanceOn(): Promise<boolean | null> {
  try {
    const { maintenanceState } = await import('../services/security.js')
    const m = await bounded(maintenanceState(), boundMs)
    return m === TIMED_OUT ? null : m.on
  } catch {
    return null
  }
}

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ statusCode: status, error: message, message, code })
}

/** A positive integer id (a move id), or null. */
function positiveId(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null
}

function refuse(reply: FastifyReply, status: number, message: string) {
  return reply
    .code(status)
    .send({ statusCode: status, error: message, message, code: HUB_LINK_REFUSED })
}

export async function hubLinkRoutes(app: FastifyInstance) {
  const token = hubLinkToken()
  if (!token) return
  if (isMultiTenant()) {
    app.log.warn(
      'HUB_TOKEN is set on a deployment that serves many apps (Nivaro Cloud or a Hub shared deployment): hub link routes not mounted'
    )
    return
  }

  const authFails = failedAuthLimiter()
  app.addHook('onRequest', async (req, reply) => {
    if (authFails.blocked(req.ip)) return refuse(reply, 429, 'Too many attempts')
    if (!bearerMatches(req.headers.authorization, token)) {
      if (authFails.fail(req.ip))
        app.log.warn({ ip: req.ip }, 'hub link: wrong or missing HUB_TOKEN')
      return refuse(reply, 401, 'Unauthorized')
    }
  })

  // Hub data care (0.3.215): /data/* — refresh keeps and files backups (routes/hub-link-data.ts).
  hubLinkDataRoutes(app)

  app.get('/status', async (req, reply) => {
    // Hub release operations: ?recent_minutes=N (aggregate counts) and ?release_facts=1 (build
    // facts), each only when asked and bounded like the rest (services/hub-link/release-figures).
    const q = (req.query ?? {}) as Record<string, unknown>
    const minutes = recentMinutesParam(q.recent_minutes)
    const wantFacts = q.release_facts === '1'
    // Imported only when asked (once): the request-log reader pulls the database module in.
    const extras = minutes || wantFacts ? import('../services/hub-link/release-figures.js') : null
    const [preflight, readiness_score, maintenance, recent, facts, open_issues] = await Promise.all(
      [
        preflightSummary(app),
        readinessScore(),
        maintenanceOn(),
        extras && minutes
          ? bounded(
              extras.then((m) => m.recentFigures(minutes)),
              boundMs
            ).catch(() => TIMED_OUT)
          : null,
        extras && wantFacts
          ? bounded(
              extras.then((m) => m.releaseFacts()),
              boundMs
            ).catch(() => TIMED_OUT)
          : null,
        openIssueCount()
      ]
    )
    reply.header('Cache-Control', 'no-store')
    return reply.send({
      version: NIVARO_VERSION,
      environment: config.NODE_ENV,
      // The owner gate's production signal (services/hub/owner-access.ts): what this app says it is.
      app_environment: (process.env.NIVARO_ENVIRONMENT ?? '').trim().toLowerCase() || null,
      instance: instanceKey(),
      preflight,
      readiness_score,
      open_issues,
      // Hub phase 6: whether the maintenance freeze is on here (null = could not be read), and
      // whether this app is retired (moved away; ruling B9: a move back checks it is false).
      maintenance,
      retired: isRetiredSync(),
      ...(recent && recent !== TIMED_OUT ? { recent } : {}),
      ...(facts && facts !== TIMED_OUT ? { release_facts: facts } : {}),
      process: {
        uptime_s: Math.round(process.uptime()),
        memory_mb: Math.round(process.memoryUsage().rss / 1048576),
        pool: poolFigures()
      }
    })
  })

  // Phase 3: the first administrator of an app the Hub created, only while the app has none
  // (services/hub-link/first-admin.ts). 201 {user_id, created} | 400 BAD_EMAIL | 409 HAS_ADMIN /
  // NO_ADMIN_ROLE; a failure answers a generic 500 (no driver text, never the request headers).
  // A POST, so unlike /status the maintenance write freeze applies (503 while it is on).
  app.post('/first-admin', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const out = await seedFirstAdmin(req.body)
      if (!out.ok) {
        return reply.code(out.status).send({
          statusCode: out.status,
          error: out.message,
          message: out.message,
          code: out.code
        })
      }
      return reply.code(201).send({ user_id: out.user_id, created: out.created })
    } catch (err) {
      app.log.error(
        { code: (err as { code?: unknown } | null)?.code ?? null },
        'hub link: seeding the first administrator failed'
      )
      const message = 'The first administrator could not be saved'
      return reply
        .code(500)
        .send({ statusCode: 500, error: message, message, code: 'FIRST_ADMIN_FAILED' })
    }
  })

  // Hub enhancement 24: an App Blueprint template into an app the Hub just created
  // (services/hub-link/template-install.ts; routes/hub-link-template.ts).
  hubLinkTemplateRoute(app)

  // ─── Hub phase 6: what a move needs from a dedicated app ─────────────────────────────────
  // Every route below is the Hub's own call (the HUB_TOKEN bearer above), never a person. The
  // maintenance freeze exempts them (services/maintenance-freeze.ts), and so does the retire
  // gate: the Hub must be able to lift both again.

  // Strict maintenance for a move (Decision 19): {on, message?, move_id?} → 200 {on}. On: the
  // override {on, display:'page', strict, hub, message} — nobody is exempt, administrators
  // included. Off: removes only the Hub's own override; with move_id it also releases that
  // move's boot maintenance (HUB_BOOT_MAINTENANCE). This process forgets its cached state at
  // once; other replicas within 15 s (the move waits 16 s, ruling R14). An operator's own freeze
  // is kept under the Hub's and put back when it lifts; {on:false, move_id} for another move's
  // freeze answers 409 MAINTENANCE_OTHER_MOVE. Every rollback must send move_id (boot maintenance).
  // 0.3.215, a move to a shared deployment: {on: true, move_id, target_instance, keep_env_mail?}
  // first carries this app's own per-instance settings row to the row keyed `target_instance`
  // (the shared deployment's NIVARO_INSTANCE), and with keep_env_mail the mail settings it takes
  // from its server environment into that row (services/move-carry.ts). Any failure answers 503
  // (INSTANCE_ROW_NOT_CARRIED / ENV_MAIL_NOT_KEPT) before maintenance is set, so the move stops.
  // Answers `instance_row` {result, keys, differed} and `env_mail` kept|none_needed (names only).
  app.post('/maintenance', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const b = (req.body ?? {}) as {
      on?: unknown
      message?: unknown
      move_id?: unknown
      keep_env_mail?: unknown
      target_instance?: unknown
      only_target?: unknown
    }
    if (typeof b.on !== 'boolean')
      return fail(reply, 400, 'BAD_MAINTENANCE', 'on must be true or false')
    if (b.message != null && (typeof b.message !== 'string' || b.message.length > 500))
      return fail(reply, 400, 'BAD_MAINTENANCE', 'message must be text of at most 500 characters')
    const moveId = b.move_id == null ? null : positiveId(b.move_id)
    if (b.move_id != null && moveId == null)
      return fail(reply, 400, 'BAD_MOVE_ID', 'move_id must be a positive whole number')
    // Hub placement (review C1): {on:false, move_id, only_target:true} lifts maintenance only on
    // the NEW stack of that move (HUB_BOOT_MAINTENANCE = move_id). A move between two stacks of
    // one environment sends it over the public name: should the name still reach the OLD stack,
    // that one answers 409 NOT_THE_MOVE_TARGET and keeps its freeze.
    if (b.only_target === true) {
      const { hubBootMoveId } = await import('../services/hub-boot-move.js')
      if (moveId == null || hubBootMoveId() !== moveId)
        return fail(
          reply,
          409,
          'NOT_THE_MOVE_TARGET',
          'This app is not the new stack of that move; its maintenance was left as it is'
        )
    }
    const carry = await import('../services/move-carry.js')
    if (b.target_instance != null && !carry.validTargetInstance(b.target_instance))
      return fail(reply, 400, 'BAD_TARGET_INSTANCE', 'target_instance must be an instance name')
    const extra: Record<string, unknown> = {}
    if (b.on === true && moveId != null && carry.validTargetInstance(b.target_instance)) {
      const target = b.target_instance
      try {
        const row = await carry.carryInstanceRow(target)
        extra.instance_row = row
        if (row.keys.length || row.differed.length)
          app.log.info(
            { move_id: moveId, result: row.result, keys: row.keys, differed: row.differed },
            'hub link: per-instance settings carried for the move'
          )
      } catch {
        return fail(
          reply,
          503,
          'INSTANCE_ROW_NOT_CARRIED',
          "This app's per-instance settings could not be copied for the new home"
        )
      }
      if (b.keep_env_mail === true) {
        try {
          const kept = await carry.keepEnvMail(target)
          extra.env_mail = kept.env_mail
          if (kept.env_mail === 'kept')
            app.log.info(
              { move_id: moveId, fields: kept.fields },
              'hub link: mail settings from the environment kept for the move'
            )
        } catch {
          return fail(
            reply,
            503,
            'ENV_MAIL_NOT_KEPT',
            "The mail settings from this server's environment could not be saved for the new home"
          )
        }
      }
    }
    const { setHubMaintenance, HubMaintenanceMoveMismatch } = await import(
      '../services/security.js'
    )
    try {
      await setHubMaintenance({
        on: b.on,
        message: typeof b.message === 'string' ? b.message.trim() || null : null,
        moveId
      })
      // Hub gap sqlite: the move lifted its freeze (a rollback): a SQLite database it froze for
      // its copy takes writes again (db/sqlite-transfer.ts).
      if (!b.on) {
        const { thawSqliteFile } = await import('../db/sqlite-transfer.js')
        const { config: cfg } = await import('../config.js')
        if (cfg.DB_CLIENT === 'sqlite') thawSqliteFile(cfg.DB_DATABASE)
      }
    } catch (err) {
      if (err instanceof HubMaintenanceMoveMismatch)
        return fail(
          reply,
          409,
          'MAINTENANCE_OTHER_MOVE',
          `The maintenance here belongs to move ${err.heldBy}; it was left on`
        )
      return fail(reply, 503, 'REDIS_UNAVAILABLE', 'Maintenance could not be stored (Redis)')
    }
    return reply.send({ on: b.on, ...extra })
  })

  // Retire this app after a move away (Decision 10): {move_id} → 200 {retired: true}. Every
  // path but the hub link, the file transfer and the probes answers 503 APP_MOVED; no scheduled
  // job fires; new sockets are refused. Kept in this app's Redis across restarts.
  app.post('/retire', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const moveId = positiveId((req.body as { move_id?: unknown } | null)?.move_id)
    if (moveId == null)
      return fail(reply, 400, 'BAD_MOVE_ID', 'move_id must be a positive whole number')
    try {
      await setRetired({ move_id: moveId })
    } catch {
      return fail(reply, 503, 'REDIS_UNAVAILABLE', 'The retire could not be stored (Redis)')
    }
    app.log.warn({ move_id: moveId }, 'hub link: this app is retired (moved away by the Hub)')
    return reply.send({ retired: true })
  })

  // Bring a retired app back (a rollback, or a move back onto this stack: ruling B9).
  app.delete('/retire', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      await setRetired(null)
    } catch {
      return fail(reply, 503, 'REDIS_UNAVAILABLE', 'The retire could not be cleared (Redis)')
    }
    app.log.info('hub link: this app is no longer retired')
    return reply.send({ retired: false })
  })

  // What a shared deployment would lose (Decision 12), plus the facts a move plan compares:
  // key fingerprint (never the key), sign-in, database identity, files, busy work, version and
  // extensions. Counts and kinds only, never record content.
  app.get('/shared-readiness', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { computeSharedReadiness } = await import('../services/hub-link/shared-readiness.js')
      return reply.send(await computeSharedReadiness())
    } catch (err) {
      app.log.error(
        { code: (err as { code?: unknown } | null)?.code ?? null },
        'hub link: the shared-readiness report failed'
      )
      return fail(reply, 503, 'READINESS_FAILED', 'The shared-readiness report could not be read')
    }
  })

  // ─── Hub people directory + "Offboard everywhere" (services/hub-link/people.ts) ───────────
  // POSTs so the identity travels in the body, never the URL. Matched by email or Entra object
  // id only; suspend only (never delete), refused 409 LAST_ADMIN. Exempt from the maintenance
  // freeze like every hub-link call but first-admin: offboarding must not wait for a freeze.
  app.post('/people/lookup', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { lookupPeople } = await import('../services/hub-link/people.js')
    try {
      const out = await lookupPeople(req.body)
      if (!out.ok) return fail(reply, 400, 'BAD_PERSON', 'Give up to 5 emails and/or Entra ids')
      return reply.send({ accounts: out.accounts })
    } catch (err) {
      app.log.error(
        { code: (err as { code?: unknown } | null)?.code ?? null },
        'hub link: a people lookup failed'
      )
      return fail(reply, 500, 'LOOKUP_FAILED', 'The person could not be looked up')
    }
  })

  app.post('/people/suspend', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { suspendPeople } = await import('../services/hub-link/people.js')
    try {
      const out = await suspendPeople(req.body, {
        redis: (app as unknown as { redis?: unknown }).redis,
        app
      })
      if (!out.ok) return fail(reply, out.status, out.code, out.message)
      return reply.send({ state: out.state, accounts: out.accounts })
    } catch (err) {
      app.log.error(
        { code: (err as { code?: unknown } | null)?.code ?? null },
        'hub link: suspending a person failed'
      )
      return fail(reply, 500, 'SUSPEND_FAILED', 'The person could not be suspended')
    }
  })

  // ─── Hub phase 6 Task 10: file transfer for a move (services/hub-transfer/*) ──────────────
  // As the SOURCE: a 6 h transfer ticket the target presents to GET /api/hub-transfer/files/:id
  // (routes/hub-transfer.ts). As the TARGET: pull every env-local stored object from the source
  // the Hub names, then read the run. The ticket travels only in these bodies (never logged:
  // the request log skips /api/hub-link/) and is never answered back.

  app.post('/files/ticket', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { mintTransferTicket } = await import('../services/hub-transfer/tickets.js')
    try {
      return reply.send(await mintTransferTicket(null))
    } catch {
      return fail(
        reply,
        503,
        'REDIS_UNAVAILABLE',
        'The transfer ticket could not be stored (Redis)'
      )
    }
  })

  // Revoke a ticket this app minted ({ticket} → 200 {revoked}); the Hub calls it when a move ends.
  app.delete('/files/ticket', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { revokeTransferTicket, TRANSFER_TICKET_RE } = await import(
      '../services/hub-transfer/tickets.js'
    )
    const ticket = (req.body as { ticket?: unknown } | null)?.ticket
    if (typeof ticket !== 'string' || !TRANSFER_TICKET_RE.test(ticket))
      return fail(reply, 400, 'BAD_TICKET', 'ticket must be a transfer ticket')
    try {
      return reply.send({ revoked: await revokeTransferTicket(ticket, null) })
    } catch {
      return fail(reply, 503, 'REDIS_UNAVAILABLE', 'The ticket could not be revoked (Redis)')
    }
  })

  app.post('/files/pull', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { startPull, PullError, errorShape } = await import('../services/hub-transfer/pull.js')
    const b = (req.body ?? {}) as {
      source?: unknown
      ticket?: unknown
      mode?: unknown
      objects?: unknown
      env_objects?: unknown
      replays?: unknown
      source_scope?: unknown
    }
    try {
      const out = await startPull({
        source: b.source as string,
        ticket: b.ticket as string,
        mode: b.mode as 'full' | 'delta',
        objects: b.objects === true,
        env_objects: b.env_objects === true,
        replays: b.replays === true,
        ...(typeof b.source_scope === 'string' ? { source_scope: b.source_scope } : {})
      })
      return reply.code(202).send(out)
    } catch (err) {
      if (err instanceof PullError) return fail(reply, err.statusCode, err.code, err.message)
      app.log.error(errorShape(err), 'hub link: the file copy could not be started')
      return fail(reply, 500, 'PULL_FAILED', 'The file copy could not be started')
    }
  })

  app.get<{ Params: { runId: string } }>('/files/pull/:runId', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { readPullStatus } = await import('../services/hub-transfer/pull.js')
    const s = await readPullStatus(req.params.runId)
    if (!s) return fail(reply, 404, 'UNKNOWN_RUN', 'No file copy with that id here')
    return reply.send(s)
  })

  // ─── Hub gap sqlite (0.3.215): a SQLite app's database file in a move ──────────────────────
  // Review 4 (N2/N3): the copy and the checksum are start-then-poll jobs
  // (services/hub-transfer/database-jobs.ts).
  // POST /files/database/pull {source, ticket, move_id} → 202 {job}: the copy is fetched with the
  //      ticket, checked (checksum, integrity_check in a child process, ledger) and staged; once
  //      the Hub has read the job's end (or 90 s after it), this app restarts and installs it at
  //      boot. A pull past its own deadline removes its copy and fails.
  // POST /files/database/sum → 202 {job}: this app's database checksum (a source, before release)
  // GET  /files/database/jobs/:job → {job}
  // DELETE /files/database/jobs/:job → {cancelled}: the Hub gave up (review 5 M1)
  // GET  /files/database/adopted → {adopted: {sha256, move_id} | null, refused: {move_id, code} |
  //      null}: what the last boot put in, or why it refused a staged copy (review 5 L6).
  const databaseFail = (reply: FastifyReply, err: unknown) => {
    const e = err as { code?: unknown; statusCode?: unknown; message?: unknown; name?: unknown }
    if (
      e?.name === 'DatabaseTransferError' ||
      e?.name === 'SqliteTransferError' ||
      e?.name === 'DatabaseJobError'
    )
      return fail(
        reply,
        typeof e.statusCode === 'number' ? e.statusCode : 409,
        String(e.code),
        String(e.message)
      )
    app.log.error({ err_name: e?.name ?? null }, 'hub link: database copy failed')
    return fail(reply, 500, 'DATABASE_COPY_FAILED', 'The database copy failed here')
  }

  app.post('/files/database/pull', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { pullDatabaseDedicated, databaseTransferDeps } = await import(
      '../services/hub-transfer/database.js'
    )
    const { startDatabaseJob } = await import('../services/hub-transfer/database-jobs.js')
    const b = (req.body ?? {}) as { source?: unknown; ticket?: unknown; move_id?: unknown }
    const moveId = positiveId(b.move_id)
    let fallback: NodeJS.Timeout | null = null
    try {
      const job = startDatabaseJob(
        'self',
        'pull',
        moveId ? `move:${moveId}` : `pull:${Date.now()}`,
        async (signal) => {
          const r = await pullDatabaseDedicated(
            { source: b.source as string, ticket: b.ticket as string },
            moveId,
            { signal }
          )
          // The Hub reads the end, then this app restarts; if it never does, restart anyway.
          fallback = setTimeout(() => databaseTransferDeps.restart(0), 90_000)
          fallback.unref?.()
          return r
        },
        {
          afterRead: () => {
            if (fallback) clearTimeout(fallback)
            databaseTransferDeps.restart(2_000)
          }
        }
      )
      return reply.code(202).send({ job })
    } catch (err) {
      return databaseFail(reply, err)
    }
  })

  app.post('/files/database/sum', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { databaseSum } = await import('../services/hub-transfer/database.js')
    const { startDatabaseJob } = await import('../services/hub-transfer/database-jobs.js')
    try {
      return reply
        .code(202)
        .send({ job: startDatabaseJob('self', 'sum', 'sum', () => databaseSum(null)) })
    } catch (err) {
      return databaseFail(reply, err)
    }
  })

  app.get<{ Params: { job: string } }>('/files/database/jobs/:job', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { readDatabaseJob, JOB_ID_RE } = await import('../services/hub-transfer/database-jobs.js')
    const job = JOB_ID_RE.test(req.params.job) ? readDatabaseJob('self', req.params.job) : null
    if (!job) return fail(reply, 404, 'UNKNOWN_JOB', 'No such database job here')
    return reply.send({ job })
  })

  app.delete<{ Params: { job: string } }>('/files/database/jobs/:job', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { cancelDatabaseJob, JOB_ID_RE } = await import(
      '../services/hub-transfer/database-jobs.js'
    )
    const ok = JOB_ID_RE.test(req.params.job)
    return reply.send({ cancelled: ok ? cancelDatabaseJob('self', req.params.job) : false })
  })

  app.get('/files/database/adopted', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { databaseAdopted, databaseAdoptRefused } = await import(
      '../services/hub-transfer/database.js'
    )
    return reply.send({ adopted: await databaseAdopted(), refused: databaseAdoptRefused() })
  })
}
