import { hostAllowed } from '../provider-fetch.js'
import { isRetryableStatus, ProviderError } from '../types.js'

/**
 * The Nivaro Teams bot as a Hub notify path (services/teams-bot/*, unchanged). The bot is the
 * Hub's own app registration (Settings → Microsoft → Teams bot); it can post into a channel or
 * chat it is installed in, given that conversation's id and Bot Connector address. The bot's
 * token goes only to an address on Microsoft's own Bot Connector hosts below: an address anyone
 * typed in is never trusted with it. The teams-bot modules are loaded on use, so a Hub that
 * never sends through the bot never touches them.
 */

/** The Bot Connector hosts a conversation's service address may name. */
export const BOT_SERVICE_HOSTS: readonly string[] = [
  'smba.trafficmanager.net',
  '*.botframework.com',
  '*.teams.microsoft.com',
  '*.teams.microsoft.us'
]

/** Why `raw` is not an acceptable Bot Connector address (empty = fine). */
export function serviceUrlProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'Enter the bot’s service address.'
  if (raw.length > 512) return 'The bot’s service address is too long.'
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return 'The bot’s service address is not a valid address.'
  }
  if (u.protocol !== 'https:') return 'The bot’s service address must start with https://.'
  if (u.username || u.password) return 'The bot’s service address may not carry a login.'
  if (!hostAllowed(u.hostname, BOT_SERVICE_HOSTS))
    return `${u.hostname} is not a Microsoft Bot Connector address, so the bot’s token is not sent there.`
  return null
}

export function conversationIdProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'Enter the bot conversation id.'
  if (raw.length > 512) return 'The conversation id is too long.'
  for (const ch of raw) {
    const c = ch.charCodeAt(0)
    if (c < 0x20 || c === 0x7f) return 'The conversation id holds control characters.'
  }
  return null
}

/** Whether this Hub runs the bot (a configured, enabled bot app), and why not when it does not. */
export async function botReady(): Promise<{ ready: boolean; reason: string }> {
  try {
    const { getTeamsBotConfig } = await import('../../../teams-bot/config.js')
    const cfg = await getTeamsBotConfig()
    if (cfg.enabled) return { ready: true, reason: 'The Nivaro Teams bot is set up on this Hub.' }
    return {
      ready: false,
      reason:
        cfg.reason === 'cloud'
          ? 'The Nivaro Teams bot is not available in cloud mode.'
          : 'The Nivaro Teams bot is not set up on this Hub (Settings → Microsoft → Teams bot).'
    }
  } catch {
    return { ready: false, reason: 'The Nivaro Teams bot could not be checked.' }
  }
}

/** One adaptive card to one conversation through the bot. Throws ProviderError. */
export async function sendToConversation(
  serviceUrl: string,
  conversationId: string,
  card: Record<string, unknown>
): Promise<void> {
  const problem = serviceUrlProblem(serviceUrl) ?? conversationIdProblem(conversationId)
  if (problem) throw new ProviderError('INVALID', problem)
  const { sendActivity } = await import('../../../teams-bot/connector.js')
  try {
    await sendActivity(serviceUrl.trim(), conversationId.trim(), {
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }]
    })
  } catch (err) {
    const status = Number((err as { status?: unknown } | null)?.status)
    // The connector's own messages name only the step and the status, never the token.
    const text = err instanceof Error ? err.message : 'The bot could not send the message.'
    if (status === 503)
      throw new ProviderError(
        'BOT_NOT_CONFIGURED',
        'The Nivaro Teams bot is not set up on this Hub.'
      )
    if (status === 429)
      throw new ProviderError(
        'RATE_LIMITED',
        'Teams is rate limiting the bot; try again shortly.',
        {
          status: 429,
          retryable: true
        }
      )
    if (status === 403 || status === 404)
      throw new ProviderError(
        'TARGET_GONE',
        'The bot is no longer in that conversation (uninstalled, or the id is wrong).',
        { status }
      )
    throw new ProviderError('PROVIDER_ERROR', text.slice(0, 300), {
      ...(Number.isFinite(status) ? { status } : {}),
      retryable: Number.isFinite(status) ? isRetryableStatus(status) : true
    })
  }
}
