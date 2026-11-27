import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 2: Slack. Facts are from the adapter code:
// api/src/services/hub/providers/slack/**. Nothing here ran against a live Slack workspace yet.

export const hubProvidersSlackDocs: DocSection = {
  id: 'hub-providers-slack',
  label: 'Provider: Slack',
  content: [
    { type: 'h1', id: 'hub-providers-slack', text: 'Provider: Slack — Hub mode only' },
    {
      type: 'p',
      text: 'Connection fields: `team_id` (the workspace id, `T0123ABCD`, pinned) and a secret `token` (a bot token, `xoxb-…`, from a Slack app you install). The only host is `slack.com`. Every operation first checks, once per ten minutes, that the token belongs to the pinned workspace and refuses with `SLACK_OUT_OF_ACCOUNT` otherwise; channels of another workspace, direct messages and group DMs read as missing. Test lists which of these scopes the token has: `channels:manage`, `channels:read`, `groups:write`, `groups:read`, `chat:write`, `users:read`, `users:read.email`, `bookmarks:write`, `bookmarks:read`.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`slack.channel`',
          '`<channel id>`',
          'Name, topic, purpose and visibility (public or private). Delete **archives** the channel; the Hub unarchives it again if the resource is back in a plan. Changing visibility needs an Enterprise Grid org-level token with `admin.conversations:write`; private → public is a `public_exposure` (admin approval). A channel is the only resource that can send Hub events.'
        ],
        [
          '`slack.channel_members`',
          '`<channel id>`',
          'People matched by their Slack email (typically the app’s owners). Additive: it invites the listed people who are not in the channel and never removes anyone. Emails Slack does not know are listed in the result (`unmatched`) and never guessed. Removing the resource stops managing it; the members stay.'
        ],
        [
          '`slack.bookmark`',
          '`<channel id>/<bookmark id>`',
          'A link in a channel’s bookmark bar (the app’s environments or its Hub page). The link must be https.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Notify: a route through a `slack.channel` resource posts with `chat.postMessage` as a Block Kit card (title, body, severity line and an "Open in the Hub" button when the link is https). Text is escaped so a title or body cannot make a link or a mention. A message with a `dedupKey` (a Hub incident) opens one thread; later updates and the resolve reply in it. The thread is remembered in the connection’s in-memory token cache for 14 days: after a Hub restart the next message of an old incident starts a new thread.',
        'A rate limit (HTTP 429, or Slack’s `ratelimited`) is retryable and the text carries Retry-After; a refusal such as `missing_scope` is not.',
        'A create that finds a channel with the name already taken, or a bookmark with the same link, stops with `ALREADY_EXISTS`: adopt it instead. A resumed run reuses what it made.',
        'A private channel only shows up for the Hub when the bot is a member. Slack costs nothing per resource, so no type is costed.',
        'Needs a live check: the `admin.conversations.convertToPublic` and `convertToPrivate` calls (Enterprise Grid only) and the thread behaviour on a real incident.'
      ]
    }
  ]
}
