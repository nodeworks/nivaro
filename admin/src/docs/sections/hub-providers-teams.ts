import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 2, Task 24: Microsoft Teams. Facts are from the adapter:
// api/src/services/hub/providers/teams/** and the shared client providers/microsoft/graph.ts.
// Nothing here ran against a live tenant yet.

const HUB_ONLY =
  'Everything on this page exists only on a Nivaro Hub (`HUB=on`). A regular install, Nivaro Cloud and a Hub shared deployment have none of it.'

export const hubProvidersTeamsDocs: DocSection = {
  id: 'hub-providers-teams',
  label: 'Provider: Microsoft Teams',
  content: [
    { type: 'h1', id: 'hub-providers-teams', text: 'Provider: Microsoft Teams — Hub mode only' },
    { type: 'warn', text: HUB_ONLY },
    {
      type: 'p',
      text: 'Manages the Teams side of an app through Microsoft Graph (channels, private-channel members, website tabs) and sends Hub events into Teams. Microsoft Graph with app-only access cannot post a message into a channel, so notifications go through a notify target: a Teams Workflows webhook or the Nivaro Teams bot.'
    },
    { type: 'h2', id: 'hub-providers-teams-connection', text: 'Connection' },
    {
      type: 'p',
      text: 'Same shape as the Entra connection: `tenant_id`, `client_id` and a sealed `client_secret` (or a sealed certificate key and thumbprint). The Hub signs in with the client-credentials grant and shares the Graph client with Entra (token cached per connection, paging, Retry-After). An Entra connection’s credentials cannot be referenced: enter them again. Allowed hosts: `graph.microsoft.com`, `login.microsoftonline.com`, and the webhook hosts `*.logic.azure.com`, `*.api.powerplatform.com`, `*.webhook.office.com`.'
    },
    {
      type: 'p',
      text: 'Test reads the application permissions from the token and lists what is missing: `Group.Read.All` and `Team.ReadBasic.All` (teams), `Channel.ReadBasic.All`, `Channel.Create`, `ChannelSettings.ReadWrite.All`, `Channel.Delete.All` (channels), `ChannelMember.ReadWrite.All` and `User.Read.All` (members, matched by email), `TeamsTab.ReadWriteForTeam.All` (tabs). It also says which notify path this Hub can use: a webhook always works; the bot only when it is set up under Settings, Microsoft, Teams bot.'
    },
    { type: 'h2', id: 'hub-providers-teams-types', text: 'Resource types' },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`teams.team`',
          'team (group) id',
          'Shared, read and adopt only. The Hub never creates, changes or deletes a team.'
        ],
        [
          '`teams.channel`',
          '`<team id>:<channel id>`',
          'A standard or private channel with a name and description. Team and type cannot change (replace). A private channel needs `owner_email`: Teams will not make one without an owner. A create that finds the name already in the team is refused `ALREADY_EXISTS` (adopt it). Delete is `destructive`: Teams keeps a deleted channel 30 days, restore it there.'
        ],
        [
          '`teams.channel_members`',
          'the channel’s id',
          'People of a private channel, matched by work email. An email Entra does not know stops the change before anything is written and is listed; the Hub never guesses. Create only adds; an update also removes people not listed (`destructive`). Owners are never added or removed. Delete releases the list: nobody leaves.'
        ],
        [
          '`teams.tab`',
          '`<channel id>:<tab id>`',
          'A website tab (https address only) linking the app’s environment. Other kinds of tabs are never touched.'
        ],
        [
          '`teams.notify_target`',
          '`<mode>:<uuid>:<hash>`',
          'Sends Hub events (a notify route names it). Nothing exists at Microsoft: the Hub holds a sealed webhook address, or a bot conversation id and Bot Connector address.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-providers-teams-notify', text: 'Notify' },
    {
      type: 'ul',
      items: [
        'Webhook: from the Teams Workflows app, the template “Post to a channel when a webhook request is received”. The address must be https on a Microsoft host and a Workflows path; it is sealed at once and scrubbed (with its signature and path) from every error. The Hub POSTs one adaptive card: severity-coloured title, body and an Open in Nivaro button.',
        'Bot: the Nivaro Teams bot posts the same card into a channel or chat it is installed in. The bot token is sent only to Microsoft Bot Connector hosts (`smba.trafficmanager.net`, `*.botframework.com`, `*.teams.microsoft.com`, `*.teams.microsoft.us`), never to an address anyone typed. A bot target is `public_exposure`: Hub administrators only. The bot’s own behaviour is unchanged.',
        'A 429 is a retryable failure; a webhook or conversation that is gone is `TARGET_GONE`. Teams has no threads here, so `dedupKey` and `action` are ignored: a resolve posts a new card.',
        'Health of a webhook target is “unknown”: it cannot be checked without posting. Use the notify route’s Test button.'
      ]
    },
    {
      type: 'note',
      text: 'Not yet checked against a live tenant: creating a private channel with an application permission, and the exact Workflows webhook answer. Do a live check before relying on them.'
    }
  ]
}
