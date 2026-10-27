import type { FastifyInstance } from 'fastify'
import type { TeamsActivity } from './activity.js'
import { type AdaptiveCard, resultCard } from './cards.js'

// Stub: Task 8 replaces the body with the Action.Execute handler (approvals, transitions, acks).
export async function handleInvoke(
  _app: FastifyInstance,
  _activity: TeamsActivity
): Promise<AdaptiveCard> {
  return resultCard('This button is not available yet.')
}
