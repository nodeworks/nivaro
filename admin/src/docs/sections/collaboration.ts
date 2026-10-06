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
      text: 'Admins manage the entity-room registry from the "Record rooms" button on `/chat`: register a prefix + collection + match field, or deactivate an existing type. Entity ids mentioned in messages render as links into the collection browser when a matching room type is registered.'
    },
    { type: 'h2', id: 'chat-edit-delete', text: 'Editing and deleting messages' },
    {
      type: 'ul',
      items: [
        'Edit — hover your own message and pick Edit. The window is 15 minutes from when it was sent; after that the option disappears. Edited messages show an "(edited)" marker, and an edit never re-fires mentions — nobody is notified again.',
        'Delete — you can delete your own messages at any time, and admins can delete anyone’s. A delete leaves a "Message removed" tombstone so the thread’s shape survives, but the text and attachments are gone and its reactions are cleared. Admin deletions of someone else’s message are recorded in the audit log with the original sender named.',
        'Deleted messages stop counting: they are excluded from the sidebar’s room previews and from unread counts, so a removed message can’t leave a phantom badge.'
      ]
    },
    {
      type: 'note',
      text: 'To reach a whole group at once, use @channel in a channel room — it notifies up to 300 members and is limited to the channel’s creator or an admin. Regular @mentions are per-person.'
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
        '**Status**: Open → In progress → Done, or Cancelled. The requester can withdraw an open request or reopen a finished one.',
        '**Request types** (`nivaro_task_categories`, administrators, Request types tab): a type tied to a collection is offered on those records only; with no team a request goes to every administrator; a default assignee skips the desk.',
        "**Privacy**: a request is visible to its requester, its assignee, the administrators and the members of its team — never in a colleague's record task list."
      ]
    },
    {
      type: 'pre',
      code: `POST /api/support/tickets
{ "title": "Change the ship-to address", "description": "…", "category_id": 3,
  "collection": "orders", "item": "42", "attachments": ["<file id>"] }

GET   /api/support/tickets?scope=mine|desk&status=open|closed&assignee=me|unassigned&q=
GET   /api/support/tickets/:id           // thread + history
POST  /api/support/tickets/:id/comments  { "text": "…" }
POST  /api/support/tickets/:id/claim
PATCH /api/support/tickets/:id           { "status": "done" }
GET   /api/support/summary               // badge counts
GET   /api/support/categories?collection=orders
GET   /api/tasks/requested               // tasks I asked others to do`
    }
  ]
}
