import { config } from '../../config.js'
import { type AdaptiveCard, resultCard } from './cards.js'
import { signConnectToken } from './links.js'

/** The "sign in with Microsoft to connect" card, for anyone Nivaro cannot match to a user. */
export function connectCard(aadObjectId: string, tenantId: string): AdaptiveCard {
  const url = `${config.PUBLIC_URL.replace(/\/$/, '')}/api/teams/connect?t=${encodeURIComponent(
    signConnectToken(aadObjectId, tenantId)
  )}`
  const card = resultCard(
    "Hi. I couldn't match your Teams account to a Nivaro user. Sign in with Microsoft to connect it."
  )
  card.actions = [{ type: 'Action.OpenUrl', title: 'Connect to Nivaro', url }]
  return card
}
