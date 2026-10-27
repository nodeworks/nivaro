import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { linkTo } from '../services/app-links.js'
import { bustNotifyPrefsCache } from '../services/notification-channels.js'
import { handleInvoke } from '../services/teams-bot/actions.js'
import { messageText, type TeamsActivity } from '../services/teams-bot/activity.js'
import { answerInTeams } from '../services/teams-bot/ask.js'
import { type AdaptiveCard, resultCard } from '../services/teams-bot/cards.js'
import { getTeamsBotConfig } from '../services/teams-bot/config.js'
import { connectCard } from '../services/teams-bot/connect-card.js'
import { sendActivity } from '../services/teams-bot/connector.js'
import { verifyConnectorToken } from '../services/teams-bot/jwt.js'
import {
  markLink,
  readConnectToken,
  resolveTeamsUser,
  TeamsLinkTakenError,
  upsertLink
} from '../services/teams-bot/links.js'
import { canSignIn, getUser } from '../services/users.js'
import type { User } from '../types.js'

// POST /api/teams/messages is called by the Bot Connector, GET /api/teams/connect by a person's
// browser. Neither has a bearer: the first is authenticated by the Connector JWT (verified before
// anything else is read), the second reads the session itself.

const CARD = 'application/vnd.microsoft.card.adaptive'
const DEDUPE_TTL_S = 600
const LRU_MAX = 1000

const seen = new Map<string, true>()
function rememberLocal(id: string): boolean {
  if (seen.has(id)) return false
  seen.set(id, true)
  if (seen.size > LRU_MAX) seen.delete(seen.keys().next().value as string)
  return true
}

/** True the first time an activity id is seen (Teams re-sends when we are slow). */
async function firstTime(app: FastifyInstance, id: string): Promise<boolean> {
  const redis = (app as { redis?: { set: (...a: unknown[]) => Promise<unknown> } }).redis
  if (redis) {
    try {
      return (await redis.set(`nvr:teams:act:${id}`, '1', 'EX', DEDUPE_TTL_S, 'NX')) === 'OK'
    } catch {
      // Redis trouble: fall through to this process's own memory.
    }
  }
  return rememberLocal(id)
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function page(status: number, text: string) {
  return {
    status,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nivaro</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;text-align:center"><p>${esc(text)}</p></body></html>`
  }
}

async function reply(activity: TeamsActivity, card: AdaptiveCard): Promise<void> {
  if (!activity.serviceUrl || !activity.conversation?.id) return
  await sendActivity(activity.serviceUrl, activity.conversation.id, {
    attachments: [{ contentType: CARD, content: card }]
  })
}
// The handler's own `reply` (Fastify's) shadows this one there.
const replyTo = reply

const HELP =
  'Ask me anything about your records. Or type: my work (open My Work), mute 1h (pause Teams notifications for an hour), unmute, settings, link, unlink, help.'

async function setMute(userId: string, until: string | null): Promise<void> {
  const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
    | { preferences?: string | Record<string, unknown> | null }
    | undefined
  const prefs =
    typeof row?.preferences === 'string'
      ? (JSON.parse(row.preferences) as Record<string, unknown>)
      : { ...((row?.preferences as Record<string, unknown>) ?? {}) }
  const np = { ...((prefs.notification_prefs as Record<string, unknown>) ?? {}) }
  if (until) np.teams_muted_until = until
  else delete np.teams_muted_until
  prefs.notification_prefs = np
  await db('nivaro_users')
    .where({ id: userId })
    .update({ preferences: JSON.stringify(prefs) })
  bustNotifyPrefsCache(userId)
}

async function handleMessage(app: FastifyInstance, activity: TeamsActivity): Promise<void> {
  const oid = activity.from?.aadObjectId
  const tenantId = activity.channelData?.tenant?.id ?? ''
  if (!oid) return
  const who = await resolveTeamsUser(oid, tenantId)
  if (!who.user) {
    await reply(activity, connectCard(oid, tenantId))
    return
  }
  const user = who.user as User
  // Keep the 1:1 conversation fresh so notifications reach this chat.
  if (activity.conversation?.conversationType === 'personal' && activity.conversation.id) {
    if (!who.link || who.link.conversation_id !== activity.conversation.id)
      await upsertLink(user.id, {
        aadObjectId: oid,
        tenantId,
        conversationId: activity.conversation.id,
        serviceUrl: activity.serviceUrl ?? null,
        linkedBy: 'entra_oid'
      })
  }

  const text = messageText(activity)
  switch (text.toLowerCase()) {
    case 'help':
      return reply(activity, resultCard(HELP))
    case 'my work':
      return reply(
        activity,
        resultCard(
          'Your open work is waiting in My Work.',
          await linkTo('my_work', {}, { recipientUserId: user.id })
        )
      )
    case 'settings':
      return reply(
        activity,
        resultCard(
          'Choose which notifications reach Teams under Profile → Notification rules.',
          await linkTo('profile', {}, { recipientUserId: user.id })
        )
      )
    case 'mute 1h': {
      await setMute(user.id, new Date(Date.now() + 60 * 60 * 1000).toISOString())
      return reply(activity, resultCard('Teams notifications are muted for 1 hour.'))
    }
    case 'unmute':
      await setMute(user.id, null)
      return reply(activity, resultCard('Teams notifications are back on.'))
    case 'link':
      return reply(activity, resultCard('Your Teams account is connected to Nivaro.'))
    case 'unlink':
      await markLink(oid, 'unlinked')
      return reply(
        activity,
        resultCard(
          'Disconnected. You will not get Nivaro notifications here. Message me to connect again.'
        )
      )
    default:
      return answerInTeams(app, activity, user)
  }
}

async function handleInstall(activity: TeamsActivity): Promise<void> {
  const oid = activity.from?.aadObjectId
  const tenantId = activity.channelData?.tenant?.id ?? ''
  if (!oid) return
  const who = await resolveTeamsUser(oid, tenantId)
  if (!who.user) {
    await reply(activity, connectCard(oid, tenantId))
    return
  }
  await upsertLink(who.user.id, {
    aadObjectId: oid,
    tenantId,
    conversationId: activity.conversation?.id ?? null,
    serviceUrl: activity.serviceUrl ?? null,
    linkedBy: 'entra_oid'
  })
  const first = who.user.first_name?.trim() || 'there'
  await reply(
    activity,
    resultCard(
      `Hi ${first}. You'll get your Nivaro notifications here once you turn Teams on under Profile → Notification rules. Ask me anything about your records, or type help.`
    )
  )
}

export async function teamsBotRoutes(app: FastifyInstance) {
  app.post('/messages', async (req, reply) => {
    const cfg = await getTeamsBotConfig()
    if (!cfg.enabled) return reply.code(404).send({ error: 'Not found' })
    const activity = (req.body && typeof req.body === 'object' ? req.body : {}) as TeamsActivity
    const verdict = await verifyConnectorToken(req.headers.authorization, activity, cfg)
    if (!verdict.ok) {
      req.log.warn({ reason: verdict.reason }, 'teams bot: refused')
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    switch (activity.type) {
      case 'invoke': {
        if (activity.name !== 'adaptiveCard/action') return reply.code(200).send({})
        const card = await handleInvoke(app, activity)
        return reply.code(200).send({ statusCode: 200, type: CARD, value: card })
      }
      case 'message': {
        // Activity ids are unique per conversation, not globally.
        const key = activity.id ? `${activity.conversation?.id ?? ''}:${activity.id}` : ''
        if (!key || !(await firstTime(app, key))) return reply.code(200).send({})
        void Promise.resolve()
          .then(() => handleMessage(app, activity))
          .catch(async (err) => {
            // Name only: the error may carry the question or the answer.
            req.log.error(
              { error: (err as Error)?.name, status: (err as { status?: number })?.status },
              'teams bot: message handling failed'
            )
            await replyTo(
              activity,
              resultCard('Something went wrong answering that. Try again in a minute.')
            ).catch(() => undefined)
          })
        return reply.code(200).send({})
      }
      case 'conversationUpdate': {
        const botId = activity.recipient?.id
        const added = (activity.membersAdded ?? []).some((m) => m.id && m.id === botId)
        if (added && activity.conversation?.conversationType === 'personal') {
          try {
            await handleInstall(activity)
          } catch (err) {
            req.log.error({ err }, 'teams bot: install handling failed')
          }
        }
        return reply.code(200).send({})
      }
      case 'installationUpdate': {
        if (
          activity.action === 'remove' &&
          activity.from?.aadObjectId &&
          activity.conversation?.conversationType === 'personal'
        ) {
          try {
            await markLink(activity.from.aadObjectId, 'uninstalled')
          } catch (err) {
            req.log.error({ err }, 'teams bot: uninstall handling failed')
          }
        }
        return reply.code(200).send({})
      }
      default:
        return reply.code(200).send({})
    }
  })

  app.get<{ Querystring: { t?: string } }>('/connect', async (req, reply) => {
    const send = (p: { status: number; html: string }) =>
      reply.code(p.status).type('text/html; charset=utf-8').send(p.html)
    const token = readConnectToken(String(req.query?.t ?? ''))
    if (!token)
      return send(page(400, 'This link has expired. Message the bot again for a new one.'))

    const userId = (req as { session?: { userId?: string } }).session?.userId
    if (!userId) {
      const back = `${config.PUBLIC_URL.replace(/\/$/, '')}/api/teams/connect?t=${encodeURIComponent(String(req.query.t))}`
      return reply.redirect(
        `${config.PUBLIC_URL.replace(/\/$/, '')}/api/auth/login?returnTo=${encodeURIComponent(back)}`
      )
    }
    const user = await getUser(userId)
    if (!user || !canSignIn(user)) return send(page(403, 'This account cannot be connected.'))
    const oid = String((user as { entra_oid?: string | null }).entra_oid ?? '')
      .trim()
      .toLowerCase()
    if (!oid) return send(page(400, 'Sign in with Microsoft first, then open this link again.'))
    // The safety check: the Teams person in the token must be this Microsoft account.
    if (oid !== token.aadObjectId.toLowerCase())
      return send(page(403, 'This link belongs to a different Microsoft account.'))
    try {
      await upsertLink(user.id, {
        aadObjectId: token.aadObjectId,
        tenantId: token.tenantId,
        conversationId: null,
        serviceUrl: null,
        linkedBy: 'sign_in'
      })
    } catch (err) {
      if (err instanceof TeamsLinkTakenError)
        return send(page(403, 'This Teams account is already linked to another Nivaro user.'))
      req.log.error({ message: (err as Error)?.message }, 'teams bot: connect failed')
      return send(page(500, 'Something went wrong linking Teams. Try again in a minute.'))
    }
    return send(page(200, 'Teams connected. You can close this tab.'))
  })
}
