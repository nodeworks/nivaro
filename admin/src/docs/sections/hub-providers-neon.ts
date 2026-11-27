import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 2: Neon. Facts are from the adapter code:
// api/src/services/hub/providers/neon/**. Nothing here ran against a live Neon organisation yet.

export const hubProvidersNeonDocs: DocSection = {
  id: 'hub-providers-neon',
  label: 'Provider: Neon',
  content: [
    { type: 'h1', id: 'hub-providers-neon', text: 'Provider: Neon — Hub mode only' },
    {
      type: 'warn',
      text: 'Everything on this page exists only on a Nivaro Hub (`HUB=on`). A regular install, Nivaro Cloud and a Hub shared deployment have none of it.'
    },
    {
      type: 'p',
      text: 'Connection fields: `orgId` (`org-…`, pinned: every list, create and read is limited to this organization) and a secret `apiKey` (an organization API key). The only host is `console.neon.tech`. Neon cannot list what a key may do, so Test checks that the key can list the organization’s projects and says write access is assumed from that. A project that belongs to another organization reads as missing and is refused (`NEON_OUT_OF_ACCOUNT`) on any write; branches, endpoints, databases and roles are judged through their project.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`neon.project`',
          '`<projectId>`',
          'Name, region and Postgres version (both set at create only) and history retention. Delete is `destructive` + `data_loss`. Costed: the estimate is the project’s storage plus usage, with the plan’s prices in the note.'
        ],
        [
          '`neon.branch`',
          '`<projectId>/<branchId>`',
          'One per environment. Name, protected flag and a parent (a branch id or name, at create only; empty = the primary branch). No compute is made with a branch: an endpoint is its own resource. **Reset from parent** is a one-shot trigger that restores the parent’s current data over the branch: `data_loss`, typed confirm. Delete is `destructive` + `data_loss` (typed confirm) and final: the Hub takes no snapshot (a child branch would block its own parent’s delete) and cannot bring the data back. A delete is blocked with `BRANCH_HAS_CHILDREN` while the branch has child branches, at plan time (the branch shows a child count) and again when applied. The primary branch cannot be deleted.'
        ],
        [
          '`neon.endpoint`',
          '`<projectId>/<endpointId>`',
          'Compute on a branch: minimum and maximum compute units, autosuspend (0 = Neon’s default, -1 = never) and pooling. Changing the size is `downtime`; delete is `destructive` + `downtime`. One endpoint per branch and type. Costed: a compute that never suspends is a known figure at its minimum size; one that suspends is usage.'
        ],
        [
          '`neon.database`',
          '`<projectId>/<branchId>/<name>`',
          'Name and owner role. Delete is `destructive` + `data_loss`.'
        ],
        [
          '`neon.role`',
          '`<projectId>/<branchId>/<name>`',
          'Create and delete only; the password is an output. Delete is `destructive`.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Outputs: a branch and a database give `database_url` (pooled), `host`, `database`, `user` and `password` (a branch uses its first database and that database’s owner); a role gives `user` and `password`. The URL and the password are secret outputs. Neon shows a role’s password again on request, so none is once-only and the Hub can re-read them.',
        'A create that finds a project, branch, database, role or endpoint the Hub did not make stops with `ALREADY_EXISTS`: adopt it instead. A resumed run reuses what it made.',
        'Neon runs most writes as operations. The Hub waits a short time for them; a locked project (423) or a slow operation is retryable.',
        'Estimates use a dated price table bundled with the adapter (Neon has no price API) and the plan read from the project’s owner. An organization on a contract plan is "No estimate".',
        'Needs a live check: the restore call behind "Reset from parent", the endpoint and operation paths, The bundled prices were copied by hand and should be compared with Neon’s pricing page.'
      ]
    }
  ]
}
