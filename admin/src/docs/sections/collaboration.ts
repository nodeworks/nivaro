import type { DocSection } from '../types.js'

export const collabTasks: DocSection = {
  id: 'tasks',
  label: 'Tasks',
  content: [
    { type: 'h1', id: 'tasks', text: 'Tasks' },
    {
      type: 'p',
      text: 'A task is a piece of work on one record: a title, optional details, a person or a team, a due date and a priority. Tasks live in `nivaro_tasks`, show in the Tasks slot of the record form, in My Work, on the admin Tasks page, as a column in collection browsers and queues, and in the daily summary. Every change writes a plain sentence to the task history ("Reassigned to Sam Lee", "Due moved to Oct 3", "Marked done").'
    },
    { type: 'h3', id: 'tasks-who-sees', text: 'Who can see a task' },
    {
      type: 'ul',
      items: [
        'A task is readable by anyone who can open its record: role permission, row filters and User Scopes all apply. A task on a record outside your scope answers 404.',
        'Without a record filter, a non-admin lists only tasks they were given, asked for, or that sit with one of their teams.',
        'Support requests (kind `support`) stay private to the person who asked and the administrators working them.'
      ]
    },
    { type: 'h3', id: 'tasks-creating', text: 'Creating a task' },
    {
      type: 'pre',
      code: `POST /api/tasks
{
  "collection": "orders",
  "item": "42",
  "title": "Attach the vendor quote",
  "description": "The PDF from the supplier",
  "assignee": "<user uuid>",        // or "team_id": 12 for a team task
  "due_date": "2026-10-09",
  "priority": "urgent",             // low | normal | urgent
  "done_when": [{ "field": "signed_quote", "op": "nnull" }]
}`
    },
    {
      type: 'ul',
      items: [
        'An assignee who is out of office with a working delegate is swapped for the delegate; the history says so.',
        'A team task has no assignee. Everyone on the team is told, it shows in their My Work "Your teams" lane, and the first person to press Pick it up (`POST /api/tasks/:id/claim`) takes it. A second claim answers 409.',
        '`done_when` closes the task by itself once the record matches every condition (ops eq, neq, in, nnull, null, gt, gte, lt, lte, plus related_some / related_none for child rows). It is checked after each write to the record and by an hourly sweep; the history reads "Closed automatically — Signed quote was entered".'
      ]
    },
    { type: 'h3', id: 'tasks-api', text: 'API' },
    {
      type: 'pre',
      code: `GET  /api/tasks?collection=&item=&assignee=me&status=active|open|in_progress|done|cancelled|all
                &priority=&due=overdue|today|week|none&search=&limit=
GET  /api/tasks/mine                 # open tasks assigned to you
GET  /api/tasks/team                 # unclaimed tasks on your teams
GET  /api/tasks/requested            # tasks you asked for, still open (and recently finished)
GET  /api/tasks/people?collection=&item=   # "On this record": current owners + people fields
POST /api/tasks/counts { collection, ids }  # { id: { open, overdue } } for a page of records
GET  /api/tasks/:id
GET  /api/tasks/:id/history
PATCH /api/tasks/:id   { title, description, assignee, due_date, priority, status, done_when }
POST /api/tasks/:id/complete
POST /api/tasks/:id/claim
POST /api/tasks/:id/nudge { note? }   # once a day; a second nudge answers 429 NUDGE_TOO_SOON
DELETE /api/tasks/:id`
    },
    {
      type: 'p',
      text: 'The SDK carries the same set (`listTasks`, `listTeamTasks`, `listRequestedTasks`, `readTaskHistory`, `readTaskCounts`, `createTask`, `updateTask`, `claimTask`, `nudgeTask`). In GraphQL every collection type has a `tasks(status: String)` field.'
    },
    { type: 'h3', id: 'tasks-record', text: 'Following the record' },
    {
      type: 'ul',
      items: [
        'Deleting a record cancels its open tasks; restoring it from trash reopens them.',
        "Merging two records moves the duplicate's tasks onto the record that stays.",
        'Filter any list by `$has_tasks` (open tasks) or `$has_tasks: "overdue"`; the collection browser and queue tables offer an Open tasks column with the same filter.'
      ]
    },
    { type: 'h3', id: 'tasks-reminders', text: 'Reminders and escalation' },
    {
      type: 'ul',
      items: [
        'At 07:30 each open task due tomorrow reminds its assignee once.',
        "A task overdue by `TASK_OVERDUE_ESCALATE_DAYS` (default 3) tells the person who asked for it and the assignee's manager, once.",
        'The daily summary lists your overdue and due-today tasks.',
        'From My Work, the "Waiting on others" lane lists tasks you asked for; Nudge reminds the assignee.'
      ]
    },
    { type: 'h3', id: 'tasks-automation', text: 'Automation' },
    {
      type: 'ul',
      items: [
        'Flow triggers `task-created`, `task-reassigned` and `task-completed` carry the task, the record and the people involved.',
        'Webhooks can subscribe to `nivaro_tasks` for the same three events.',
        'The flow op `task` and the rule action "Create a task" create one: a named assignee (id or email), the record\'s current owners (one task each), or a team; with a due offset in days, a priority and an optional `done_when`.',
        'Ask AI can propose a task ("remind Sam to attach the signed quote on order 42 by Friday"); nothing is created until you approve the card. Ask AI can also list your open tasks.'
      ]
    },
    { type: 'h3', id: 'tasks-status-workflow', text: 'Statuses' },
    {
      type: 'ul',
      items: [
        '`open` and `in_progress` are active: they count toward the open-task column, reminders and `$has_tasks`.',
        '`done` records who finished it (`completed_by`) and when.',
        '`cancelled` is what a deleted record does to its open tasks.'
      ]
    }
  ]
}

export const collabApprovals: DocSection = {
  id: 'approval-chains',
  label: 'Approval Chains',
  content: [
    { type: 'h1', id: 'approval-chains', text: 'Approval Chains' },
    {
      type: 'p',
      text: 'Define formal multi-step approval workflows for records. Approval chains enforce sequential sign-off: each step in the chain must approve before the next activates. A rejection immediately stops the chain and notifies the initiator. Approvers can add comments, and the full decision log is immutable.'
    },
    {
      type: 'h3',
      id: 'approvals-setup',
      text: 'Setting Up Approval Chains'
    },
    {
      type: 'p',
      text: 'Define a chain in Approvals → Create Chain. Specify the name, target collection, and ordered list of approvers (can be specific users or roles). Each step can have a custom label and optional due-date deadline.'
    },
    {
      type: 'pre',
      code: `POST /api/approvals/chains
{
  "name": "Purchase Order Sign-Off",
  "collection": "purchase_orders",
  "steps": [
    {
      "order": 1,
      "label": "Department Manager",
      "approver_type": "role",
      "approver_id": "role-dept-manager",
      "due_days": 3
    },
    {
      "order": 2,
      "label": "Finance Director",
      "approver_type": "user",
      "approver_id": "user-finance-cfo",
      "due_days": 5
    },
    {
      "order": 3,
      "label": "CEO Approval",
      "approver_type": "user",
      "approver_id": "user-ceo",
      "due_days": 7
    }
  ]
}

// Response
{
  "id": "chain-123",
  "name": "Purchase Order Sign-Off",
  "collection": "purchase_orders",
  "created_by": "user-456"
}`
    },
    {
      type: 'h3',
      id: 'approvals-instances',
      text: 'Starting and Managing Instances'
    },
    {
      type: 'p',
      text: 'Start an approval instance on a record to begin the chain. The first step activates immediately and its approver is notified.'
    },
    {
      type: 'pre',
      code: `POST /api/approvals/instances
{
  "chain_id": "chain-123",
  "collection": "purchase_orders",
  "item_id": "po-789"
}

// Response
{
  "id": "instance-456",
  "chain_id": "chain-123",
  "item_id": "po-789",
  "current_step": 1,
  "status": "in_progress",
  "created_at": "2026-06-15T10:30:00Z",
  "initiated_by": "user-initiator"
}`
    },
    {
      type: 'h3',
      id: 'approvals-decisions',
      text: 'Approving or Rejecting'
    },
    {
      type: 'pre',
      code: `POST /api/approvals/instances/instance-456/decide
{
  "decision": "approve",
  "comment": "Looks good, confirmed budget exists"
}

// Or reject
{
  "decision": "reject",
  "comment": "Need updated vendor quotes before approval"
}

// Response
{
  "id": "decision-789",
  "instance_id": "instance-456",
  "step": 1,
  "decision": "approve",
  "decided_by": "user-manager",
  "decided_at": "2026-06-15T14:20:00Z",
  "comment": "Looks good, confirmed budget exists"
}`
    },
    {
      type: 'h3',
      id: 'approvals-status-flow',
      text: 'Status Flow'
    },
    {
      type: 'ul',
      items: [
        'in_progress: chain is active, waiting on current step approver',
        'approved: all steps approved; chain complete',
        'rejected: a step rejected the request; chain halted, cannot proceed',
        'expired: due-date deadline passed on a step; manually approve/reject required'
      ]
    },
    {
      type: 'h3',
      id: 'approvals-api',
      text: 'API Reference'
    },
    {
      type: 'pre',
      code: `POST /api/approvals/chains
  Create chain (admin)

GET /api/approvals/chains?collection=X
  List chains for collection

PATCH /api/approvals/chains/:id
  Update chain (admin)

DELETE /api/approvals/chains/:id
  Delete chain (admin)

POST /api/approvals/instances
  Start new instance on a record

GET /api/approvals/instances?item=X&collection=Y
  Get instance for a record

POST /api/approvals/instances/:id/decide
  Approve or reject current step

GET /api/approvals/decisions?instance=X
  Get all decisions (audit log)`
    },
    {
      type: 'h3',
      id: 'approvals-ui',
      text: 'UI Components'
    },
    {
      type: 'ul',
      items: [
        'ApprovalPanel on item edit: shows all steps (pending/approved/rejected), current step highlighted, decide button for approver',
        'Approvals page: master list of all chains and active instances per collection',
        'Decision badges: checkmark (approved), X (rejected), clock (pending), alert (expired)'
      ]
    },
    {
      type: 'note',
      text: 'Rejections are terminal — once a step rejects, the entire instance cannot proceed. Create a new instance to restart.'
    }
  ]
}

export const collabItemLocking: DocSection = {
  id: 'item-locking',
  label: 'Item Locking & Presence',
  content: [
    { type: 'h1', id: 'item-locking', text: 'Item Locking & Presence' },
    {
      type: 'p',
      text: 'Prevent simultaneous editing conflicts with soft item locks. When a user opens a record for editing, a 5-minute TTL lock is acquired. Other users attempting to edit see an amber banner and the form switches to read-only. Locks auto-release after 5 minutes without activity, preventing stale locks from crashed tabs.'
    },
    { type: 'h3', id: 'draft-recovery', text: 'Unsaved-draft recovery' },
    {
      type: 'p',
      text: 'The record form keeps a copy of your unsaved work in the browser (IndexedDB, per record and per user): the fields you changed, staged grid rows, edits and removals, and staged relation links — written about a second after each change and removed the moment the form is clean, saved, or you discard it. If the tab crashes, the session expires or you navigate away, the next time you open that record (or the new-record form for that collection) a banner offers "Restore your unsaved changes from N min ago" with the diff (field: was → will be) and staged counts; nothing is applied until you choose Restore. A draft whose values now match the saved record is dropped silently, and the banner flags when the record changed underneath the draft. On a new-record form only the fields you actually touched are kept — layout defaults and prefills are not treated as your work.'
    },
    {
      type: 'h3',
      id: 'item-locking-how-it-works',
      text: 'How Locking Works'
    },
    {
      type: 'ul',
      items: [
        'User opens item editor → client POSTs to acquire lock',
        'Lock created in `nivaro_item_locks` with 5-minute TTL',
        'Client heartbeat endpoint called every 2.5 minutes to refresh TTL',
        'On close/navigate away, lock is deleted via DELETE',
        'If lock already held, acquiring user gets 409 Conflict with holder info',
        'After 5 minutes of no heartbeat, lock auto-expires'
      ]
    },
    {
      type: 'h3',
      id: 'item-locking-api',
      text: 'API Reference'
    },
    {
      type: 'pre',
      code: `GET /api/item-locks/:collection/:item/lock
  # Get current lock state

{
  "data": null,  // Item is free (can acquire)
  "disabled": false
}

// OR (if locked)

{
  "data": {
    "user_id": "user-123",
    "locked_by_name": "Sarah Chen",
    "locked_at": "2026-06-15T10:00:00Z",
    "expires_at": "2026-06-15T10:05:00Z",
    "is_mine": false
  },
  "disabled": false
}`
    },
    {
      type: 'pre',
      code: `POST /api/item-locks/:collection/:item/lock
  # Acquire lock (or refresh if already held)

// Success (200)
{
  "data": {
    "user_id": "current-user",
    "is_mine": true,
    "expires_at": "2026-06-15T10:05:00Z"
  }
}

// Conflict (409) — already locked by someone else
{
  "error": "Item is locked",
  "data": {
    "locked_by_name": "Sarah Chen",
    "expires_at": "2026-06-15T10:05:00Z"
  }
}`
    },
    {
      type: 'pre',
      code: `POST /api/item-locks/:collection/:item/heartbeat
  # Extend TTL by 5 minutes (called every 2.5 min while editing)

DELETE /api/item-locks/:collection/:item/lock
  # Release lock (called on close/navigate away)
  # Admin can use ?force=true to break any lock`
    },
    {
      type: 'h3',
      id: 'item-locking-configuration',
      text: 'Per-Collection Configuration'
    },
    {
      type: 'p',
      text: 'Locking can be enabled/disabled per collection in Data Model → (collection) → Settings → "Item locking". Default is ON.'
    },
    {
      type: 'pre',
      code: `GET /api/item-locks/config/:collection
  # { item_locking_enabled: boolean }

PATCH /api/item-locks/config/:collection
  # { item_locking_enabled: false } — admin only
  # Disabling immediately releases all active locks`
    },
    {
      type: 'h3',
      id: 'item-locking-ui-behavior',
      text: 'UI Behavior'
    },
    {
      type: 'ul',
      items: [
        'Amber banner: "Being edited by Sarah Chen (expires in 4 min 30 sec)"',
        'Form switches to read-only when locked by someone else',
        'Admin sees "Take over" button in banner to force-acquire lock',
        'Heartbeat interval: 2.5 minutes; TTL: 5 minutes (prevents stale locks)',
        'If disabled returns true, all lock UI is suppressed silently'
      ]
    },
    {
      type: 'h3',
      id: 'item-locking-presence',
      text: "Presence (Who's Viewing)"
    },
    {
      type: 'p',
      text: 'The presence feature tracks all users currently viewing a record (not just editing). It is powered by Socket.io room subscriptions and appears as a list of avatars in the item header.'
    },
    {
      type: 'pre',
      code: `GET /api/presence/:collection/:item
  # Returns list of users currently viewing

{
  "viewers": [
    {
      "user_id": "user-123",
      "name": "Sarah Chen",
      "avatar_url": "...",
      "viewing_since": "2026-06-15T10:15:00Z",
      "is_editing": true  // has active lock
    },
    {
      "user_id": "user-456",
      "name": "John Smith",
      "avatar_url": "...",
      "viewing_since": "2026-06-15T10:20:00Z",
      "is_editing": false  // read-only view
    }
  ]
}`
    },
    {
      type: 'note',
      text: 'Presence uses Socket.io — updates are real-time. Presence data is NOT persisted; it reflects active connections only.'
    }
  ]
}

export const collabNotificationsCenter: DocSection = {
  id: 'notifications-center',
  label: 'Notifications Center',
  content: [
    { type: 'h1', id: 'notifications-center', text: 'Notifications Center' },
    {
      type: 'p',
      text: 'Beyond the bell dropdown, the /notifications page is a full paginated inbox of every notification — filter by status, jump to the related record, and mark all as read in one click.'
    },
    {
      type: 'ul',
      items: [
        'Paginated list with sender, subject, message, and relative timestamp.',
        'Click a notification to open its collection/item; it is marked read automatically.',
        '"Mark all read" clears the unread counter everywhere (bell included).'
      ]
    },
    { type: 'h3', text: 'Priority lanes' },
    {
      type: 'p',
      text: 'Every notification sits in one of three lanes. Critical (SLA escalations, maintenance, failing monitors — they bypass every mute and quiet hour), Needs you (something asks THIS person to act: a task, an approval, an access request, a mention, an SLA clock, a record they currently own moving state, any row with an inline action), and FYI (everything else). The bell badge counts only the first two — FYI rows sit in the inbox without pulling the eye; the badge turns red while a Critical row is unread. The bell offers Needs you / FYI / All tabs, the Notifications page a lane strip (Critical / Needs you / FYI) beside the unread/read/snoozed filters. Lanes are stamped at write time (ownership resolved once, per recipient); rows from before lanes existed were backfilled from their subject and kind.'
    },
    {
      type: 'pre',
      code: `GET /api/notifications/unread-count
→ { "unread": 7, "attention": 3, "lanes": { "critical": 1, "needs_you": 2, "fyi": 4 } }

GET /api/notifications?lane=attention|critical|needs_you|fyi&category=workflow`
    },
    { type: 'h3', text: 'Delivery status — where did this go?' },
    {
      type: 'p',
      text: 'Each inbox row shows small chips per channel: In-app (landed / skipped and why), Push (sent · time / no browser registered / held by quiet hours or the matrix / failed), Email (sent · time / held for your daily summary / off for the category / dropped by mail test mode / no address / failed with the SMTP reason) and SMS. The email chip links to the mail-log row that recorded the send. Hover any chip for the reason — the same reason the test bench simulator would give. The record is written by notifyUser as each channel reports back (`delivery` on GET /notifications); rows from older writers carry only the in-app chip.'
    },
    { type: 'h3', text: 'Replying from the notification' },
    {
      type: 'p',
      text: 'A chat mention offers Reply — an inline box that posts straight back into the room. A mention in a record note offers Reply onto the record\'s thread. A workflow-transition notification offers "Comment on this", which adds a note to the record (the row stays unread; commenting is not acknowledging). Reply actions are server-declared like every inline action (`actions[].input` names the field the box fills) so hosts stay domain-blind; the normal permissions apply — posting on a record needs create rights on its collection.'
    },
    { type: 'h3', text: 'Notices that need acknowledgement' },
    {
      type: 'p',
      text: 'A flow "Send notification" step (Needs acknowledgement), or an extension passing `ack_required: true` to `notifyUser`, marks a notice as needing an explicit Acknowledge. It shows an Acknowledge button in the bell and the notification center, stays pinned above the lists until acknowledged (reading it does not count), reminds by push after 4 hours and tells the recipient\'s manager after 24 hours. The sender sees who has and has not acknowledged in the Sent view.'
    },
    { type: 'h3', text: 'Keeping the inbox tidy' },
    {
      type: 'p',
      text: 'In the notification center: select rows (or everything matching a filter) to mark read, snooze, archive or open their records in tabs; "Archive everything read and older than N days" in one action, or turn on automatic clean-up. Archived notifications stay searchable under the Archived filter. In Profile > Notification rules: pick a sound per category (or none) on top of the global sound; a card suggests muting categories you mostly never open, with undo; and every rule change shows what last week would have looked like (in-app, push and email counts) replayed through the same delivery decision the sender uses.'
    },
    { type: 'h3', text: 'Channel fallback chain (if it stays unread)' },
    {
      type: 'p',
      text: 'Snooze: a notification can sleep for an hour, until tomorrow 8am, until next week — or, when it is about a record, until the record changes. "Until the record changes" wakes it the moment someone else writes a field on that record or moves it to another pipeline state (your own edits do not wake it); it returns unread in the inbox and the bell. `POST /api/notifications/:id/snooze` with `{ "until": "<iso>" }`, `{ "until_change": true }`, or `{ "until": null }` to wake it now.'
    },
    {
      type: 'p',
      text: 'Profile → Notification rules → "If it stays unread": per category, how long an in-app notification may sit unread before it climbs to a browser push, then to an email — one notification escalating channels, stopping the moment it is read or snoozed. Each step fires once, and a channel that already delivered the row at send time is not repeated (an email sent immediately is never re-sent as an escalation). Only rows from the last 7 days are considered, so switching the rule on does not replay an old inbox. Runs every 5 minutes (`notification-escalation` cron); the escalation shows as an extra chip on the row.'
    },
    {
      type: 'pre',
      code: `PATCH /api/users/me/preferences
{ "notification_prefs": { "escalation": { "workflow": { "push_after_min": 60, "email_after_min": 240 } } } }`
    },
    { type: 'h3', text: 'Notification rules (per-category channels)' },
    {
      type: 'p',
      text: 'Profile → Notification rules is one matrix over the notification categories (mentions, workflow & approvals, SLA & escalations, field watches, alerts, anomaly detections, reports, system & digests, everything else) with three channels per row: In-app (the bell inbox row), Push (browser push to your registered devices), and Email. The "?" badge on each column header explains that channel, and the one beside each category name lists what that category covers.'
    },
    {
      type: 'ul',
      items: [
        'Email per category is Individual email (sent as it happens, deferred only during your quiet hours), Daily summary (held and delivered once in the daily action summary), or No email (dropped — the in-app row still lands).',
        'Precedence with a subscription\'s own delivery setting: the subscription is the more specific one and wins. A subscription set to Instantly emails as it happens even when its category is on Daily summary (No email and quiet hours still apply); a subscription on Daily or Weekly summary rides the daily action summary at your delivery hour (weekly on Mondays), and items from a category set to No email are left out of it. There is one morning email — the old separate "daily digest" is folded into the action summary.',
        'The Daily action summary block on the same card sets the delivery hour (Eastern time), a compact layout, and a "send me a test summary now" button. Anyone with at least one category on Daily summary receives the digest.',
        'Critical subjects (SLA escalations, maintenance notices, failing monitors) always email immediately regardless of the matrix.',
        'The legacy Profile → Email delivery card is gone; its instant/daily toggle maps onto the "All email" quick buttons.',
        'Notifications & alerts (the sources list below the rules) shows, under every source, whether it fires on an event or on a schedule — and the schedule in words ("Scheduled · At 08:00 AM, only on Monday"), read from the live cron roster so an overridden schedule reads correctly.',
        'Every email leaves through the same sender, so cron-driven mail (scheduled reports, report and view digests, alert checks, anomaly sweeps, SLA escalations, coverage notices, flow mail ops) follows the same rules. Senders pass an explicit category; a flow mail op can set `category` in its options.'
      ]
    },
    {
      type: 'pre',
      code: `PATCH /api/users/me/preferences
{ "notification_prefs": { "matrix": { "workflow": { "inapp": true, "push": false, "email": "daily" } } } }`
    },
    { type: 'h3', text: 'Record bundles in the bell' },
    {
      type: 'p',
      text: 'Unread rows that name the same record fold into one bell entry — "3 things on REQ-1042" — with the categories as chips and the most urgent lane colouring the row. The chevron expands the rows (each keeps its own actions), clicking the bundle opens the record, and the check marks the whole bundle read in one call. The Notifications page does the same behind "Group by record" (on by default). `GET /api/notifications?bundle=record` returns `bundles` ([{collection, item, label, count, unread, lane, categories, newest, url, ids, rows}]) beside `data`, which then holds only the rows that stayed single; a lone row about a record is never bundled. `total`, `/count` and `/unread-count` are unchanged — a bundle presents rows, it does not reduce them. The label is never a bare id: the friendly id, else the display label, else — for a record deleted since — its trash snapshot\'s label with a "deleted" chip (`deleted: true`, no Open link), else "<Singular> #<id>"; `collection_label` carries the singular name for the chip beside it. Collection-wide subscription rows name the record the same way ("updated PRB1 (regions)").'
    },
    { type: 'h3', text: 'As it was — what they saw when notified' },
    {
      type: 'p',
      text: 'A notification about a record remembers the record\'s revision current at send time (`revision_id`, stamped by notifyUser). "As it was" on a bell or inbox row opens a sheet with the record as it stood then beside the record now; fields that changed since are marked with an amber dot and listed first. Older rows (or a purged revision) fall back to the newest revision written before the notification; a record with no revision from that time says "No snapshot from that time" and shows the current values. `GET /api/notifications/:id/as-it-was` answers `{snapshot, current, changed_fields, fields, labels, revision_id, at}` for the caller\'s own row; `current` is read as the caller, so a record they can no longer open answers 403/404 and the snapshot is never shown without it. Scalar and link fields only — related sets are not compared.'
    },
    { type: 'h3', text: 'Sending a notification (user to user)' },
    {
      type: 'p',
      text: 'Any authenticated user can send an in-app notification to another active user — built for chat @mentions and similar frontend features. The sender is always the authenticated caller, and delivery rides the full channel stack: the inbox row, a live Socket.io `notification:new` event, and browser push for users with a registered subscription.'
    },
    {
      type: 'pre',
      code: `POST /api/notifications
Authorization: Bearer <token>
Content-Type: application/json

{
  "recipient": "<user uuid>",
  "subject": "Jane mentioned you in General chat",
  "message": "optional body, max 500 chars",
  "collection": "orders",   // optional record link
  "item": "123"                // optional record link
}

→ 201 { "ok": true }
→ 400 { "error": "recipient and subject are required" }
→ 404 { "error": "Recipient not found" }`
    }
  ]
}

export const collabUserActivityFeed: DocSection = {
  id: 'user-activity-feed',
  label: 'User Activity Feed',
  content: [
    { type: 'h1', id: 'user-activity-feed', text: 'User Activity Feed' },
    {
      type: 'p',
      text: 'An "Activity" button in the user editor and profile page header opens a right sidebar with a full chronological timeline of everything that user has done: item mutations, workflow transitions, logins, lock acquire/release — including the IP address for each event.'
    },
    {
      type: 'ul',
      items: [
        'Entries are grouped by calendar date with a sticky date separator and a vertical connector line.',
        'Action-type chips at the top (create, update, delete, login…) act as one-click filters.',
        'Filter bar: action select, collection text input, sort toggle (newest/oldest first). Chip count badge shows active filters.',
        'Collection and item values link directly to the record; clicking navigates and closes the sidebar.',
        'Load-more pagination — 50 entries per page, infinite scroll.',
        'Visible to admins on the user editor; visible to the own user on their profile page.'
      ]
    },
    {
      type: 'pre',
      code: `GET /api/user-activity/:userId
  ?page=1&limit=50
  &action=create        # filter by action type
  &collection=orders    # filter by collection name
  &date_from=2025-01-01 # ISO date lower bound
  &date_to=2025-12-31   # ISO date upper bound
  &sort=asc             # asc | desc (default desc)

GET /api/user-activity/:userId/summary
  # returns { total, actions: [{action, count}], collections: [{collection, count}] }`
    },
    {
      type: 'note',
      text: 'Both endpoints require admin access. The summary endpoint drives the clickable action chips — it is fetched once when the panel opens and is not re-fetched on filter changes.'
    }
  ]
}

export const collabKeyboardShortcuts: DocSection = {
  id: 'keyboard-shortcuts',
  label: 'Keyboard Shortcuts',
  content: [
    { type: 'h1', id: 'keyboard-shortcuts', text: 'Keyboard Shortcuts' },
    {
      type: 'p',
      text: 'The admin UI is fully keyboard-navigable. Press ? anywhere to open the shortcut overlay. Navigation uses two-key sequences (press g, then a letter). All bindings are rebindable from the overlay and persisted in localStorage.'
    },
    {
      type: 'table',
      head: ['Shortcut', 'Action'],
      rows: [
        ['?', 'Show / hide the shortcut overlay'],
        ['Cmd+K / Ctrl+K', 'Global search palette'],
        ['g then c', 'Go to Collections'],
        ['g then d', 'Go to Dashboard'],
        ['g then n', 'Go to Notifications']
      ]
    },
    {
      type: 'note',
      text: 'Custom bindings are stored per browser in localStorage — use the overlay\'s "Reset to defaults" to restore.'
    }
  ]
}

export const collabSmsPush: DocSection = {
  id: 'sms-push-channels',
  label: 'SMS / Push Channels',
  content: [
    { type: 'h1', id: 'sms-push-channels', text: 'SMS & Push Notification Channels' },
    {
      type: 'p',
      text: 'Notifications can be delivered over SMS (and push) in addition to in-app and email. SMS uses Twilio, configured entirely through environment variables; the shared notifyUser service routes a notification to every channel the recipient has enabled.'
    },
    {
      type: 'pre',
      code: `# .env
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM=+15551234567`
    },
    {
      type: 'ul',
      items: [
        'Users opt into channels per notification type in their profile.',
        'notifyUser() in the services layer fans out to in-app, email, SMS, and push based on those preferences — extensions can call it too.',
        'When TWILIO_* is unset, the SMS channel is a silent no-op.'
      ]
    }
  ]
}

export const collabMessageActions: DocSection = {
  id: 'message-actions',
  label: 'Slack / Teams Message Actions',
  content: [
    { type: 'h1', id: 'message-actions', text: 'Slack / Teams Message Actions' },
    {
      type: 'p',
      text: 'Notifications pushed to Slack or Microsoft Teams can carry actionable buttons — Approve, Reject, and View — rendered as Adaptive Cards. Button callbacks are HMAC-signed so a forged request cannot approve anything.'
    },
    {
      type: 'pre',
      code: `// Callback endpoint hit by Slack/Teams buttons
POST /api/message-actions/callback
// payload contains the action + a signed token binding it to
// the record, the action, and an expiry — verified server-side`
    },
    {
      type: 'ul',
      items: [
        'Approve/Reject buttons drive approval-chain decisions or workflow transitions directly from chat.',
        'View deep-links into the admin UI item editor.',
        'Signatures use HMAC-SHA256 with a server-side secret; expired or tampered tokens are rejected.'
      ]
    }
  ]
}

export const collabChat: DocSection = {
  id: 'collab-chat',
  label: 'Chat & Channels',
  content: [
    { type: 'h1', id: 'collab-chat', text: 'Chat & Channels' },
    {
      type: 'p',
      text: 'Team chat has four kinds of room, and each decides who can see it differently. Everything goes through `/api/chat` — the underlying `chat_messages` collection is deliberately not readable through the items API or GraphQL, because "who may read this row" depends on the room, which a per-collection policy cannot express.'
    },
    {
      type: 'table',
      head: ['Room', 'Key', 'Who can see it'],
      rows: [
        ['General', '`global`', 'Every authenticated user.'],
        [
          'Direct message',
          '`dm:<A>:<B>`',
          'The two participants. Admins included? No — admin access is data access, not other people’s conversations.'
        ],
        [
          'Channel',
          '`ch:<key>`',
          'Open: anyone may find and join. Role: that role, plus anyone explicitly added. Private: explicit members only, and it is not listed to anyone else.'
        ],
        [
          'Record',
          '`<prefix>:<token>`',
          'Whoever can read the underlying record — resolved live, so row-level filters and user scopes apply automatically.'
        ]
      ]
    },
    { type: 'h3', text: 'Sidebar vs directory' },
    {
      type: 'p',
      text: 'The sidebar lists rooms you belong to, plus General and your DMs. Open channels you have not joined live under the Browse tab, which is what keeps the list usable when an instance has hundreds of channels. Joining, leaving and muting are per-user; a muted room still shows its count but stops driving the unread badge and the notification sound.'
    },
    { type: 'h3', text: 'Managing a channel' },
    {
      type: 'p',
      text: 'The gear in a channel’s header opens its settings: rename, set a topic, change who can see it, add or remove members, or archive it. Only the channel’s creator or an admin can edit — everyone else sees a read-only summary of what kind of room they are in and who else is in it. Adding a member to a private channel grants access immediately; removing one revokes it just as fast.'
    },
    { type: 'h3', text: 'Record conversations' },
    {
      type: 'p',
      text: 'A record room needs no setup beyond registering its prefix: `ord:ORD-10042` resolves through the room-type registry to `orders` matched on `order_number`. Nobody is enrolled in these — visibility is recomputed from the record each time, so a scope change takes effect immediately and there is no membership list to maintain across tens of thousands of records. An unregistered prefix is refused rather than treated as a free-form room.'
    },
    {
      type: 'warn',
      text: 'Mentions notify only people who can actually see the room and have not muted it — the server checks both before sending, so mentioning someone in a record room they cannot read notifies nobody.'
    },
    {
      type: 'note',
      text: 'Live delivery is per room: the client joins `chat:<room>` over Socket.io and the server emits only there. Hosts that do not wire the socket adapter still work — the room list and messages poll instead.'
    },
    { type: 'h2', id: 'chat-admin-ui', text: 'Chat in the admin UI' },
    {
      type: 'p',
      text: 'The admin hosts the full chat surface in two places: a slide-over Team panel opened from the chat icon in the sidebar footer (unread badge, chirp on new messages), and a full-page workspace at `/chat` (Home → Chat) with the room list, channel browser and Online tab beside the open conversation. Both share the same data layer — mentions, typing indicators, read receipts, mute, join/leave and channel creation all work identically. `/chat?room=<key>` deep-links straight into a room.'
    },
    {
      type: 'p',
      text: 'The Online tab tells three states apart. Active: input recently and things moving. Idle: no input for five minutes (or "appear away"). Stuck: input in the last five minutes, but on the same route with no save, transition or any other request that changed something for ten minutes, shown as "stuck on CM26-80332 for 12m". Stuck reads the person\'s own route history (journeys) and request log, so only administrators and the person\'s manager see it, on the Online tab, on the people page header, and as a count and per-person pill on the manager\'s Team load card. GET /api/presence/online answers it as state and stuck { minutes, label } — the label is the record\'s friendly id, else the same page text as the line under the name ("Workflows", "Workflows › New"), never the raw route; the page pings that feed it come from the admin and from portals on @nivaro/react (usePageAt). On the Online tab the stuck pill drops the place when the page line shows it. For administrators the page line and the stuck pill are links: hover shows the full address, click opens it — a record through this app\'s own record route, an admin-console page on the admin, any other portal page only from that portal.'
    },
    {
      type: 'p',
      text: 'Admins manage the entity-room registry from the "Record rooms" button on `/chat`: register a prefix + collection + match field, or deactivate an existing type. Entity ids mentioned in messages render as links into the collection browser when a matching room type is registered.'
    },
    { type: 'h2', id: 'chat-edit-delete', text: 'Editing and deleting messages' },
    {
      type: 'ul',
      items: [
        'Edit — hover your own message and pick Edit. The window is 15 minutes from when it was sent; after that the option disappears. Edited messages show an "(edited)" marker, and an edit never re-fires mentions — nobody is notified again.',
        'Delete — you can delete your own messages at any time, and admins can delete anyone’s. A delete leaves a "Message removed" tombstone so the thread’s shape survives, but the text and attachments are gone and its reactions are cleared. Admin deletions of someone else’s message are recorded in the audit log with the original sender named.',
        'Deleted messages stop counting: they are excluded from the sidebar’s room previews and from unread counts, so a removed message can’t leave a phantom badge.',
        'Message history — the text and attachments as they were before each edit or delete are kept and shown to admins only, under Previous versions in the message detail of the admin message log at `/chat-analytics`. Room members never see it. History is purged after 90 days by default (`chat_history_retention_days` in settings; 0 keeps it forever).'
      ]
    },
    {
      type: 'note',
      text: 'To reach a whole group at once, use @channel in a channel room — it notifies up to 300 members and is limited to the channel’s creator or an admin. Regular @mentions are per-person.'
    },
    { type: 'h2', id: 'collab-chat-polls', text: 'Polls, slash commands and search by meaning' },
    {
      type: 'p',
      text: 'Type `/poll` in the composer to ask a room a question: 2–10 options, single or several answers, anonymous votes, and an optional close time. Results update live; when the poll closes (by its author or an admin, or at the close time) a summary line is posted in the room. Anonymous polls show counts only, never who voted.'
    },
    {
      type: 'p',
      text: 'Typing `/` lists the commands: `/task` (on the room’s record or for a person), `/remind`, `/poll` and `/note` (on the record) each open a small form above the box. Extensions add their own with `ctx.chat.registerCommand({ name, description, run })`; they run as the person typing.'
    },
    {
      type: 'p',
      text: 'Extensions can also add items to a message’s ⋯ menu (for example “Log to record”) with `ctx.chat.registerMessageAction`. The menu appears on hover only when an action fits the room and the message; it runs as the person clicking, and anything it posts goes into the room as them.'
    },
    {
      type: 'p',
      text: 'Chat search also finds messages by meaning, listed after the exact matches and limited to rooms you can see. The room info drawer’s Files and Links tabs are searchable and each link has a Show jump. The @mention picker lists people who are online first.'
    },
    { type: 'h2', id: 'collab-chat-rooms-extras', text: 'Emoji, drafts, @here and quiet channels' },
    {
      type: 'ul',
      items: [
        'Custom emoji: an admin adds images (PNG, GIF, JPEG or WebP, up to 256 KB) under the picker’s Workspace tab and gives each a shortcode. `:shortcode:` in a message and in a reaction shows the image. A removed emoji shows as its text again. The image files are private to the emoji list, they never appear in the file library for other people.',
        'Drafts: unsent text in a room is saved about a second and a half after you stop typing and appears in another browser or device. Rooms with a draft show a pencil in the list. Sending or emptying the box removes it, and drafts untouched for 30 days are deleted. Attachments and thread replies are not synced.',
        '@channel and @here: in a channel’s settings, choose whether the owner and admins, every member, or only admins may use them. @here still notifies only members who are online, up to 300.',
        'DM time hint: the DM header shows the other person’s local time, from their profile time zone or else the zone their browser reported. While you type outside their working hours (08:00 to 18:00 on weekdays unless they set `working_hours` in preferences) a quiet note says what time it is for them.',
        'Quiet channels: a channel with no posts for 90 days (Admin > Chat analytics > Channels sets the number, 0 turns it off) sends its owner one notification. The owner sees Archive or Keep open at the top of the channel. Keep restarts the clock. Archived channels stay searchable and can be reopened in their settings. Admins see the waiting and archived lists in the same tab.',
        'Membership history: owners and admins see who joined, left, was added or removed, and by whom, under the members panel. Admins see every channel’s changes in Chat analytics > Channels. `GET /api/chat/channels/:id/membership-history` and `GET /api/chat/admin/membership-history` return the same events.'
      ]
    },
    {
      type: 'h2',
      id: 'collab-chat-cards',
      text: 'Link cards, request ids, offline sending and long rooms'
    },
    {
      type: 'ul',
      items: [
        'Links to dashboards, queues, reports, saved views and custom queries show as a card with the page’s title, what kind of page it is and its description — never its data. The card is built for each reader: someone who cannot open the page sees the plain link. Custom queries are an administrator page, so only administrators get their card.',
        'Paste a request id (the id an error message shows) or a trace id and it shows as a card. Administrators see the route, status, duration, who made it, when, and a link to the request on the Traffic Map (`GET /api/chat/request-card?id=`). Everyone else only sees that the id names a logged request. An id that names no request stays plain text.',
        'Messages written while you are offline, or while the connection is coming back, wait in your browser and send by themselves when it returns, one at a time and in the order you wrote them. Each carries its own id, so a resend never posts twice. A waiting message can be edited or cancelled; while you edit it, the messages after it in that room wait too. A message that waited more than a day is not sent on its own: it shows Not sent with Retry, Edit and Remove. Signing out clears what is waiting.',
        'Long rooms only draw the messages near the screen once more than 150 are loaded, and load earlier history as you scroll up. Your place is kept when history loads above you or when an image or card above you finishes loading. Link cards load as their message comes near the screen. Jumping to unread messages, a pinned message or a search result still lands on that message.'
      ]
    },
    { type: 'h2', id: 'collab-chat-assistant', text: 'The assistant in rooms' },
    {
      type: 'p',
      text: 'When Settings names a chat assistant (`chat_bot_name`), mentioning it in any room asks it a question. It answers with the same permission-checked tools as Ask AI, run as the person who asked.'
    },
    {
      type: 'ul',
      items: [
        'The answer is written into the room as it arrives. The person who asked gets a Stop button; what arrived before Stop is posted, marked "(stopped)". The socket event is `chat:bot-stream` (phases start, delta, status, private, end, error), and `POST /api/chat/bot/streams/:id/stop` stops it. Only the person who asked can stop it.',
        'In a record’s room the assistant already knows the record. It reads it as the person asking, and if they cannot read it there is no record context. Its record tools default to that record, so "@assistant what’s blocking this?" needs no id.',
        'In a channel, the channel’s name, topic, description and pinned messages are part of the question, so a channel about one program or vendor gets answers about that program or vendor. The assistant treats this text as background, not as instructions. Pinned ops posts are included only in an admin-only ops room.',
        'Who sees the answer is decided before any of it is written. The answer is posted in the room only when everyone who can read the room could read everything it used. In a DM, a private channel or a small role channel (up to 20 other people), every tool call is re-run as each reader and must return the same result. In General, open channels, big role channels and record rooms, only reads of the room’s own record can be checked this way: one reader from every role that can read the collection re-runs each read. Anything else, such as lists, totals, saved queries, your own tasks or extension tools, goes privately to the person who asked. That answer is saved in their conversation with the assistant, the bubble in the room shows "Only you can see this", and the room gets a short notice with no data in it.'
      ]
    },
    {
      type: 'note',
      text: 'To keep answers in the room, ask about the record or name the fields you need. A read of a few fields that every role can see passes the check. A read of every field usually does not.'
    },
    { type: 'h2', id: 'collab-chat-huddles', text: 'Huddles and screen clips' },
    {
      type: 'p',
      text: 'A huddle is a voice call inside a channel, General or a record’s room, started from the headphones button in the room header. While one runs, the header shows who is in it with a Join button; a strip under the header shows the people, how long it has run and, when someone shares their screen, that screen. The room gets a line when a huddle starts and when it ends. You can open other rooms while you talk — the huddle keeps going and the header says so. Huddles are not recorded, and they do not run in direct messages.'
    },
    {
      type: 'ul',
      items: [
        'Audio goes browser to browser (WebRTC). The server only relays the handshake over the chat socket, and checks that you can still see the room on every message of it — lose access mid-call and you drop out.',
        'Share your screen with the screen button in the controls; only one share shows at a time (the first). The browser’s own "Stop sharing" ends it. Browsers without screen capture do not show the button.',
        'Administrators set the STUN/TURN servers under Settings → Huddles, per instance. Nothing configured means no outside server is contacted and people on the same network reach each other directly; add a STUN/TURN server for people on different networks — behind strict firewalls that means a TURN relay (a self-hosted coturn with `use-auth-secret` is the recommended setup — each person then gets a short-lived credential and the secret never leaves the server). The same page turns huddles off and caps how many people one can hold (default 8). TURN credentials are handed out only for a room the person can see and only while huddles are on; on the coturn side, deny every peer (`denied-peer-ip=0.0.0.0-255.255.255.255`), allow back only the ranges people connect from (`allowed-peer-ip`), and set `no-tcp-relay`, so the relay can never be used to reach internal hosts. After saving, **Test connection** asks the saved servers for a relay from your own browser (nobody is called): "The relay works" proves the server answered, accepted the credential and handed out a relay port from your network.',
        'Hosts that mount no realtime adapter, or browsers without WebRTC, simply never show the button.',
        'A headset badge with a head count appears beside any room that has a huddle running: in the room list, on the Chat button of a record whose room has one, and as "In a huddle in Ops" on a person’s card. You only ever see badges for rooms you can see; a room you cannot open never shows up.',
        'Administrators get a Huddles tab in Chat Analytics: huddles per day, time talking, median length, how many call links ran through the TURN relay, connection failures, average packet loss, the busiest channels and records, and how many huddles are live now. Each browser reports its own call quality when someone leaves, and the server keeps totals per huddle. Nothing records audio or screens. Direct and group huddles are counted but never name a room or a person. Records are kept 180 days.',
        'Under Settings → Huddles, **Server health** shows whether the TURN server is answering. Every 5 minutes the server asks each saved TURN server for a real relay with the credential a browser would get (and each STUN server for its address); the page shows the last result and a day of history, and three failures in a row raise an issue. With a shared secret the credential carries an expiry, so keep its lifetime longer than your longest huddle, because coturn re-checks it when it renews a relay and a long call on the relay can drop after it passes.'
      ]
    },
    { type: 'h3', id: 'collab-chat-huddles-large', text: 'Large huddles' },
    {
      type: 'p',
      text: 'Peer to peer, every person in a huddle uploads one audio stream per listener, which stops working past a handful of people. An administrator can add a self-hosted LiveKit media server under Settings → Huddles → Large huddles (address, API key, API secret). Huddles still start peer to peer; the join that takes one past "Move to the media server above" (default 5 people) moves everyone over — each browser then uploads once and the server fans it out. The move takes a moment and nobody hears a gap: the old links stay open for up to three seconds while the new ones come up. A huddle that moved stays on the media server until it ends. With a media server the cap on people per huddle defaults to 25 (up to 100); without one it stays 8 (up to 16).'
    },
    {
      type: 'ul',
      items: [
        'Who is in a huddle, mute and share state, and the "started / ended" lines never move: they stay with this instance. The media server carries sound and shared screens only, and sees rooms by an opaque name (a hash of the room key), never the channel or record name.',
        'Each person gets a ten-minute join token minted here, only for a room they can see and only once they are listed in its huddle. The API secret signs those tokens and never leaves the server (it shows masked under Settings).',
        '**Test media server** on the same page lists the server’s rooms with the saved key and secret: a pass proves the address is reachable from this instance and the pair matches. The `deploy/livekit` folder in the repository holds a compose file, a `livekit.yaml` template that points LiveKit at the same TURN server as the huddles, and the ports to open (TCP 7880/7881, UDP 50000–60000).',
        'The LiveKit client library downloads only when a huddle first goes large; mesh-only instances never fetch it.'
      ]
    },
    { type: 'h3', id: 'collab-chat-huddle-audio', text: 'Sound, devices and connection' },
    {
      type: 'ul',
      items: [
        'Whoever is talking gets a green ring around their picture in the huddle strip, and the strip moves the most recent speaker to the front (at most every 2 seconds, so it does not jump around). With reduced motion turned on in your system, the ring stays still instead of pulsing. When you talk into a muted microphone, the strip says so.',
        'The gear in the huddle controls picks your microphone and, in browsers that allow it (Chrome, Edge), your speaker. The bar under the microphone moves as you talk; **Test speaker** plays a short chime. Noise suppression, echo cancellation and automatic volume can be turned off there. Changes apply straight away without dropping the call, and your choices are remembered in this browser.',
        'To check your microphone before joining, use the small arrow next to the huddle button: it shows the same choices and level bar with a **Join huddle** button. The huddle button itself still joins in one click.',
        'Plug in a headset during a huddle and the call moves onto it ("Switched to …"); unplug the microphone you are using and it falls back to the default one.',
        'Each person in the strip has four connection bars; hover them for the delay, packet loss, jitter, whether the connection is direct or goes through the relay, and the bitrate. When your own connection has been poor for 10 seconds (more than 5 % loss or over 400 ms delay to everyone), the strip says "Your connection is poor". While you share your screen, a poor link to someone gets a lighter version of your screen until it recovers, so your voice stays clear.'
      ]
    },
    {
      type: 'table',
      head: ['Shortcut (while in a huddle)', 'Action'],
      rows: [
        ['Hold Space', 'Talk while muted (push to talk); letting go mutes again'],
        ['M', 'Mute or unmute'],
        ['Shift+S', 'Share your screen, or stop sharing'],
        ['L', 'Leave the huddle (press it twice while you are sharing)'],
        ['?', 'Show the shortcut list next to the controls']
      ]
    },
    {
      type: 'note',
      text: 'Shortcuts never fire while you are typing in a field. Space on another button presses that button as usual; on the huddle controls it is push to talk. Switching to another window or tab while holding Space mutes you again.'
    },
    {
      type: 'p',
      text: 'A screen clip is a short recording — up to 60 seconds of your screen and microphone — made from the clapperboard button in the composer and sent like any other attachment. The button becomes the clock while it records; Stop, the 60 s mark or the browser’s "Stop sharing" ends it. The clip arrives with a poster frame and plays inline in the message. It is an ordinary file in the file manager (tagged `chat-clip`), not a help video.'
    }
  ]
}

export const collabSupportRequests: DocSection = {
  id: 'support-requests',
  label: 'Support Requests',
  content: [
    { type: 'h1', id: 'support-requests', text: 'Support Requests' },
    {
      type: 'p',
      text: 'People ask the administrators for help or for a change to a record, and follow the request until it is done. A support request is a task (`nivaro_tasks.kind = support`) that points at a record, or at nothing for General Support, and waits unassigned until someone picks it up.'
    },
    {
      type: 'ul',
      items: [
        "**Raise one** from a record's ⋯ menu (Request a change — the request types for that kind of record are offered) or from Get help (General Support). Files can be attached.",
        '**Follow it** on the Support page (`/support`) under My requests, in the "Tasks I\'ve requested" dashboard widget, and through notifications on every status change and reply.',
        '**Work it** on the Desk tab (administrators, and members of a team a request type routes to): Pick it up assigns it to you and moves it to In progress; status, type and assignee can be changed; replies go to the requester.',
        '**Analytics** (Analytics tab on the Desk, administrators and team members; a team member sees the tickets routed to their teams): tickets by request type and team, first response and resolution time (median and p75, with the share within the target: 4 hours to first reply and 3 days to resolution by default), the share of closed tickets that were reopened, tickets per kind of record, how many arrived with a replay clip or screenshot, and the busiest requesters, over 7, 30 or 90 days. Counts and timings only, no ticket text. `GET /api/support/analytics?days=&first_response_hours=&resolution_hours=`.',
        '**Status**: Open → In progress → Done, or Cancelled. The requester can withdraw an open request or reopen a finished one.',
        '**Request types** (`nivaro_task_categories`, administrators, Request types tab): a type tied to a collection is offered on those records only; with no team a request goes to every administrator; a default assignee skips the desk.',
        "**Privacy**: a request is visible to its requester, its assignee, the administrators and the members of its team — never in a colleague's record task list.",
        "**Report a problem** (portals): @nivaro/react exports ReportProblemButton for a host shell to mount (`<ReportProblemButton app='efp' />`, a corner button, or inline with floating={false}). The person writes one sentence; a screenshot is taken before the dialog opens with every typed value masked (html2canvas, an optional peer dependency: without it the report goes without a picture), plus the same what-they-saw context as below. It files an issue (source client, raised by the person, screenshot and details attached) AND a support request linked to it (nivaro_tasks.issue_id), which they follow under My requests; the desk sees Issue #N on the ticket.",
        "**What they saw** (ticked by default, the requester can untick it): Get help and Request a change take the moment the dialog opens. With Error clips on, the last minute of the screen becomes an app='support-clip' recording (inputs masked); with full recording on, the live recording is marked at that moment. A text attachment (what-they-saw-….txt) carries the page, the last 30 console warnings/errors and the last 20 requests (method, route pattern, status, ms; no bodies or query strings, secrets redacted). Nothing uploads unless the request is sent. On the desk, the ticket shows Watch what they saw, opening /session-replays?recording=<id>&t=<ms> at the moment of asking (administrators only)."
      ]
    },
    {
      type: 'pre',
      code: `POST /api/support/tickets
{ "title": "Change the ship-to address", "description": "…", "category_id": 3,
  "collection": "orders", "item": "42", "attachments": ["<file id>"],
  "replay": { "recording_id": "<their own recording>", "offset_ms": 41000 } }

POST  /api/support/report-problem       // Report a problem: issue + linked request
{ "sentence": "The upload spins forever", "route": "/claims/7/upload", "app": "efp",
  "screenshot": "data:image/jpeg;base64,…", "context": "…", "attachments": ["<file id>"],
  "replay": { "recording_id": "…", "offset_ms": 52000 } }

GET   /api/support/tickets?scope=mine|desk&status=open|closed&assignee=me|unassigned&q=
GET   /api/support/tickets/:id           // thread + history
POST  /api/support/tickets/:id/comments  { "text": "…" }
POST  /api/support/tickets/:id/claim
PATCH /api/support/tickets/:id           { "status": "done" }
GET   /api/support/summary               // badge counts
GET   /api/support/categories?collection=orders
GET   /api/tasks/requested               // tasks I asked others to do`
    },
    { type: 'h3', id: 'support-report-problem', text: 'Report a problem' },
    {
      type: 'p',
      text: "A portal can mount `ReportProblemButton` (from `@nivaro/react`): `<ReportProblemButton app='portal' />` for a corner button, or `floating={false}` to place it inline. The person writes one sentence. Before the dialog opens the browser takes a screenshot with every typed value masked (needs `html2canvas` installed in the host app; without it the report goes without a picture) and keeps the moment for the replay. With Include what I was doing ticked, the report also carries the replay, the last console warnings and errors, the last requests and the page. The server files an issue (source client, raised by the person) and a support request linked to it, which the person follows under My requests; the desk sees Issue #N on the ticket."
    },
    {
      type: 'pre',
      code: `POST /api/support/report-problem
{ "sentence": "Saving spun forever", "screenshot": "data:image/jpeg;base64,…",
  "route": "/records/orders/42", "app": "portal", "context": "…",
  "replay": { "recording_id": "<own recording>", "offset_ms": 8600 } }
→ { "data": { "ticket": { … }, "issue_id": 501 } }`
    }
  ]
}
