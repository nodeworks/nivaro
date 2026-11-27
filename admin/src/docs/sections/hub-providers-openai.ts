import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 2: OpenAI. Facts are from the adapter code:
// api/src/services/hub/providers/openai/**. Nothing here ran against a live OpenAI organization yet.

export const hubProvidersOpenaiDocs: DocSection = {
  id: 'hub-providers-openai',
  label: 'Provider: OpenAI',
  content: [
    { type: 'h1', id: 'hub-providers-openai', text: 'Provider: OpenAI — Hub mode only' },
    {
      type: 'p',
      text: 'Connection fields: a secret `adminKey` (an organization admin key: OpenAI platform, Settings, Organization, Admin keys) and an optional `organization` id (`org-…`, sent with every call). The only host is `api.openai.com`. Test checks that the key can list projects and, separately, that it can read organization costs; a key without the costs scope still works and Test says costs are missing.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`openai.project`',
          '`<projectId>`',
          'Create, rename, and archive. Archive is the delete: OpenAI cannot bring an archived project back and its service accounts and keys stop working, so the delete is `destructive` + `data_loss` (typed confirm). An archived project reads as gone.'
        ],
        [
          '`openai.service_account`',
          '`<projectId>:<serviceAccountId>`',
          'One per environment. OpenAI cannot rename one, so a new name is a replace (a new account and a new key; `destructive` + `downtime`). Delete revokes its key at once (`destructive`). Its API key is the once-only secret output `api_key`. Costed: nothing fixed each month, plus usage.'
        ],
        [
          '`openai.project_user`',
          '`<projectId>:<userId>`',
          'A person in a project, matched by email, with the role member or owner. The person must already be in the organization: the Hub never invites anyone (`USER_NOT_IN_ORG`).'
        ],
        [
          '`openai.project_rate_limit`',
          '`<projectId>:<rateLimitId>`',
          'The numbers of one model’s limit in a project (requests, tokens, images, audio megabytes per minute; requests per day; batch input tokens per day). OpenAI makes a limit for every model and never removes one, so "create" sets numbers on the existing limit and the Hub cannot delete it: dropping the resource from the Hub leaves the numbers as they are. A field left empty is not touched. Creating one, or raising a number, carries the `cost` risk (more spend can get through).'
        ],
        [
          '`openai.project_api_key`',
          '`<projectId>:<keyId>`',
          'Read, adopt and delete only (OpenAI cannot create a project key through the API: make a service account instead). Shows the redacted key and its owner. Delete is `destructive`.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Outputs: a service account gives `api_key`, a secret that OpenAI shows once, at create. The Hub seals it at once and hands it to what you bound it to: the stack secret `OPENAI_API_KEY`, or an app AI gateway credential setting (`ai_gateway_*` columns whose name holds a key or secret). If the sealed copy is lost it can only be replaced, never read back.',
        'Rotating: turn on **Make a new key now** on a service account. The Hub makes a new service account with the same name, hands its key to the bindings, then deletes the old one (its key stops working at once, `downtime`). If removing the old account fails the new key is kept and the answer says the old one was not removed.',
        'Every child is judged through its project: a change whose provider id names another project than the one it points at is refused `PROJECT_MISMATCH` before any call. A child of an archived or missing project reads as gone.',
        'A create that finds a project or service account of the same name the Hub did not make stops with `ALREADY_EXISTS`: adopt it instead. A resumed run reuses what it made.',
        'Health: a project shows what it spent today (UTC) and this month, read from the organization costs feed (daily buckets, so "today" is the current UTC day). If the costs cannot be read the project stays ok and says why.',
        'Run-rate: the adapter reports what each project used so far (one row per day and project, in cents) so usage counts in the live cost figures. The cost feed (`costs()`) comes with the Hub cost-feed task; it is not part of this adapter yet.',
        'Needs a live check: the exact response of the service account create call, the costs filter parameters, and the project and rate-limit write paths, which were written from OpenAI’s published API reference and recorded answers, not a live organization.'
      ]
    }
  ]
}
