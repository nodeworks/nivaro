import type { FastifyInstance } from 'fastify'
import { getChannelTestConfig } from '../channel-test-mode.js'
import { noteChannel } from '../traffic-taps/channels.js'
import type { AdaptiveCard } from './cards.js'
import { getTeamsBotConfig } from './config.js'
import { ConnectorError, sendActivity } from './connector.js'
import { linkForUser, markLink, noteLinkError, noteLinkSent } from './links.js'
import { bumpTeamsStat } from './stats.js'

export type TeamsSendOutcome = 'sent' | 'not_connected' | 'disabled' | 'failed'

const MAX_RETRY_WAIT_MS = 30_000
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Sends one card to a person's 1:1 chat. Never throws: the outcome says what happened and is
 * counted on the Traffic Map's Teams node.
 *
 * Test mode (TEAMS_TEST_MODE / the Teams test switch): the test config only names a channel
 * webhook, never people, so a DM has no safe recipient and is dropped ('disabled').
 */
export async function deliverTeams(
  app: FastifyInstance,
  userId: string,
  card: AdaptiveCard,
  _opts: { notificationId?: number | null } = {}
): Promise<TeamsSendOutcome> {
  try {
    const cfg = await getTeamsBotConfig()
    if (!cfg.enabled) return 'disabled'
    if ((await getChannelTestConfig()).teams.on) {
      noteChannel('teams', 'dropped')
      return 'disabled'
    }
    const link = await linkForUser(userId)
    if (!link?.conversation_id || !link.service_url) return 'not_connected'

    const activity = {
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }]
    }
    const started = Date.now()
    try {
      try {
        await sendActivity(link.service_url, link.conversation_id, activity)
      } catch (err) {
        // 429: Microsoft says when to come back. One retry, never a long hold.
        if (!(err instanceof ConnectorError) || err.status !== 429) throw err
        await wait(Math.min(err.retryAfterMs ?? 1000, MAX_RETRY_WAIT_MS))
        await sendActivity(link.service_url, link.conversation_id, activity)
      }
    } catch (err) {
      if (err instanceof ConnectorError && (err.status === 403 || err.status === 404)) {
        // Uninstalled or blocked: stop sending until the person messages the bot again.
        await markLink(link.aad_object_id, 'uninstalled', err.message).catch(() => {})
        noteChannel('teams', 'failed', { ms: Date.now() - started })
        await bumpTeamsStat(app, 'failed')
        return 'not_connected'
      }
      noteChannel('teams', 'failed', { ms: Date.now() - started })
      await bumpTeamsStat(app, 'failed')
      await noteLinkError(
        link.aad_object_id,
        err instanceof Error ? err.message : 'send failed'
      ).catch(() => {})
      return 'failed'
    }
    noteChannel('teams', 'sent', { ms: Date.now() - started })
    await bumpTeamsStat(app, 'sent')
    await noteLinkSent(link.aad_object_id).catch(() => {})
    return 'sent'
  } catch {
    // config / link lookup trouble: a notification never fails because of Teams
    return 'failed'
  }
}
