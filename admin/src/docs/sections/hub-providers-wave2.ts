import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 2 overview (Task 31): outputs, bindings and notify routes
// (Task 13) and the rules people meet in every plan. Facts are from the merged code:
// api/src/services/hub/providers/{types,notify,notify-hook}.ts, engine/bindings.ts,
// services/hub-link/settings-allow.ts, routes/hub-provider-outputs.ts and each adapter.

const HUB_ONLY =
  'Everything on this page exists only on a Nivaro Hub (`HUB=on`). A regular install, Nivaro Cloud and a Hub shared deployment have none of it.'

export const hubProvidersOutputsDocs: DocSection = {
  id: 'hub-providers-outputs',
  label: 'Outputs, bindings and notify routes',
  content: [
    {
      type: 'h1',
      id: 'hub-providers-outputs',
      text: 'Outputs, bindings and notify routes — Hub mode only'
    },
    { type: 'warn', text: HUB_ONLY },
    {
      type: 'p',
      text: 'Some resources hand something out when they are made: a database URL, an API key, a DSN. The Hub calls these **outputs**. It seals each value at once, shows only a short fingerprint, and can carry it to where the app reads it (a **binding**). Some resource types can also send the Hub’s own events (a **notify route**).'
    },
    { type: 'h2', id: 'hub-providers-outputs-what', text: 'Outputs' },
    {
      type: 'ul',
      items: [
        'The value is stored sealed (`nivaro_hub_resource_outputs`). It is never part of the observed state, a plan, a step, an audit row or an error, and no API answer carries it: the outputs card shows Held, the first characters of a fingerprint, and Secret and Shown once chips.',
        '**Once only** means the provider shows the value one time, when it is made. If the sealed copy is ever lost the card says Lost and the value cannot be read again: use **Rotate** (the trigger field `rotate_outputs`, "Make a new key now"), which plans a new value and hands it to the bindings. An output the provider shows again (a Neon URL, an Upstash URL, a PagerDuty routing key, a SendGrid DNS list) is re-read when a binding needs it.',
        'Deleting the resource deletes its outputs. A plain output (host, bucket name, client id) is not secret.'
      ]
    },
    {
      type: 'table',
      head: ['Resource type', 'Outputs', 'Once only'],
      rows: [
        [
          '`neon.branch`, `neon.database`',
          '`database_url`, `host`, `database`, `user`, `password`',
          'None'
        ],
        ['`neon.role`', '`user`, `password`', 'None'],
        ['`upstash.redis_database`, `redis-cloud.database`', '`redis_url`', 'None'],
        [
          '`cloudflare.r2_bucket`',
          '`endpoint`, `bucket`, `access_key_id`, `secret_access_key`',
          'The two keys'
        ],
        ['`cloudflare.tunnel`', '`tunnel_token`, `tunnel_id`, `cname_target`', 'None'],
        ['`cloudflare.access_application`', '`aud`', 'None'],
        ['`entra.app_registration`', '`client_id`, `tenant_id`', 'None'],
        ['`entra.client_secret`', '`client_secret`', 'Yes'],
        ['`openai.service_account`', '`api_key`', 'Yes'],
        ['`anthropic.api_key`', '`api_key` (pasted once, see the Anthropic page)', 'Yes'],
        ['`sendgrid.api_key`', '`api_key`, `smtp_host`, `smtp_port`, `smtp_user`', '`api_key`'],
        ['`sendgrid.sender`', '`smtp_from`', 'None'],
        ['`sendgrid.domain_authentication`', '`dns_records` (JSON)', 'None'],
        ['`pagerduty.integration`', '`routing_key`', 'None'],
        ['`stripe.webhook_endpoint`', '`signing_secret`', 'Yes'],
        [
          '`twilio.phone_number`, `twilio.messaging_service`, `twilio.api_key`',
          '`phone_number`, `account_sid`, `messaging_service_sid`, `sid`, and the key `secret`',
          'The key secret'
        ],
        ['`livekit.api_key`', '`api_key`, `api_secret`, `url`', '`api_secret`'],
        [
          '`gitlab.deploy_token`, `gitlab.runner`',
          '`token` (and `username` for a deploy token)',
          '`token`'
        ],
        ['`sentry.client_key`', '`dsn`', 'None'],
        [
          '`aws.ses_smtp_user`',
          '`smtp_host`, `smtp_port`, `smtp_user`, `smtp_pass`',
          '`smtp_user`, `smtp_pass`'
        ],
        ['`aws.secret`', '`value`, `arn`', 'None']
      ]
    },
    { type: 'h2', id: 'hub-providers-outputs-bindings', text: 'Bindings: where an output goes' },
    {
      type: 'p',
      text: 'On a resource row with outputs, the key button opens the outputs card. **Where they go** lists the bindings; **Bind** takes an output, an environment and a destination. A binding is written when the output is made or changes, and again when it is rotated. It never applies anything by itself.'
    },
    {
      type: 'table',
      head: ['Destination', 'What happens'],
      rows: [
        [
          'Stack setting',
          'Written through the Stack panel’s own rules (known keys only). A secret output can never go here (`SECRET_TO_PLAIN`). The environment shows **Needs Apply now**; the stack is not deployed.'
        ],
        [
          'Stack secret',
          'Written into the stack’s sealed secrets, for example `OIDC_CLIENT_SECRET` or `OPENAI_API_KEY`. Not deployed: the environment shows **Needs Apply now** until you apply.'
        ],
        [
          'App setting',
          'Sent over the Hub link to `POST /api/hub-link/settings/apply` (the shared deployment link has a twin). Only these keys are accepted; one other key refuses the whole request (`SETTING_NOT_ALLOWED`): `smtp_host`, `smtp_port`, `smtp_user`, `smtp_pass`, `smtp_from`, `sms_provider`, `sms_account_sid`, `sms_auth_token`, `sms_from`, `sms_region`, `anthropic_api_key`, `sentry_dsn`, `huddle_livekit_url`, `huddle_livekit_key`, `huddle_livekit_secret` and the `ai_gateway_*` columns. A secret output may land only in a credential key (`smtp_pass`, `sms_auth_token`, `anthropic_api_key`, the LiveKit key and secret, the gateway client secret, or an `ai_gateway_*` key or secret). An app without the column answers `SETTING_NOT_ON_THIS_APP`; `sentry_dsn` has no home in Nivaro yet, so it always does.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Each destination has one source. A binding shows its state: Written, Writing, Out of date, Needs Apply now or Not written, with the reason.',
        'Owners bind only a resource of their own app, only to that app’s environments, and production only when the app lets owners deploy to production. A shared resource is administrators only. A resource of one app never feeds another app. `SESSION_SECRET` and `ENCRYPTION_KEY` can never be bound.',
        'The app’s activity log names the keys that were set, never the values.'
      ]
    },
    { type: 'h2', id: 'hub-providers-outputs-notify', text: 'Notify routes: Hub events out' },
    {
      type: 'p',
      text: 'A notify route (Connections → Notify routes) sends chosen Hub events through a resource of a type that can send. That is a Slack channel, a Teams notify target, a PagerDuty integration, a SendGrid sender, or a Twilio phone number or messaging service.'
    },
    {
      type: 'table',
      head: ['Event', 'Default severity', 'Sent when'],
      rows: [
        ['Deploy started', 'Info', 'A promotion starts'],
        ['Deploy finished', 'Info', 'A promotion ends well'],
        ['Deploy failed', 'Critical', 'A promotion ends badly'],
        [
          'Incident opened / resolved',
          'Critical / Info',
          'An incident opens or is resolved; one incident is one Slack thread or one PagerDuty incident'
        ],
        ['Approval needed', 'Warning', 'An owner’s provider change waits for an administrator'],
        [
          'Drift found',
          'Warning',
          'A managed resource starts to differ from what the Hub made, or disappears'
        ],
        ['Backup failed', 'Critical', 'Any backup data run fails'],
        ['Certificate expiring', 'Warning', 'An expiry warning level of the TLS watch is sent'],
        ['Over budget', 'Warning', 'An app’s forecast crosses 80 % or 100 % of its budget'],
        ['Domain expiring', 'Warning', 'In the list, but nothing sends it yet']
      ]
    },
    {
      type: 'ul',
      items: [
        'Who may make a route: a Hub-wide route is administrators only. An app route is an administrator or one of that app’s owners, and an owner only through a sending resource of that same app.',
        'Sending is in the background, ten seconds at most per route, side by side. A failure never delays a deploy, an incident or an approval; the outcome (Sent X ago, or Failing with the scrubbed reason) is on the route, and **Test** sends a sample. There is no retry.',
        'Per sender: Slack posts a card and threads one incident; Teams posts an adaptive card to a Workflows webhook or the Nivaro bot (Microsoft Graph cannot post into a channel with app-only access); PagerDuty triggers and resolves one incident per Hub incident; SendGrid mails each address on the sender’s list; Twilio texts only critical events unless you switch that off.'
      ]
    }
  ]
}

export const hubProvidersRulesDocs: DocSection = {
  id: 'hub-providers-rules',
  label: 'Rules you meet in a plan',
  content: [
    { type: 'h1', id: 'hub-providers-rules', text: 'Rules you meet in a plan — Hub mode only' },
    { type: 'warn', text: HUB_ONLY },
    {
      type: 'p',
      text: 'Every provider change is a plan first. The plan names its risks in plain words and says who must start it. The same rules apply to every provider; each provider page lists the cases that are its own.'
    },
    { type: 'h2', id: 'hub-providers-rules-risk', text: 'Risk flags' },
    {
      type: 'table',
      head: ['Flag', 'Meaning', 'What it asks for'],
      rows: [
        [
          'Destructive',
          'Something is deleted, archived or replaced and may not come back (an OpenAI project, a Twilio number, a Neon branch).',
          'A typed confirm of the resource’s name'
        ],
        [
          'Data loss',
          'Data goes with it (a Neon database, a Redis Cloud database, a PagerDuty service’s history).',
          'A typed confirm'
        ],
        [
          'Downtime',
          'Something stops working while the change runs (a rotated key whose old one stops at once, a changed Entra app role).',
          'A typed confirm in a production environment'
        ],
        [
          'Cost',
          'The change adds spend (a bought number, a raised rate limit, a larger compute).',
          'An administrator approves an owner’s change, unless the auto-approve amount covers it'
        ],
        [
          'Public exposure',
          'More people or the internet can reach it, or protection is weakened (a private Slack channel made public, a Teams bot target, an application permission requested in Entra, Snyk monitoring switched off, an ignore with no expiry).',
          'An administrator'
        ]
      ]
    },
    {
      type: 'p',
      text: 'The risk is judged on what the Hub **sends** the provider, not on a field’s label: a passthrough that allows everyone counts as everyone.'
    },
    { type: 'h2', id: 'hub-providers-rules-admin', text: 'Administrator-only cases' },
    {
      type: 'ul',
      items: [
        'Shared resources (a Twilio subaccount, a SendGrid domain authentication, a Redis Cloud subscription, the Entra and Teams read-only types) and anything in production for an app that does not let owners deploy to production.',
        'Every change through a Stripe connection in live mode, whatever the change. A key whose mode the Hub cannot read counts as live.',
        'A Twilio API key made in the main account (no subaccount) and a Teams bot target.',
        'A costed change by an owner, and any change whose cost the Hub could not work out.',
        'Binding a shared resource, and a Hub-wide notify route.'
      ]
    },
    { type: 'h2', id: 'hub-providers-rules-never', text: 'What the Hub never does' },
    {
      type: 'ul',
      items: [
        'It never changes something it did not make. A create that finds a same-name resource stops with `ALREADY_EXISTS` and points you to **Adopt**; it does not patch or bind it, and it never weakens a setting on such a match.',
        'It stays inside one account, organization, team or tenant per connection: an id from another one reads as missing or is refused (`…_OUT_OF_ACCOUNT`).',
        'It never invites a person or guesses an address. People are matched by email, and an unknown email stops the change and is named.',
        'It never shows a secret again: a once-only value that is lost is rotated, never read back. Provider error text is scrubbed of the connection’s secrets before it is cut.',
        'It never grants consent or moves money: Entra admin consent, Stripe charges and refunds are a person’s step.',
        'A named step (promote, dispatch, point) runs only on the target its plan named (`TARGET_MISMATCH`).'
      ]
    }
  ]
}
