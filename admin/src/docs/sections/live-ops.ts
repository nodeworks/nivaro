import type { DocSection } from '../types.js'

export const aiActionsDocs: DocSection = {
  id: 'ai-actions',
  label: 'AI Actions & Dashboards',
  content: [
    { type: 'h1', id: 'ai-actions', text: 'AI Actions & Dashboards' },
    {
      type: 'p',
      text: 'Ask AI can propose mutations — never execute them directly. Every proposal is stored, previewed in an approval card, and only runs when the proposing user clicks Approve within one hour.'
    },
    { type: 'h2', id: 'ai-actions-types', text: 'Action types' },
    {
      type: 'ul',
      items: [
        'bulk_update — a filter plus field changes; affected records resolve through the permission-checked read path (RLS applies), capped at 200.',
        'create_record — a single new record from field values.',
        'create_dashboard — a named dashboard with up to 12 widgets (count, sum, avg, latest, bar_chart, line_chart); widget collections need read permission and fields validate against the registry.'
      ]
    },
    {
      type: 'pre',
      code: `POST /api/ai/proposals/:id/approve   → executes as the proposer
POST /api/ai/proposals/:id/reject    → discards

Execution goes through the items service per row — hooks, validation,
row security, computed fields and activity logging all run.`
    },
    {
      type: 'note',
      text: 'Proposals expire after one hour and can only be approved by the user who asked. Dashboards are created private to the proposer.'
    }
  ]
}

export const recordGraphDocs: DocSection = {
  id: 'record-graph',
  label: 'Relationship Explorer',
  content: [
    { type: 'h1', id: 'record-graph', text: 'Relationship Explorer' },
    {
      type: 'p',
      text: 'Every record form has a Relationships button in its header. It opens a map of the records linked to this one, grouped by the link: what the record points at (vendor, project, creator), what points at it (lines, forecasts, notes), and records joined through a many-to-many link. Expand any record to see what it connects to in turn; click a record to open it.'
    },
    {
      type: 'pre',
      code: `GET /api/record-graph/:collection/:id
→ { "data": { "node": {collection, id, label, collection_label},
              "groups": [{ "direction": "out|in|m2m", "field", "label", "collection",
                           "collection_label", "total", "items": [{collection, id, label}] }],
              "edges": 29, "truncated": false } }`
    },
    {
      type: 'ul',
      items: [
        'Every record in the answer is read as the viewer (roles, row filters, User Scopes): a group the viewer cannot read is left out and counts are what the viewer can see. A record outside their access answers 404.',
        'Up to 12 records per group; `total` says how many there are. Polymorphic links are split per target collection.',
        'A relation row naming a table that no longer exists drops that group rather than failing the map.',
        'Shared components `RecordGraphSheet` / `RecordGraphExplorer` (exported from @nivaro/react), so headless hosts get the same explorer.'
      ]
    }
  ]
}

export const flowMapReplayDocs: DocSection = {
  id: 'pipeline-flow-map',
  label: 'Flow Map & Replay',
  content: [
    { type: 'h1', id: 'pipeline-flow-map', text: 'Pipeline Flow Map & Time-Lapse Replay' },
    {
      type: 'p',
      text: 'Two history visualizations at the bottom of every pipeline editor, both computed on the fly from workflow history.'
    },
    { type: 'h2', id: 'flow-map', text: 'Flow map (Sankey)' },
    {
      type: 'p',
      text: 'GET /api/pipelines/:id/flow-map aggregates transition volumes between states. Forward flows render as ribbons sized by volume; send-backs (transitions against the state sort order) render red, so rework loops jump out. Hover a state to isolate its flows.'
    },
    { type: 'h2', id: 'pipeline-cumulative-flow', text: 'Cumulative flow' },
    {
      type: 'p',
      text: 'GET /api/pipelines/:id/cumulative-flow stacks the number of records in each state at the end of every day (30, 90 or 365 days), built from workflow history. A band that keeps widening is work piling up in that state. The summary under the chart shows records that arrived, records that finished, the average work in progress and the lead time, worked out as average work in progress divided by records finished per day.'
    },
    {
      type: 'p',
      text: "It counts only the records the viewer may read: read permission, the role's row filter and User Scopes all apply, so two people can see different numbers. Every night a job stores a year of daily counts per pipeline and collection; a viewer with no row filter and no scope restriction reads ranges over 90 days from that stored series, everyone else gets a live read."
    },
    {
      type: 'p',
      text: 'The same chart is a dashboard widget type, Cumulative flow: pick a collection and a pipeline, and it shows the last 60 days of the records you can see in that collection. Widget filters narrow the records.'
    },
    { type: 'h2', id: 'pipeline-replay', text: 'Time-lapse replay' },
    {
      type: 'p',
      text: 'GET /api/pipelines/:id/replay reconstructs a daily frame series of how many records sat in each state. Play, scrub, or hide terminal states to watch backlog move through the pipeline over months in seconds.'
    }
  ]
}

export const wallboardPulseDocs: DocSection = {
  id: 'wallboard-pulse',
  label: 'Wallboard & Pulse',
  content: [
    { type: 'h1', id: 'wallboard-pulse', text: 'Wallboard & Pulse' },
    { type: 'h2', id: 'wallboard', text: 'Wallboard (TV mode)' },
    {
      type: 'p',
      text: '/wallboard renders a chrome-free, dark, full-screen queue dashboard for ops-floor displays: giant stat tiles (total, unowned, SLA warning/breached, at risk) and a by-state distribution, auto-rotating across your queues every 20 seconds and refreshing every minute.'
    },
    { type: 'h2', id: 'pulse', text: 'Pulse (live activity stream)' },
    {
      type: 'p',
      text: '/activity/live streams every activity entry the moment it happens over an admin-only Socket.io room, with a per-minute sparkline. Use it to watch a migration, an import, or a busy Monday in real time.'
    },
    {
      type: 'note',
      text: 'Both are read-only surfaces over existing data — no new tables, no configuration.'
    }
  ]
}

export const webPushDocs: DocSection = {
  id: 'web-push',
  label: 'Browser Push',
  content: [
    { type: 'h1', id: 'web-push', text: 'Browser Push Notifications' },
    {
      type: 'p',
      text: 'Native browser push (Web Push / VAPID) delivers notifications even when the admin tab is closed. Every in-app notification also fans out to each browser the user enabled push on.'
    },
    {
      type: 'pre',
      code: `GET  /api/push/vapid-public-key   # auto-generates + persists a keypair on first call
POST /api/push/subscribe          # { endpoint, keys: { p256dh, auth } }
POST /api/push/unsubscribe        # { endpoint }
GET  /api/push/status             # { subscriptions: n }
POST /api/push/test               # sends a test push to your browsers`
    },
    {
      type: 'ul',
      items: [
        'Enable per device from Profile → Browser Notifications; a badge shows how many devices are registered.',
        'VAPID keys resolve from VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY env vars first, then nivaro_settings; with neither set a keypair is generated once and stored — zero setup.',
        'Dead subscriptions (404/410 from the push service) are pruned automatically on send.',
        'Clicking a push focuses the admin and navigates to the related record or the Notifications Center, and marks the notification read.'
      ]
    },
    { type: 'h2', id: 'web-push-look', text: 'What a browser notification looks like' },
    {
      type: 'ul',
      items: [
        'Each notification carries an icon for its category (workflow, approvals, tasks, mentions, field watches, alerts, anomalies, SLA, reports, integrations, system, security, chat, huddles, chaos drills); anything else shows the app mark. A corner dot gives the lane: amber = needs you, red = critical, none = FYI.',
        'Two actions: Open and Mark as read. Mark as read clears the inbox row without opening the app.',
        'A newer notification about the same record replaces the older one instead of stacking; the inbox still keeps every row.',
        'FYI notifications arrive without a sound. Critical ones stay on screen until dismissed (where the system allows it).',
        'The time shown is when the event happened, not when the browser received it.',
        'Icons are PNG files in /push (Chrome draws no SVG in a notification); regenerate them with node scripts/push-icons.mjs (admin) or --brand efp --out ../efp-new/public/push (EFP).'
      ]
    },
    { type: 'h2', id: 'phone-push', text: 'Phone alerts (mobile apps)' },
    {
      type: 'p',
      text: "A phone app built with Expo registers its push token, and every notification that would go to the person's browsers also goes to their phones through the Expo push service — the same Push column in Profile → Notification rules, the same quiet hours, escalation reminders and test mode. A phone is stored as a push subscription whose endpoint is `expo:<token>`, so it counts as a push device everywhere (delivery chips, Notification Bench, Test my rules); no migration."
    },
    {
      type: 'pre',
      code: `GET    /api/push/phones        # your phones: platform, app, device name, last used
POST   /api/push/phones        # { token: "ExponentPushToken[...]", platform?, app?, device_name? } → { forget_key }
DELETE /api/push/phones        # { token } — remove one of your phones
POST   /api/push/phones/forget # { token, forget_key } — no sign-in needed: the key from registration proves it is this phone (sign-out)
POST   /api/push/phones/test   # sends a test alert to your phones
GET    /api/push/status        # { subscriptions: <browsers>, phones: <phones> }`
    },
    {
      type: 'ul',
      items: [
        'The alert carries the notification id, collection and item, so tapping it opens the record and marks the notification read; the app icon badge is set to the unread count.',
        "A phone belongs to whoever signed in on it last: registering a token another person had moves it, so a shared phone never shows the previous person's alerts. Signing out calls /phones/forget with the one-time key the registration answered (only its hash is stored; a new registration replaces it), which needs no sign-in, so an expired or revoked sign-in can still stop the alerts; an app that could not reach the server retries on its next start.",
        'Phones Expo reports as gone (DeviceNotRegistered, on the send or on the receipt read back 30 seconds later) are removed.',
        '`MOBILE_PUSH=off` stops phone alerts; `EXPO_ACCESS_TOKEN` is sent when the Expo project requires push security. The API needs outbound HTTPS to exp.host.'
      ]
    }
  ]
}
