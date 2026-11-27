import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 2: Anthropic. Facts are from the adapter code:
// api/src/services/hub/providers/anthropic/**. Nothing here ran against a live organization yet.

export const hubProvidersAnthropicDocs: DocSection = {
  id: 'hub-providers-anthropic',
  label: 'Provider: Anthropic',
  content: [
    { type: 'h1', id: 'hub-providers-anthropic', text: 'Provider: Anthropic — Hub mode only' },
    {
      type: 'warn',
      text: 'Everything on this page exists only on a Nivaro Hub (`HUB=on`). A regular install, Nivaro Cloud and a Hub shared deployment have none of it.'
    },
    {
      type: 'p',
      text: 'One secret connection field, `credential`: an Admin API key (`sk-ant-admin…`, Console → Settings → Admin keys) or an `org:admin` OAuth token. A regular API key is refused when you save the connection. The key is the organization, so the connection is the pin. The only host is `api.anthropic.com`; every call sends `anthropic-version: 2026-10-21`.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`anthropic.workspace`',
          '`wrkspc_…`',
          'Create, rename, archive. Archive is the delete: every key in the workspace stops working and Anthropic offers no way back (`destructive` + `downtime`). The Default Workspace is never touched. Costed as usage: a workspace is free, so the estimate is a known zero plus usage.'
        ],
        [
          '`anthropic.workspace_member`',
          '`<workspace>:<user>`',
          'Add, change role, remove. The person is matched by email and must already be in the organization (the adapter does not send invitations: `USER_NOT_IN_ORG`). Changing the email or the workspace is a remove and an add.'
        ],
        [
          '`anthropic.api_key`',
          '`apikey_…`',
          'Read, adopt, rename and switch active / inactive only. **The Admin API cannot create keys.** Create the key in the Console inside the Hub-made workspace, adopt it here, then paste the key value once into the secret field `Key value`.'
        ],
        [
          '`anthropic.spend_limit`',
          '`spl_…`',
          'A monthly spend limit on a workspace (US cents), only where the organization has the Spend Limits API. Where it does not, Test says "Spend limits are not available for this organization" and the type lists nothing and refuses writes.'
        ],
        [
          '`anthropic.rate_limits`',
          '`organization` or `wrkspc_…`',
          'Read only: the limits in force, as readable lines. Change them in the Console.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'The pasted key. The adapter checks it looks like a workspace key (an Admin key is refused), that its first and last characters fit the hint the Console shows for that key (`KEY_MISMATCH` otherwise), and that the key belongs to the workspace chosen for it (`TARGET_MISMATCH`). It becomes the sealed output `api_key` and is never written to the plan, the step, the audit row or a log. The Admin API cannot show a key again, so the output is once-only: if the sealed copy is ever lost, create a new key in the Console and paste it.',
        'Binding: `api_key` → the app setting `anthropic_api_key` (a credential setting). The Hub does not push it anywhere on its own; a person sets the binding and confirms it.',
        'A create that finds a workspace of the same name, or a person already in the workspace, stops with `ALREADY_EXISTS`: adopt it instead.',
        'Health: for a workspace, cost and tokens for the last 24 hours and the month so far from the Usage and Cost Analytics API (cost in US dollars). Anthropic data lands within 4 to 24 hours, so a very young workspace reads "unknown" until it does. An inactive key is a warning.',
        'Costs: near-live workspace spend feeds the run-rate (`usageNow`, daily rows for finished days and hourly for today). The billed-cost feed is not part of this adapter yet, so Billed on the Costs tab stays empty for it.',
        'Needs a live check: the paging of the older list endpoints (the adapter follows both `next_page` and `has_more` / `last_id`), the `email` filter on the user list, the key hint format, and the Spend Limits shape for a workspace scope (the public documentation describes only the per-member Enterprise form).'
      ]
    }
  ]
}
