import type { DocSection } from '../types.js'

export const queuesGuide: DocSection = {
  id: 'queues',
  label: 'Queues',
  content: [
    { type: 'h1', id: 'queues', text: 'Queues' },
    {
      type: 'p',
      text: 'A Queue is a named, filterable worklist that unions one or more sources — a collection (optionally scoped to a workflow/pipeline state), Tasks, Approvals, or a zero-config "everywhere I am resolved as an owner" source — into one normalized, actionable list. Queues come in two flavors on the same engine: admin-defined shared queues (org-wide worklists) and personal queues any user can build.'
    },
    {
      type: 'note',
      text: 'Queues do not replace Tasks or Approvals — both remain standalone pages, and both are consumable as queue sources alongside collections.'
    },
    { type: 'h3', text: 'Source types' },
    {
      type: 'table',
      head: ['Type', 'What it pulls in'],
      rows: [
        [
          'collection',
          'Rows from one collection, optionally filtered by field conditions and restricted to specific workflow/pipeline states'
        ],
        ['tasks', 'Open nivaro_tasks assigned to any user, deep-linked to the underlying record'],
        [
          'approvals',
          'Pending nivaro_approval_instances, with owners resolved from the current step’s approver or approver role'
        ],
        [
          'owned_by_me',
          'Zero-config: every record across every pipeline/workflow-bound collection where the current user resolves as an owner'
        ]
      ]
    },
    { type: 'h3', text: 'How it works' },
    {
      type: 'ul',
      items: [
        'GET /api/queues/:id/items fans out to each active source, normalizes results into a common shape (collection, item_id, label, state, owners, sla_status, at_risk, aging_hours, url), merges and dedupes by collection+item_id, and returns both the item list and aggregate stats.',
        'SLA status, at-risk flags, and pipeline owners for collection sources reuse the same batch logic that powers CollectionBrowser — computeStatusBatch, evaluateRows, and resolveStateOwners — so a queue never diverges from what you would see filtering that collection directly.',
        'Scope tabs (My Items / No Owners / All Items) are query params on the same endpoint, applied after the merge.',
        'Every new queue is seeded with one owned_by_me source, so a useful personal worklist exists with zero configuration.'
      ]
    },
    { type: 'h3', text: 'Configuring a queue' },
    {
      type: 'p',
      text: 'Open Queues in the Automation nav section. Click New Queue, then add sources — for a collection source, pick the target collection and (optionally) restrict to specific state keys. Toggle "Shared with everyone" to make a queue visible to all users rather than just its owner.'
    },
    { type: 'h3', text: 'Kanban view and claiming' },
    {
      type: 'ul',
      items: [
        "Toggle Table/Kanban at the top of a queue worklist. Kanban columns are the union of workflow state keys present among the queue's current items — dragging a card to another column resolves and executes the matching transition via the same endpoint PipelinePanel uses, so RBAC (required_roles) and condition_rules revalidate exactly as they do anywhere else. A drop with no valid transition toasts an error and the card stays put.",
        'Any viewer of a queue can Claim an unclaimed item (self-assign, support-ticket style) or Release their own claim — claiming is gated by the same visibility rule as reading the queue, not by queue ownership. For any source pointing at a real collection record with a live workflow instance — collection sources and Approvals sources alike — claiming also adds the user as a pipeline instance owner (removed again on release); only Tasks sources track claims queue-locally only, since a task has no corresponding business record to grant ownership on.',
        'A 4th scope tab, "Claimed by me", filters to items the current user has claimed in this queue.'
      ]
    },
    {
      type: 'note',
      text: 'Row scans per source are capped at 1000, matching the existing at-risk summary and SLA batch caps — a queue never performs an unbounded table scan.'
    },
    { type: 'h3', text: 'SLA escalation and workload' },
    {
      type: 'ul',
      items: [
        'A collection source can be scoped to only "Breached" or "Warning" SLA items, using the same computeStatusBatch data CollectionBrowser\'s SLA column already shows. There is no separate "Escalated" queue type — build one by creating a normal queue, adding a collection source with the SLA filter set to Breached, and sharing it with the team.',
        "The Workload view groups a queue's items by owner and shows each owner's current count against their most restrictive WIP limit (the lowest max_wip across every pipeline owner group they belong to that sets one) — the badge turns red when an owner is over limit. Set max_wip per owner group in the Owner Matrix editor (Pipelines → a state cell → Max WIP, blank = unlimited).",
        'An item with multiple owners is counted once per owner in the Workload view, matching how ownership already displays everywhere else in Queues.'
      ]
    }
  ]
}
