import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { isSessionLike } from '../lib/auth-method.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  type ApprovalLinkState,
  linkHeadline,
  linkStateHtml,
  linkStateSignature,
  loadApprovalLinkState,
  redactLinkState
} from '../services/approval-link-state.js'
import {
  type LiveMode,
  publicLiveCsp,
  publicLivePageHtml,
  publicMessagePageHtml
} from '../services/public-live-page.js'
import { SignalStreamRoute, sharedSignature } from '../services/public-signal-stream.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import { overWindowLimit } from '../services/windowed-limit.js'
import type { User } from '../types.js'

/**
 * Slack / Teams message actions.
 *
 * Outgoing: sendActionCard() posts an Adaptive Card to a Teams incoming webhook
 * with action buttons that hit GET /api/message-actions/callback?token=<signed>.
 * Tokens are HMAC-SHA256 signed with a key derived from SESSION_SECRET for this purpose only:
 *   base64url(JSON payload) + '.' + base64url(hmac)
 * Payload: { action_id, kind, ref_id, user?, collection?, item?, exp, jti? }
 *
 * A card goes to a SHARED channel, so the link alone never decides anything (security audit
 * H8): an Approve/Reject link works only for the approver it names, signed in to Nivaro in that
 * browser (anyone else is sent to sign in, or told the link is not theirs); it works once (a
 * Redis nonce per token) and for 24 hours.
 */

export interface ActionTokenPayload {
  action_id: string
  kind: string
  ref_id: string
  user?: string | null
  collection?: string | null
  item?: string | null
  exp: number // unix seconds
  /** One-time id: a decision token is spent when its decision is made. */
  jti?: string
}

export const TOKEN_TTL_SECONDS = 24 * 60 * 60 // 24 hours
/** Decision links in an approval EMAIL sit in an inbox longer than a chat card. */
export const EMAIL_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

/** This feature's own signing key, derived from SESSION_SECRET (a token signed for another
 *  purpose with the same secret is never accepted here). */
function actionKey(): Buffer {
  return createHmac('sha256', config.SESSION_SECRET).update('nivaro:message-actions:v2').digest()
}

function hmac(data: string): Buffer {
  return createHmac('sha256', actionKey()).update(data).digest()
}

export function signActionToken(
  payload: Omit<ActionTokenPayload, 'exp'> & { exp?: number }
): string {
  const full: ActionTokenPayload = {
    ...payload,
    jti: payload.jti ?? randomUUID(),
    exp: payload.exp ?? Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  }
  const body = b64url(Buffer.from(JSON.stringify(full), 'utf8'))
  return `${body}.${b64url(hmac(body))}`
}

export function verifyActionToken(token: string): ActionTokenPayload | null {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  let given: Buffer
  try {
    given = Buffer.from(sig, 'base64url')
  } catch {
    return null
  }
  const expected = hmac(body)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

  try {
    const payload = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8')
    ) as ActionTokenPayload
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

async function getTeamsWebhookUrl(): Promise<string | null> {
  try {
    const settings = await db('nivaro_settings').where({ id: 1 }).first()
    return (settings?.teams_webhook_url as string | null) || null
  } catch {
    return null
  }
}

export interface ActionCardOptions {
  webhookUrl?: string
  title: string
  text: string
  actions: Array<{ label: string; action_id: string }>
  context: {
    collection: string
    item: string
    kind: string
    ref_id: string
    /** Bind action tokens to a specific user (required for decision actions). */
    user?: string | null
  }
}

/** Post an Adaptive Card with action buttons to a Teams incoming webhook. */
export async function sendActionCard(opts: ActionCardOptions): Promise<boolean> {
  const configured = opts.webhookUrl ?? (await getTeamsWebhookUrl())
  if (!configured) return false
  // Test mode (#832): another channel, or nowhere.
  const { routeTeams } = await import('../services/channel-test-mode.js')
  const routed = await routeTeams(configured)
  if (!routed) return false
  const webhookUrl = routed.url
  opts = { ...opts, title: `${routed.prefix}${opts.title}` }

  const buttons = opts.actions.map((a) => ({
    type: 'Action.OpenUrl',
    title: a.label,
    url: `${config.PUBLIC_URL}/api/message-actions/callback?token=${encodeURIComponent(
      signActionToken({
        action_id: a.action_id,
        kind: opts.context.kind,
        ref_id: opts.context.ref_id,
        user: opts.context.user ?? null,
        collection: opts.context.collection,
        item: opts.context.item
      })
    )}`
  }))

  const card = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: opts.title, weight: 'Bolder', size: 'Medium', wrap: true },
            { type: 'TextBlock', text: opts.text, wrap: true }
          ],
          actions: buttons
        }
      }
    ]
  }

  const { noteChannel } = await import('../services/traffic-taps/channels.js')
  const started = Date.now()
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
      signal: AbortSignal.timeout(15_000)
    })
    noteChannel('teams', res.ok ? 'sent' : 'failed', { ms: Date.now() - started })
    return res.ok
  } catch (err) {
    noteChannel('teams', 'failed', { ms: Date.now() - started })
    console.warn('[message-actions] Teams card post failed:', err)
    return false
  }
}

/** Convenience used by the approvals engine when a step awaits a decision. */
export async function sendApprovalCard(opts: {
  instance: { id: number; collection: string; item: string }
  chainName: string
  stepLabel: string
  approverUserId?: string | null
}): Promise<boolean> {
  const actions: Array<{ label: string; action_id: string }> = []
  // Approve/Reject tokens must be bound to a user — only possible for direct approvers
  if (opts.approverUserId) {
    actions.push({ label: 'Approve', action_id: 'approve' })
    actions.push({ label: 'Reject', action_id: 'reject' })
  }
  actions.push({ label: 'View', action_id: 'view' })

  return sendActionCard({
    title: `Approval requested: ${opts.chainName}`,
    text: `${opts.stepLabel} — ${opts.instance.collection}/${opts.instance.item}`,
    actions,
    context: {
      collection: opts.instance.collection,
      item: opts.instance.item,
      kind: 'approval',
      ref_id: String(opts.instance.id),
      user: opts.approverUserId ?? null
    }
  })
}

function htmlPage(title: string, body: string, status = 200) {
  return { status, html: publicMessagePageHtml(title, body) }
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** The decide form: the decision happens only when the person presses the button (a POST) —
 *  mail and chat link scanners that prefetch a GET can never approve or reject. */
function decideForm(token: string, decision: 'approve' | 'reject'): string {
  const verb = decision === 'approve' ? 'Approve' : 'Reject'
  return `<form method="post" action="callback" class="actions"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit" data-k="decide"${decision === 'reject' ? ' class="reject"' : ''}>${verb}</button></form>`
}

/** Redis key that marks a decision token spent (tenant-scoped, the token's id hashed). */
function usedKey(jti: string): string {
  const h = createHash('sha256').update(jti).digest('hex').slice(0, 40)
  return `nvr:msgact:used:${currentTenantKey()}:${h}`
}

const sameUser = (a: unknown, b: unknown) =>
  String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase() && String(a ?? '') !== ''

/**
 * Who is signed in to Nivaro in this browser — by SESSION only (a decision link is opened from
 * a chat client; a bearer header there would be someone's integration, not the approver).
 * Null = nobody (or the session ended / policy expired it).
 */
async function sessionUser(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<{ user: User; isAdmin: boolean } | null> {
  if (req.headers.authorization) return null
  if (!(req as { session?: { userId?: string } }).session?.userId) return null
  try {
    await authenticate(req, reply)
  } catch {
    return null
  }
  if (!isSessionLike(req.authMethod) || !req.user) return null
  return { user: req.user as User, isAdmin: !!req.isAdmin }
}

type Verdict =
  | { ok: true; user: User; isAdmin: boolean }
  | { ok: false; status: number; html: string; redirect?: string }

/**
 * May the person in this browser make this decision? Only the approver the token names, signed
 * in. `signInRedirect` (GET only) sends a signed-out visitor through sign-in and back here.
 */
async function judgeDecision(
  req: FastifyRequest,
  reply: FastifyReply,
  token: string,
  payload: ActionTokenPayload,
  signInRedirect: boolean
): Promise<Verdict> {
  if (!payload.user)
    return { ok: false, ...htmlPage('Error', 'This action is not bound to a user', 400) }
  if (!payload.jti)
    return {
      ok: false,
      ...htmlPage('Expired', 'This link has expired. Open the request in Nivaro to decide.', 410)
    }
  const me = await sessionUser(req, reply)
  if (!me) {
    if (signInRedirect) {
      const base = config.PUBLIC_URL.replace(/\/$/, '')
      const back = `${base}/api/message-actions/callback?token=${encodeURIComponent(token)}`
      return {
        ok: false,
        status: 302,
        html: '',
        redirect: `${base}/api/auth/login?returnTo=${encodeURIComponent(back)}`
      }
    }
    return {
      ok: false,
      ...htmlPage('Sign in', 'Sign in to Nivaro, then open the link again.', 401)
    }
  }
  if (!sameUser(me.user.id, payload.user))
    return {
      ok: false,
      ...htmlPage('Not yours', 'This link is for another person. Open the request in Nivaro.', 403)
    }
  return { ok: true, user: me.user, isAdmin: me.isAdmin }
}

/** Per-address cap on decision-link page loads (a link scanner or a guesser, not a person). */
const LINK_VIEWS_PER_10_MIN = 120
const LINK_STREAMS_PER_IP = 10
const linkSigs = new Map<string, { at: number; sig: Promise<string | null> }>()

/** The reader's live setting (Calm / Off) when signed in; Normal otherwise. */
async function liveModeOf(user: User | null): Promise<LiveMode> {
  if (!user) return 'normal'
  try {
    const row = (await db('nivaro_users').where({ id: user.id }).first('preferences', 'role')) as
      | { preferences: unknown; role: string | null }
      | undefined
    const prefs =
      typeof row?.preferences === 'string'
        ? (JSON.parse(row.preferences) as Record<string, unknown>)
        : ((row?.preferences as Record<string, unknown> | null) ?? {})
    const own = prefs.live_mode
    if (own === 'calm' || own === 'off' || own === 'normal') return own
    const { liveDefaultForRole, loadLiveRoleDefaults } = await import(
      '../services/live-preference.js'
    )
    return liveDefaultForRole(await loadLiveRoleDefaults(), row?.role) ?? 'normal'
  } catch {
    return 'normal'
  }
}

/** Can the person signed in here read the approval's record (judged as them; null = 404)? */
async function viewerCanReadRecord(
  viewer: User | null,
  payload: ActionTokenPayload
): Promise<boolean> {
  if (!viewer || !payload.collection || !payload.item) return false
  try {
    const { readOne } = await import('../services/items.js')
    return !!(await readOne(viewer, payload.collection, payload.item, undefined, ['id']))
  } catch {
    return false
  }
}

/** The landing page for a decision link: where the approval stands, live while open. */
export function linkPage(opts: {
  token: string
  payload: ActionTokenPayload
  state: ApprovalLinkState
  /** The approver the link names is signed in here (the decide form may show). */
  holderHere: boolean
  spent: boolean
  liveMode: LiveMode
  nonce: string
}): string {
  const verb = opts.payload.action_id === 'approve' ? 'approve' : 'reject'
  const h = linkHeadline(opts.state, verb)
  const decidable = h.decidable && opts.holderHere && !opts.spent
  const openUrl =
    opts.payload.collection && opts.payload.item
      ? `${config.ADMIN_URL}/collections/${encodeURIComponent(opts.payload.collection)}/${encodeURIComponent(opts.payload.item)}`
      : undefined
  const q = `token=${encodeURIComponent(opts.token)}`
  return publicLivePageHtml({
    title: h.title,
    context: opts.state.chain_name ? `Approval · ${opts.state.chain_name}` : 'Approval',
    liveHtml: linkStateHtml(h, {
      formHtml: decidable ? decideForm(opts.token, verb) : undefined,
      openUrl
    }),
    nonce: opts.nonce,
    // Nothing more can change once it is decided: no stream for a final answer.
    streamUrl: opts.state.status === 'pending' ? `stream?${q}` : null,
    refreshUrl: `callback?${q}`,
    liveMode: opts.liveMode
  })
}

const EXPIRED_TEXT = 'This link has expired or was changed. Open the request in Nivaro to decide.'
const INCOMPLETE_TEXT = 'This link is missing a part. Open the request in Nivaro.'

export async function messageActionsRoutes(app: FastifyInstance) {
  // The confirm page posts its token back as a plain HTML form.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)))
      } catch (err) {
        done(err as Error, undefined)
      }
    }
  )

  const send = (reply: FastifyReply, r: { status: number; html: string; redirect?: string }) => {
    if (r.redirect) return reply.redirect(r.redirect)
    return reply
      .code(r.status)
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header('content-security-policy', publicLiveCsp('none'))
      .type('text/html')
      .send(r.html)
  }

  const sendLinkPage = async (
    reply: FastifyReply,
    status: number,
    token: string,
    payload: ActionTokenPayload,
    state: ApprovalLinkState,
    holder: User | null,
    /** Who is signed in here (defaults to the holder). Names and times show only to someone
     *  who can read the record, judged as them; anyone else gets the redacted state. */
    viewer: User | null = holder
  ) => {
    const spent = !!app.redis && !!payload.jti && !!(await app.redis.exists(usedKey(payload.jti)))
    const nonce = randomUUID().replace(/-/g, '')
    if (!(await viewerCanReadRecord(viewer, payload))) state = redactLinkState(state)
    return reply
      .code(status)
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header('content-security-policy', publicLiveCsp(nonce, { forms: true }))
      .type('text/html')
      .send(
        linkPage({
          token,
          payload,
          state,
          holderHere: !!holder,
          spent,
          liveMode: await liveModeOf(holder),
          nonce
        })
      )
  }

  /** Page loads per address: a link opened by a person is a handful; a scanner is not. */
  const overViewLimit = (req: FastifyRequest) =>
    overWindowLimit(
      app.redis,
      `msgact-view:${currentTenantKey()}:${req.ip || 'unknown'}`,
      LINK_VIEWS_PER_10_MIN,
      600
    )

  const viewRedirect = (payload: ActionTokenPayload) =>
    `${config.ADMIN_URL}/collections/${encodeURIComponent(payload.collection ?? '')}/${encodeURIComponent(payload.item ?? '')}`

  const isView = (payload: ActionTokenPayload) =>
    payload.action_id === 'view' || payload.kind === 'view'

  const stateOf = (payload: ActionTokenPayload) =>
    loadApprovalLinkState(Number(payload.ref_id), payload.user ?? null)

  app.get<{ Querystring: { token?: string } }>('/callback', async (req, reply) => {
    // A decision never happens on GET: the page asks, the button POSTs.
    const token = req.query.token
    if (!token) return send(reply, htmlPage('Link incomplete', INCOMPLETE_TEXT, 400))
    const payload = verifyActionToken(token)
    if (!payload) return send(reply, htmlPage('Link expired', EXPIRED_TEXT, 401))
    if (isView(payload)) return reply.redirect(viewRedirect(payload))
    if (payload.kind !== 'approval')
      return send(reply, htmlPage('Link not recognised', 'Open the request in Nivaro.', 400))
    if (await overViewLimit(req))
      return send(
        reply,
        htmlPage('Too many requests', 'Wait a few minutes, then open the link again.', 429)
      )

    const state = await stateOf(payload)
    // Still waiting on this approver: deciding needs them, signed in (security audit H8).
    // Anything else — already decided, withdrawn, another step — the page simply says so.
    if (state.waiting_on_holder) {
      const verdict = await judgeDecision(req, reply, token, payload, true)
      if (!verdict.ok) return send(reply, verdict)
      return sendLinkPage(reply, 200, token, payload, state, verdict.user)
    }
    const me = await sessionUser(req, reply)
    const holder = me && sameUser(me.user.id, payload.user) ? me.user : null
    return sendLinkPage(reply, 200, token, payload, state, holder, me?.user ?? null)
  })

  // ── GET /stream?token= — "changed" while the landing page is open ─────────────
  // Token-scoped: only this approval's record prompts a check, the page's own answer must
  // actually move, and the event carries nothing (services/public-signal-stream.ts).
  const streams = new SignalStreamRoute()
  app.addHook('preClose', async () => {
    streams.closeAll()
  })
  app.get<{ Querystring: { token?: string } }>(
    '/stream',
    { compress: false } as never,
    async (req, reply) => {
      const token = req.query.token
      const payload = token ? verifyActionToken(token) : null
      if (!token || !payload || payload.kind !== 'approval')
        return reply.code(404).send({ error: 'Not found' })
      const instanceId = Number(payload.ref_id)
      const holder = payload.user ?? null
      const tenant = currentTenantKey()
      const signature = () =>
        sharedSignature(linkSigs, `${tenant}|${instanceId}|${holder}`, async () =>
          linkStateSignature(await loadApprovalLinkState(instanceId, holder))
        )
      await streams.serve(req, reply, {
        perIp: LINK_STREAMS_PER_IP,
        heartbeatMs: 25_000,
        coalesceMs: 1_000,
        async open() {
          const state = await loadApprovalLinkState(instanceId, holder)
          if (state.status === 'gone') return { ok: false, code: 404, body: { error: 'Not found' } }
          const collection = payload.collection ?? ''
          const item = String(payload.item ?? '').toLowerCase()
          return {
            ok: true,
            subject: {
              watches: (ev) =>
                ev.collection === collection &&
                (ev.item === '*' || String(ev.item).toLowerCase() === item),
              signature,
              // The link expired: the page reloads into that answer.
              stillServes: async () => !!verifyActionToken(token)
            }
          }
        }
      })
    }
  )

  app.post<{ Querystring: { token?: string }; Body: { token?: string } | null }>(
    '/callback',
    async (req, reply) => {
      const token = req.query.token ?? (req.body as { token?: string } | null)?.token
      if (!token) return send(reply, htmlPage('Link incomplete', INCOMPLETE_TEXT, 400))
      const payload = verifyActionToken(token)
      if (!payload) return send(reply, htmlPage('Link expired', EXPIRED_TEXT, 401))
      if (isView(payload)) return reply.redirect(viewRedirect(payload))
      if (payload.kind !== 'approval')
        return send(reply, htmlPage('Link not recognised', 'Open the request in Nivaro.', 400))

      const verdict = await judgeDecision(req, reply, token, payload, false)
      if (!verdict.ok) return send(reply, verdict)

      // Already decided (by them or anyone), withdrawn, or moved on: say where it stands —
      // a second press, a second tab or a late colleague gets the answer, never an error.
      const before = await stateOf(payload)
      if (!before.waiting_on_holder)
        return sendLinkPage(reply, 409, token, payload, before, verdict.user)

      // Spend the token BEFORE deciding (two quick clicks decide once). No Redis = no way to
      // prove single use, so no decision by link at all.
      if (!app.redis)
        return send(
          reply,
          htmlPage(
            'Decide in Nivaro',
            'This link cannot decide right now. Open the request in Nivaro.',
            503
          )
        )
      const ttl = Math.max(60, payload.exp - Math.floor(Date.now() / 1000) + 60)
      const claimed = await app.redis.set(usedKey(payload.jti as string), '1', 'EX', ttl, 'NX')
      if (claimed !== 'OK')
        return sendLinkPage(reply, 409, token, payload, await stateOf(payload), verdict.user)

      const decision = payload.action_id === 'approve' ? 'approved' : 'rejected'
      // Lazy import breaks the approvals ↔ message-actions circular dependency
      const { applyApprovalDecision } = await import('./approvals.js')
      const result = await applyApprovalDecision({
        app,
        instanceId: Number(payload.ref_id),
        user: verdict.user,
        isAdmin: verdict.isAdmin,
        decision,
        comment: 'Via message action'
      })

      if (!result.ok) {
        // Nothing was decided: the link may be used again (e.g. after a transient failure).
        await app.redis.del(usedKey(payload.jti as string)).catch(() => {})
        // Someone decided in between: the page says who.
        if (result.status === 409)
          return sendLinkPage(reply, 409, token, payload, await stateOf(payload), verdict.user)
        return send(
          reply,
          htmlPage(
            'Not decided',
            'Nothing was decided. Open the request in Nivaro to try again.',
            result.status ?? 400
          )
        )
      }
      await logActivity({
        action: 'message-action',
        user: verdict.user.id,
        collection: payload.collection ?? undefined,
        item: payload.item ?? undefined,
        comment: `approval ${decision} via message action`,
        req
      })
      return sendLinkPage(reply, 200, token, payload, await stateOf(payload), verdict.user)
    }
  )
}

/** A decision-link pair (Approve + Reject) for one approver, for the approval email. */
export function emailDecisionLinks(opts: {
  instance: { id: number; collection: string; item: string }
  userId: string
}): { approve_url: string; reject_url: string } {
  const base = `${config.PUBLIC_URL.replace(/\/$/, '')}/api/message-actions/callback?token=`
  const exp = Math.floor(Date.now() / 1000) + EMAIL_TOKEN_TTL_SECONDS
  const mk = (action_id: 'approve' | 'reject') =>
    base +
    encodeURIComponent(
      signActionToken({
        action_id,
        kind: 'approval',
        ref_id: String(opts.instance.id),
        user: opts.userId,
        collection: opts.instance.collection,
        item: String(opts.instance.item),
        exp
      })
    )
  return { approve_url: mk('approve'), reject_url: mk('reject') }
}
