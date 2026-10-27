import type { FastifyInstance } from 'fastify'
import type { User } from '../../types.js'
import { logActivity } from '../activity.js'
import { linkTo } from '../app-links.js'
import {
  answerAssistantQuestion,
  type BotAnswer,
  type BotStreamLike,
  stripAskBlocks
} from '../chat-bot.js'
import { AUDIENCE_CAP, REPLAY_BUDGET, type RoomAudience } from '../chat-bot-audience.js'
import { messageText, type TeamsActivity } from './activity.js'
import { type AdaptiveCard, answerCard, resultCard } from './cards.js'
import { getTeamsBotConfig } from './config.js'
import { createPersonalConversation, getPagedMembers, sendActivity } from './connector.js'
import { linkForUser, resolveTeamsUser, upsertLink } from './links.js'

// Ask AI from Teams (spec §6.3, §6.4). The question always runs AS THE ASKER through the room
// assistant's loop (chat-bot.ts), so every tool call carries their own access. In a channel the
// answer is posted only when the room rule says every channel member may read what it used;
// otherwise the thread gets a pointer and the answer goes to the asker's 1:1 chat.
// Neither the question nor the answer is ever logged.

const CARD = 'application/vnd.microsoft.card.adaptive'
const OPEN: RoomAudience = { kind: 'open' }
const upper = (v: unknown) => String(v ?? '').toUpperCase()

/** BotStreamLike for Teams: no live streaming, just the text and whether it went private. */
export class TeamsStream implements BotStreamLike {
  private priv = false
  text = ''
  get isPrivate(): boolean {
    return this.priv
  }
  stopped(): boolean {
    return false
  }
  delta(text: string): void {
    this.text += text
  }
  status(): void {}
  goPrivate(): void {
    this.priv = true
  }
}

/**
 * Everyone but the asker who reads the channel, as Nivaro users, or `open` when any member
 * cannot be matched (or has no Entra id), the roster cannot be read, or it is too big to replay.
 * The roster is the TEAM's (channelData.team.id): the bot's manifest has no
 * supportsChannelFeatures, so Teams only delivers standard channels, whose readers are the team.
 */
export async function channelAudience(
  activity: TeamsActivity,
  askerId: string
): Promise<RoomAudience> {
  const teamId = activity.channelData?.team?.id
  if (!teamId || !activity.serviceUrl) return OPEN
  const { members, truncated } = await getPagedMembers(
    activity.serviceUrl,
    teamId,
    AUDIENCE_CAP + 1
  )
  if (truncated) return OPEN
  const tenantId = activity.channelData?.tenant?.id ?? activity.conversation?.tenantId ?? ''
  const ids = new Set<string>()
  for (const m of members) {
    if (!m.aadObjectId) return OPEN
    const who = await resolveTeamsUser(m.aadObjectId, tenantId)
    if (!who.user) return OPEN
    ids.add(upper(who.user.id))
  }
  ids.delete(upper(askerId))
  return ids.size > AUDIENCE_CAP ? OPEN : { kind: 'people', ids: [...ids] }
}

function channelPlace(activity: TeamsActivity): string {
  const ch = activity.channelData?.channel
  const team = activity.channelData?.team
  // Teams sends the General channel's name as null (its id is the team id).
  const name = ch?.name || (ch?.id && ch.id === team?.id ? 'General' : 'a channel')
  return `#${name}${team?.name ? ` in ${team.name}` : ''}`
}

async function sendCard(
  serviceUrl: string,
  conversationId: string,
  card: AdaptiveCard,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await sendActivity(serviceUrl, conversationId, {
    ...extra,
    attachments: [{ contentType: CARD, content: card }]
  })
}

/** The asker's 1:1 chat: the stored one, else a new one (stored so notifications reach it too). */
async function sendPrivately(
  activity: TeamsActivity,
  asker: User,
  card: AdaptiveCard
): Promise<boolean> {
  const link = await linkForUser(String(asker.id)).catch(() => null)
  if (link?.conversation_id) {
    try {
      await sendCard(link.service_url || String(activity.serviceUrl), link.conversation_id, card)
      return true
    } catch {
      // A stale conversation: open a fresh one below.
    }
  }
  const memberId = activity.from?.id
  const serviceUrl = activity.serviceUrl
  if (!memberId || !serviceUrl) return false
  try {
    const cfg = await getTeamsBotConfig()
    const conversationId = await createPersonalConversation(serviceUrl, cfg, memberId)
    const oid = activity.from?.aadObjectId
    if (oid) {
      try {
        await upsertLink(String(asker.id), {
          aadObjectId: oid,
          tenantId: activity.channelData?.tenant?.id ?? cfg.tenantId,
          conversationId,
          serviceUrl,
          linkedBy: link?.linked_by ?? 'entra_oid'
        })
      } catch {
        // Not stored (e.g. the oid is another account's): this answer still goes out.
      }
    }
    await sendCard(serviceUrl, conversationId, card)
    return true
  } catch {
    return false
  }
}

export async function answerInTeams(
  app: FastifyInstance,
  activity: TeamsActivity,
  asker: User
): Promise<void> {
  const serviceUrl = activity.serviceUrl
  const conversationId = activity.conversation?.id
  if (!serviceUrl || !conversationId) return
  const question = messageText(activity)
  if (!question) return
  const dm = activity.conversation?.conversationType === 'personal'
  // In a channel, reply in the message's thread.
  const thread = !dm && activity.id ? { replyToId: activity.id } : {}

  await sendActivity(serviceUrl, conversationId, { type: 'typing' }).catch(() => undefined)

  const audience: RoomAudience = dm
    ? { kind: 'people', ids: [] }
    : await channelAudience(activity, String(asker.id)).catch(() => OPEN)
  const alone = audience.kind === 'people' && audience.ids.length === 0
  const room = `teams:${conversationId}`
  const stream = new TeamsStream()
  let outcome: BotAnswer
  try {
    outcome = await answerAssistantQuestion(app, asker, question, {
      context: '',
      room,
      record: null,
      opsOn: false,
      stream,
      verify: {
        room,
        audience,
        record: null,
        opsRoom: false,
        roomPeople: [],
        budget: { left: REPLAY_BUDGET }
      },
      quietStatus: !alone
    })
  } catch (err) {
    // Name only: a provider error can echo the prompt.
    app.log.warn({ error: (err as Error)?.name }, 'teams bot: answer failed')
    await sendCard(
      serviceUrl,
      conversationId,
      resultCard("Sorry, I couldn't answer that right now. Try again in a minute."),
      thread
    )
    return
  }

  const text = stripAskBlocks(outcome.text) || "I couldn't find an answer to that."
  const continueUrl = await linkTo(
    'ask',
    { q: question.slice(0, 500) },
    { recipientUserId: String(asker.id) }
  )
  const privately = !dm && outcome.verdict === 'private'
  if (!privately) {
    await sendCard(serviceUrl, conversationId, answerCard(text, continueUrl), thread)
  } else {
    const sent = await sendPrivately(
      activity,
      asker,
      answerCard(
        `You asked in ${channelPlace(activity)}: “${question.slice(0, 200)}”\n\n${text}`,
        continueUrl
      )
    )
    await sendCard(
      serviceUrl,
      conversationId,
      resultCard(
        sent
          ? 'Sent you the answer privately.'
          : "The answer uses data not everyone here can see, and I couldn't reach your 1:1 chat with me. Message me there and ask again."
      ),
      thread
    )
  }

  void logActivity({
    action: 'teams-ask',
    user: String(asker.id),
    comment: `teams ${dm ? 'chat' : `channel ${channelPlace(activity)}`} · asked by ${asker.email ?? asker.id}${privately ? ' · answered privately' : ''}`
  })
}
