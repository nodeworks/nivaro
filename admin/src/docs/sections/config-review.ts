import type { DocSection } from '../types.js'

export const configReviewDocs: DocSection = {
  id: 'config-review',
  label: 'Config Review',
  content: [
    { type: 'h1', id: 'config-review', text: 'Config Review' },
    {
      type: 'p',
      text: 'The Config Review page at /config-review (System nav) is a monthly report on the configuration itself. It runs on the 1st of each month at 04:20 and tells the administrators when it finds something; Run review now runs it on demand. Every finding says why it matters and links to the editor that owns it. Where a fix is safe, the finding offers one: you see the exact change set first, apply it with the same writes the editors make, and undo it from the Fixed list. Admins only.'
    },
    { type: 'h2', id: 'config-review-review', text: 'Review — configuration problems' },
    {
      type: 'table',
      head: ['Finding', 'Why', 'One-click fix'],
      rows: [
        [
          'Contradicting field rules',
          'Two active rules on the same trigger set the same field to different values. The later rule always overwrites the earlier one, so the earlier one never takes effect.',
          'Switch off the rule that never takes effect (undo switches it back on).'
        ],
        [
          'Duplicate field rules',
          'Two active rules do exactly the same thing.',
          'Switch off the earlier one.'
        ],
        [
          'Empty fields on layouts',
          'A column empty on every record (at most 250,000 rows, at least 30 days old) still takes a row on one or more layouts.',
          'Remove it from those layouts. Each layout gets a version first; the column and its data are not touched.'
        ],
        [
          'Unused fields',
          'A visible field on no layout and empty on every record.',
          'None: check what references it before dropping it in the Table Editor.'
        ],
        [
          'Layouts nobody opens',
          'Not the active layout for its type, no slug, no conditions, and nothing (grid, drill, form, PDF, addendum) names it.',
          'None: open the Layouts tab.'
        ],
        [
          'Duplicate saved views',
          'Same filters, sort and columns for the same audience. The default view, or else the oldest, is kept.',
          'Delete the duplicate. Not offered for a default view or one somebody subscribes to.'
        ],
        [
          'Inactive owner groups',
          'Every member of an owner group is suspended or redacted and no team is linked, so nobody can act on the records it covers.',
          'None: pick replacements in the owner matrix.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'The Review list also carries the owner-filter lint, pipeline lint warnings and retired columns that are still present, so the report is one list.'
    },
    { type: 'h2', id: 'config-review-cleanup', text: 'Cleanup — things to tidy' },
    {
      type: 'ul',
      items: [
        '**Old drafts**: form drafts not saved for N months (default 3). Shows the count and storage. Delete removes up to 500 per round and keeps a copy for undo when they hold under 2 MB.',
        '**Idle tasks**: open tasks untouched for N months (default 3). Support requests are left out. Cancel marks them cancelled with a history line and notifies nobody; undo reopens the ones still cancelled.',
        '**Unreferenced files**: files no record or configuration points at, over 30 days old. Shows the storage. Delete removes up to 200 per round and cannot be undone.',
        '**Unopened views**: saved views nobody opened in N days (default 90). Default and subscribed views are left out. Opens are recorded from the view pills (one row per person and view per hour), and the check waits until opens have been recorded for the whole window.'
      ]
    },
    { type: 'h2', id: 'config-review-labels', text: 'Labels — one concept, several labels' },
    {
      type: 'p',
      text: 'The label check collects every label that names a field: the field label, layout label overrides, queue column aliases, saved-view column labels and report widget columns. When one field reads differently across them ("Req Amount", "Requisition $", "Requested"), it suggests the label used most. Pick a candidate or type your own; the preview lists every place that changes. Layouts and reports get a version first. Undo puts back only labels nobody changed since.'
    },
    { type: 'h2', id: 'config-review-ai', text: 'AI wording' },
    {
      type: 'p',
      text: 'When AI is configured, the run (on by default) asks the summarize model to re-word each reason for an administrator and to propose one label per inconsistent concept. The model sees configuration names only, never record data, and its reply is checked: only plain reason text and short labels for findings it was sent are kept. It never decides or applies a change. A re-worded reason is marked AI-worded; hover it for the check’s own words.'
    },
    {
      type: 'note',
      text: 'API: `GET /api/config-review?family=review|cleanup|label&status=open|fixed|dismissed`, `POST /api/config-review/run` (202; the page polls `running`), `GET /api/config-review/:id/preview?label=`, `POST /api/config-review/:id/apply`, `POST /api/config-review/:id/undo`, `POST /api/config-review/:id/dismiss`. A fix plans from the rows as they are now and answers 409 when the finding is stale. Fixed findings stay listed for 30 days.'
    }
  ]
}
