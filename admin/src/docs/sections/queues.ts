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
    { type: 'h3', text: 'Display settings' },
    {
      type: 'p',
      text: 'Per-queue display toggles live in the builder Settings tab: which views are available (Table is always on; Kanban and Workload are optional), the default view and default items scope when the queue opens, and whether the Work Next button and bulk actions are offered. These are presentation controls for viewers of the queue — they do not restrict data access. Saved views that reference a view that has since been disallowed fall back to the first allowed view.'
    },
    { type: 'h3', text: 'Kanban view and claiming' },
    {
      type: 'ul',
      items: [
        "Toggle Table/Kanban at the top of a queue worklist. Kanban columns are the union of workflow state keys present among the queue's current items — dragging a card to another column resolves and executes the matching transition via the same endpoint PipelinePanel uses, so RBAC (required_roles) and condition_rules revalidate exactly as they do anywhere else. A drop with no valid transition toasts an error and the card stays put.",
        'Claiming can be turned off per queue ("Allow claiming items" in the queue builder) — the claim column, buttons, bulk actions, and the Claimed by me tab disappear, and Work Next opens items without claiming them.',
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
    },
    { type: 'h3', text: 'Live refresh, digest, and embedding' },
    {
      type: 'ul',
      items: [
        "Every queue view live-refreshes: the browser joins a Socket.io room per collection among the queue's active sources, and re-fetches items/workload whenever any item in one of those collections is created, updated, transitioned, claimed, or released — anywhere in the app, not just from this queue view.",
        'Subscribe to a daily or weekly email digest instead of watching a queue live — the digest email includes a current snapshot (total, unowned, per-state counts) resolved fresh each time it sends, not a log of individual changes.',
        "A queue can back a public embeddable widget the same way a single collection can (Widgets page) — the embed shows the queue's current items to anyone with the link, resolved using the feed creator's read access, not the viewer's (matching how every other widget feed already works)."
      ]
    },
    { type: 'h3', text: 'Table column customization' },
    {
      type: 'ul',
      items: [
        'Each collection-type source can expose up to 5 extra fields from its collection as table columns (Queues builder → source row → "Extra columns"). Rows from a different source that didn\'t configure a given field simply show a blank cell for it — there\'s no special handling for mixed-collection queues beyond that.',
        'Every viewer can independently choose which columns are visible (Table view → "Columns" control, top right) — the choice is saved per user per queue and persists across devices. Item and Claim/Release always stay visible regardless of customization.',
        'A viewer who has never customized sees a computed default: all base columns plus the first 2 configured extra fields, so the table starts reasonably compact without any setup.',
        "An extra column can be a relation, not just a plain field — the builder's field picker lets you drill through up to 3 hops (e.g. an M2O chain like Project → Owner → Name). M2O columns show the related record's configured display template; O2M/M2M columns show up to 3 related records' display values with a \"+N more\" suffix when there are more. Relation display values are always resolved fresh from the live schema, never cached.",
        'Every visible column can be filtered and sorted, and dragged to reorder (via the "Columns" popover\'s grip handle). Filtering and sorting happen after scope-filtering but never affect the stat strip, Kanban, or Workload views — those always reflect the full scope-filtered set. Filter and sort choices reset when you leave the queue; only which columns are visible and their order persist.'
      ]
    },
    { type: 'h3', text: 'Column display formats' },
    {
      type: 'p',
      text: 'Each extra column can carry a display format, set from the gear on the column chip in the builder: date & time (preset templates or a custom token template using YYYY YY MMM MM DD HH mm ss, plus a relative option), number (decimals, thousands separator, prefix/suffix), or yes/no labels for booleans.'
    },
    {
      type: 'note',
      text: 'Formats are applied at display time only. The underlying value stays raw, so sorting and filtering on the column remain exact, and changing a format never requires re-materializing the queue.'
    },
    { type: 'h3', text: 'Stat strip filtering' },
    {
      type: 'p',
      text: 'Every tile in the stat strip is clickable. State tiles toggle a state filter, the Warning and Breached tiles toggle the SLA filter, At Risk toggles the risk filter, Unowned switches to the No Owners scope tab, and Total resets everything. The active tile is highlighted, and a second click clears its filter.'
    },
    { type: 'h3', text: 'Grouping' },
    {
      type: 'p',
      text: 'The Group control above the table groups rows by state, collection, SLA status, at-risk, owner, aging bucket (<1d / 1–3d / 3–7d / >7d), or any visible extra-field column. Group headers show a row count plus breached and at-risk chips, and each group collapses independently (an Expand all / Collapse all button sits beside the picker). Groups collapse by default when the set exceeds 200 rows. Grouping loads the full matching set — pagination pauses while grouped and resumes when grouping is turned off.'
    },
    { type: 'h3', text: 'Priority sort' },
    {
      type: 'p',
      text: 'The Priority chip orders items by urgency: SLA breached first, then SLA warning, then at-risk, then oldest within each band. Regular (non-materialized) queues default to this order — the table order is the triage order. Large materialized queues keep their normal order by default and opt into priority via the chip, which routes through the slower live-resolution path. Clicking any column header overrides priority order; clicking the chip restores it.'
    },
    { type: 'h3', text: 'Item column label' },
    {
      type: 'p',
      text: 'Each collection source can set an Item label template — e.g. {{project_id}} — {{title}} — controlling what the Item column (and kanban card title) shows. Tokens are direct fields of the source collection. Left empty, the collection\'s display template applies, falling back to the first of title/name/label/subject.'
    },
    { type: 'h3', text: 'Source filters' },
    {
      type: 'ul',
      items: [
        'Each collection source can carry static field filters (field + operator + value, ANDed together) — e.g. amount > 1000, category not equals archived. Only real table columns are filterable; relation and computed fields are excluded.',
        'The States row restricts a source by workflow state with an Include/Exclude toggle. "Exclude: completed" keeps working when the workflow later gains new states. A "(No state)" option targets items without a workflow state: include it to pull stateless items in, exclude it to drop them (without it, stateless items drop in include mode and stay in exclude mode).',
        'Saving sources on a large (materialized) queue automatically rebuilds its cache with the new filters applied.'
      ]
    },
    { type: 'h3', text: 'Triage: side sheet, keyboard, Work Next' },
    {
      type: 'ul',
      items: [
        "Clicking a row (or kanban card) opens a side sheet with the item's meta, extra fields, available workflow transitions, claim/release, and comments — handle items without leaving the queue. The Open link (or the o key) jumps to the full record.",
        'Keyboard triage in Table view: j/k (or arrows) move the highlight, Enter opens the sheet, c claims/releases, o opens the full record, Esc closes the sheet.',
        'Work Next claims the most urgent unclaimed item (following the current table order) and opens it; the sheet\'s Next button advances to the following item. It never auto-releases — releasing or transitioning stays an explicit action.'
      ]
    },
    { type: 'h3', text: 'Saved views and bulk actions' },
    {
      type: 'ul',
      items: [
        'Save the current scope + filters + sort + grouping + view mode as a named view (+ Save view); views appear as pills and can be shared with everyone. Views are per-queue.',
        'Selecting rows (checkboxes) opens a floating bar: bulk Claim, Release, or Transition to a target state. Transitions apply per item under the same permission and condition rules as dragging a card — a summary toast reports successes and skips.'
      ]
    },
    { type: 'h3', text: 'Kanban swimlanes and live updates' },
    {
      type: 'ul',
      items: [
        'The Lanes control on the Kanban view adds horizontal lanes by collection or owner, crossed with the state columns. Lanes collapse individually.',
        'When other users change items in this queue, an N updates · Refresh pill appears instead of the board reloading under you — click it to refresh.'
      ]
    },
    { type: 'h3', text: 'Trends' },
    {
      type: 'p',
      text: 'A nightly snapshot records each queue\'s totals (total, unowned, SLA warning/breached, at risk, per-state counts). Stat tiles show a 14-day sparkline and a delta versus the last snapshot — rising breached/at-risk counts render red, falling ones green. Trends appear after the first nightly snapshot.'
    }
  ]
}
