import type { DocSection } from '../types.js'

export const collabTasks: DocSection = {
  id: 'tasks',
  label: 'Task Assignments',
  content: [
    { type: 'h1', id: 'tasks', text: 'Task Assignments' },
    {
      type: 'p',
      text: 'Lightweight tasks can be attached to any record: assign a user, set a due date, and track completion. Tasks live in `nivaro_tasks` and render in a TaskPanel on the item edit page. Assignees get an in-app notification.'
    },
    {
      type: 'pre',
      code: `GET    /api/tasks?collection=orders&item=42   # tasks on a record
GET    /api/tasks?assignee=me                  # my open tasks
POST   /api/tasks
{ "collection": "orders", "item": "42", "title": "Confirm pricing", "assignee": "<user>", "due_at": "2026-06-15" }
PATCH  /api/tasks/:id        # { "status": "done" } | reassign | edit
DELETE /api/tasks/:id`
    },
    {
      type: 'ul',
      items: [
        'The TaskPanel shows open and completed tasks with assignee avatars and due-date badges (overdue in red).',
        'Completing a task records who completed it and when.'
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
      text: 'Approval chains add formal sequential sign-off to records: define a chain of steps (each with an approver user or role), start an instance on a record, and each step must approve before the next is activated. A rejection stops the chain. This is an optional feature — nothing changes for collections without chains.'
    },
    { type: 'h3', text: 'Model' },
    {
      type: 'table',
      head: ['Table', 'Purpose'],
      rows: [
        ['nivaro_approval_chains', 'Chain definition: name, collection'],
        ['nivaro_approval_steps', 'Ordered steps: approver (user or role), label'],
        ['nivaro_approval_instances', 'Per-record runtime: current step, status'],
        ['nivaro_approval_decisions', 'Immutable approve/reject log with comments']
      ]
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `POST /api/approvals/chains                 # define a chain (admin)
POST /api/approvals/start                  # { chain, collection, item } → instance
POST /api/approvals/:instanceId/decide     # { decision: "approve" | "reject", comment }
GET  /api/approvals?collection=...&item=...`
    },
    {
      type: 'ul',
      items: [
        'The ApprovalPanel on item edit shows each step with its status (pending/approved/rejected) and lets the current approver decide inline.',
        'Steps are strictly sequential; a rejection marks the instance rejected and notifies the requester.',
        'Approvers are notified in-app when their step becomes active.'
      ]
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
      text: 'Opening an item for editing takes a soft lock (`nivaro_item_locks`) with a 5-minute TTL kept alive by a heartbeat. A second user opening the same item sees an amber "being edited by …" banner and the form switches to read-only mode until the lock is released or expires. Presence viewers show who else currently has the record open.'
    },
    {
      type: 'pre',
      code: `GET    /api/item-locks/:col/:item/lock     # current lock state (null when free/disabled)
POST   /api/item-locks/:col/:item/lock     # acquire or refresh — 409 with holder name if taken
POST   /api/item-locks/:col/:item/heartbeat # extend TTL (called every ~2.5 min by the editor)
DELETE /api/item-locks/:col/:item/lock     # release; admin ?force=1 breaks any lock

GET    /api/presence/:collection/:item    # current viewers of a record`
    },
    {
      type: 'ul',
      items: [
        'Locks auto-expire 5 minutes after the last heartbeat — a crashed tab never locks a record forever.',
        'Admins can take over a lock from the amber banner; the previous holder receives a notification.',
        'A race condition (two users acquiring simultaneously) is handled via UNIQUE(collection, item) — the DB constraint ensures only one wins; the loser gets a 409.',
        'When disabled is returned in the response, the client suppresses all lock UI silently.'
      ]
    },
    { type: 'h3', text: 'Per-collection on/off toggle' },
    {
      type: 'p',
      text: 'Locking can be disabled per collection in Data Model → (table) → Settings → Item locking. When toggled off, all active locks on that collection are immediately released and a `item-lock-disabled` Socket.io event is broadcast. The `item_locking_enabled` column on `nivaro_collections` defaults to 1 — all collections start locked-enabled.'
    },
    {
      type: 'pre',
      code: `GET   /api/item-locks/config/:collection   # { item_locking_enabled: boolean }
PATCH /api/item-locks/config/:collection   # { item_locking_enabled: true|false } — admin only`
    },
    {
      type: 'table',
      head: ['Response field', 'Meaning'],
      rows: [
        ['data: null', 'Item is free (no active lock)'],
        [
          'data: { user, locked_by_name, expires_at, is_mine }',
          'Item is locked; is_mine=true means the current user holds it'
        ],
        [
          'locking_disabled: true',
          'Collection has locking turned off — client should suppress all lock UI'
        ]
      ]
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
