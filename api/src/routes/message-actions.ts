import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
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
  return {
    status,
    html: `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:Arial,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center;height:90vh;"><div style="text-align:center;"><h2 style="color:#172940;">${body}</h2></div></body></html>`
  }
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** A decision link's landing page: the decision happens only when the person
 *  presses the button (a POST) — mail and chat link scanners that prefetch a
 *  GET can never approve or reject. */
function confirmPage(token: string, decision: 'approve' | 'reject') {
  const verb = decision === 'approve' ? 'Approve' : 'Reject'
  return {
    status: 200,
    html: `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${verb}</title></head><body style="font-family:Arial,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center;height:90vh;"><form method="post" action="callback" style="text-align:center;"><h2 style="color:#172940;">${verb} this request?</h2><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit" style="font-size:16px;padding:10px 24px;border:0;border-radius:6px;background:#00ceff;color:#fff;cursor:pointer;">${verb}</button></form></body></html>`
  }
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
  if (req.authMethod !== 'session' || !req.user) return null
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
    return reply.code(r.status).header('cache-control', 'no-store').type('text/html').send(r.html)
  }

  const viewRedirect = (payload: ActionTokenPayload) =>
    `${config.ADMIN_URL}/collections/${encodeURIComponent(payload.collection ?? '')}/${encodeURIComponent(payload.item ?? '')}`

  const isView = (payload: ActionTokenPayload) =>
    payload.action_id === 'view' || payload.kind === 'view'

  app.get<{ Querystring: { token?: string } }>('/callback', async (req, reply) => {
    // A decision never happens on GET: the page asks, the button POSTs.
    const token = req.query.token
    if (!token) return send(reply, htmlPage('Error', 'Missing token', 400))
    const payload = verifyActionToken(token)
    if (!payload) return send(reply, htmlPage('Error', 'Invalid or expired link', 401))
    if (isView(payload)) return reply.redirect(viewRedirect(payload))
    if (payload.kind !== 'approval') return send(reply, htmlPage('Error', 'Unknown action', 400))

    const verdict = await judgeDecision(req, reply, token, payload, true)
    if (!verdict.ok) return send(reply, verdict)
    if (app.redis && (await app.redis.exists(usedKey(payload.jti as string))))
      return send(reply, htmlPage('Done', 'This link was already used.', 409))
    return send(reply, confirmPage(token, payload.action_id === 'approve' ? 'approve' : 'reject'))
  })

  app.post<{ Querystring: { token?: string }; Body: { token?: string } | null }>(
    '/callback',
    async (req, reply) => {
      const token = req.query.token ?? (req.body as { token?: string } | null)?.token
      if (!token) return send(reply, htmlPage('Error', 'Missing token', 400))
      const payload = verifyActionToken(token)
      if (!payload) return send(reply, htmlPage('Error', 'Invalid or expired link', 401))
      if (isView(payload)) return reply.redirect(viewRedirect(payload))
      if (payload.kind !== 'approval') return send(reply, htmlPage('Error', 'Unknown action', 400))

      const verdict = await judgeDecision(req, reply, token, payload, false)
      if (!verdict.ok) return send(reply, verdict)

      // Spend the token BEFORE deciding (two quick clicks decide once). No Redis = no way to
      // prove single use, so no decision by link at all.
      if (!app.redis) return send(reply, htmlPage('Error', 'Decide this request in Nivaro.', 503))
      const ttl = Math.max(60, payload.exp - Math.floor(Date.now() / 1000) + 60)
      const claimed = await app.redis.set(usedKey(payload.jti as string), '1', 'EX', ttl, 'NX')
      if (claimed !== 'OK') return send(reply, htmlPage('Done', 'This link was already used.', 409))

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
        return send(reply, htmlPage('Error', result.error ?? 'Failed', result.status ?? 400))
      }
      await logActivity({
        action: 'message-action',
        user: verdict.user.id,
        collection: payload.collection ?? undefined,
        item: payload.item ?? undefined,
        comment: `approval ${decision} via message action`,
        req
      })
      return send(reply, htmlPage('Done', `&#10003; Done — ${decision}`))
    }
  )
}
