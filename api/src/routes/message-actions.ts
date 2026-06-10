import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { logActivity } from '../services/activity.js'
import type { Role, User } from '../types.js'

/**
 * Slack / Teams message actions.
 *
 * Outgoing: sendActionCard() posts an Adaptive Card to a Teams incoming webhook
 * with action buttons that hit GET /api/message-actions/callback?token=<signed>.
 * Tokens are HMAC-SHA256 signed with SESSION_SECRET:
 *   base64url(JSON payload) + '.' + base64url(hmac)
 * Payload: { action_id, kind, ref_id, user?, collection?, item?, exp }
 */

export interface ActionTokenPayload {
  action_id: string
  kind: string
  ref_id: string
  user?: string | null
  collection?: string | null
  item?: string | null
  exp: number // unix seconds
}

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function hmac(data: string): Buffer {
  return createHmac('sha256', config.SESSION_SECRET).update(data).digest()
}

export function signActionToken(
  payload: Omit<ActionTokenPayload, 'exp'> & { exp?: number }
): string {
  const full: ActionTokenPayload = {
    ...payload,
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
  const webhookUrl = opts.webhookUrl ?? (await getTeamsWebhookUrl())
  if (!webhookUrl) return false

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

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
      signal: AbortSignal.timeout(15_000)
    })
    return res.ok
  } catch (err) {
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

export async function messageActionsRoutes(app: FastifyInstance) {
  // Token-authenticated — no session/bearer auth on the callback
  const handler = async (token: string | undefined) => {
    if (!token) return { redirect: null, ...htmlPage('Error', 'Missing token', 400) }

    const payload = verifyActionToken(token)
    if (!payload) {
      return { redirect: null, ...htmlPage('Error', 'Invalid or expired link', 401) }
    }

    // 'view' → redirect into the admin UI
    if (payload.action_id === 'view' || payload.kind === 'view') {
      const collection = payload.collection ?? ''
      const item = payload.item ?? ''
      return {
        redirect: `${config.ADMIN_URL}/collections/${collection}/${item}`,
        status: 302,
        html: ''
      }
    }

    if (payload.kind === 'approval') {
      if (!payload.user) {
        return { redirect: null, ...htmlPage('Error', 'This action is not bound to a user', 400) }
      }
      const user = (await db<User>('nivaro_users')
        .where({ id: payload.user, status: 'active' })
        .first()) as User | undefined
      if (!user) return { redirect: null, ...htmlPage('Error', 'User not found', 404) }

      let isAdmin = false
      if (user.role) {
        const role = await db<Role>('nivaro_roles').where({ id: user.role }).first()
        isAdmin = role?.admin_access ?? false
      }

      const decision = payload.action_id === 'approve' ? 'approved' : 'rejected'
      // Lazy import breaks the approvals ↔ message-actions circular dependency
      const { applyApprovalDecision } = await import('./approvals.js')
      const result = await applyApprovalDecision({
        app,
        instanceId: Number(payload.ref_id),
        user,
        isAdmin,
        decision,
        comment: 'Via message action'
      })

      if (!result.ok) {
        return {
          redirect: null,
          ...htmlPage('Error', result.error ?? 'Failed', result.status ?? 400)
        }
      }
      await logActivity({
        action: 'message-action',
        user: user.id,
        collection: payload.collection ?? undefined,
        item: payload.item ?? undefined,
        comment: `approval ${decision} via message action`
      })
      return { redirect: null, ...htmlPage('Done', `&#10003; Done — ${decision}`) }
    }

    return { redirect: null, ...htmlPage('Error', 'Unknown action', 400) }
  }

  app.get<{ Querystring: { token?: string } }>('/callback', async (req, reply) => {
    const result = await handler(req.query.token)
    if (result.redirect) return reply.redirect(result.redirect)
    return reply.code(result.status).type('text/html').send(result.html)
  })

  app.post<{ Querystring: { token?: string }; Body: { token?: string } | null }>(
    '/callback',
    async (req, reply) => {
      const token = req.query.token ?? (req.body as { token?: string } | null)?.token
      const result = await handler(token)
      if (result.redirect) return reply.redirect(result.redirect)
      return reply.code(result.status).type('text/html').send(result.html)
    }
  )
}
