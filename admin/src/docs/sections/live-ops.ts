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
  label: 'Record Graph Explorer',
  content: [
    { type: 'h1', id: 'record-graph', text: 'Record Graph Explorer' },
    {
      type: 'p',
      text: 'A radial map of one record’s relation neighborhood: M2O parents, O2M children (capped at 12 per relation) and M2M partners, each with resolved labels. Click a node to recenter on it, double-click to open the record.'
    },
    {
      type: 'pre',
      code: `GET /api/record-graph/:collection/:id
→ { "data": { "node": {…}, "edges": [{ "kind": "m2o|o2m|m2m", "via": "field", "node": {…} }], "truncated": false } }`
    },
    {
      type: 'ul',
      items: [
        'Neighbor collections require read permission; system tables are excluded (nivaro_files attachments are the one allowed system target).',
        'One API hop per recenter — the explorer never loads more than a single neighborhood.',
        'Open it from the graph button in the item editor header.'
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
      text: '/pulse streams every activity entry the moment it happens over an admin-only Socket.io room, with a per-minute sparkline. Use it to watch a migration, an import, or a busy Monday in real time.'
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
        'Clicking a push focuses the admin and navigates to the related record or the Notifications Center.'
      ]
    }
  ]
}
