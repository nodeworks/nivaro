import type { Extension } from '@nivaro/api/extensions/loader'

const extension: Extension = {
  id: 'example-notification-channel',

  async register({ notificationChannels, logger }) {
    // Delivers Nivaro notifications to a Slack webhook.
    // Set SLACK_WEBHOOK_URL in your .env file.
    const webhookUrl = process.env.SLACK_WEBHOOK_URL

    if (!webhookUrl) {
      logger.warn('SLACK_WEBHOOK_URL not set — Slack notification channel disabled')
      return
    }

    notificationChannels.register({
      id: 'slack',
      label: 'Slack',

      async deliver({ subject, message, collection, item }) {
        const text = [`*${subject}*`, message, collection && item ? `_${collection} #${item}_` : '']
          .filter(Boolean)
          .join('\n')

        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        })
      }
    })
  }
}

export default extension
