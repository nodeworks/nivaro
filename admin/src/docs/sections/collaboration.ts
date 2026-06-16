import type { DocSection } from '../types.js'

export const collabTasks: DocSection = {
  id: 'tasks',
  label: 'Task Assignments',
  content: [
    { type: 'h1', id: 'tasks', text: 'Task Assignments' },
    {
      type: 'p',
      text: 'Attach lightweight tasks to any record to coordinate work. Assign a user, set a due date, add a description, and track completion. Tasks live in `nivaro_tasks` and render in a dedicated TaskPanel on the item edit page. Assignees receive in-app notifications and tasks appear in their "My Tasks" dashboard.'
    },
    {
      type: 'h3',
      id: 'tasks-creating',
      text: 'Creating and Managing Tasks'
    },
    {
      type: 'pre',
      code: `POST /api/tasks
{
  "collection": "orders",
  "item": "order-42",
  "title": "Confirm pricing with customer",
  "description": "Call to verify final unit cost",
  "assignee": "user-123",
  "due_at": "2026-06-20T17:00:00Z",
  "priority": "high"
}

// Response
{
  "id": "task-999",
  "collection": "orders",
  "item": "order-42",
  "title": "Confirm pricing with customer",
  "assignee": {
    "id": "user-123",
    "name": "Sarah Chen",
    "email": "sarah@example.com"
  },
  "due_at": "2026-06-20T17:00:00Z",
  "status": "open",
  "created_at": "2026-06-15T10:30:00Z",
  "created_by": "user-456"
}`
    },
    {
      type: 'h3',
      id: 'tasks-api',
      text: 'API Reference'
    },
    {
      type: 'pre',
      code: `GET /api/tasks?collection=orders&item=order-42
  # All tasks on a specific record

GET /api/tasks?assignee=me
  # My open tasks (current user)

GET /api/tasks?assignee=me&status=open
  # My open tasks (filter by status)

GET /api/tasks/my-tasks
  # Current user's dashboard with counts by status

PATCH /api/tasks/task-999
  { "status": "done" }  # Mark complete (records completed_by + completed_at)
  { "assignee": "user-456" }  # Reassign
  { "due_at": "2026-06-25T17:00:00Z" }  # Update due date
  { "title": "...", "description": "..." }  # Edit

DELETE /api/tasks/task-999  # Delete (permission: creator, assignee, or admin)`
    },
    {
      type: 'h3',
      id: 'tasks-ui',
      text: 'UI Components'
    },
    {
      type: 'ul',
      items: [
        'TaskPanel on item edit: shows all tasks for the record, create/edit inline',
        'Overdue badge: red "OVERDUE" pill when due_at < now',
        'Assignee avatar: user picture with name tooltip',
        'Quick filters: "Open", "My Tasks", "Overdue" pills above the task list',
        'My Tasks dashboard: tasks.tsx page with search, filters (assignee, collection, priority, status), and bulk actions'
      ]
    },
    {
      type: 'h3',
      id: 'tasks-status-workflow',
      text: 'Status Workflow'
    },
    {
      type: 'ul',
      items: [
        'open: default state; task is active and assigned',
        'done: assignee marks complete; system records who completed it and when',
        'deleted: soft-delete via DELETE endpoint; only creator/assignee/admin can delete'
      ]
    },
    {
      type: 'note',
      text: 'Tasks are collection-scoped — a task cannot be shared across records. Each task is tied to exactly one collection + item pair.'
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
      text: 'Presence (Who\'s Viewing)'
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
