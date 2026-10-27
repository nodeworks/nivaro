import type { FastifyInstance } from 'fastify'
import type { User } from '../../types.js'
import type { TeamsActivity } from './activity.js'
import { resultCard } from './cards.js'
import { sendActivity } from './connector.js'

// Stub: Task 9 replaces the body with the real permission-checked Ask AI answer.
export async function answerInTeams(
  _app: FastifyInstance,
  activity: TeamsActivity,
  _asker: User
): Promise<void> {
  if (!activity.serviceUrl || !activity.conversation?.id) return
  await sendActivity(activity.serviceUrl, activity.conversation.id, {
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: resultCard('Questions arrive in the next update.')
      }
    ]
  })
}
