import type { DocSection } from '../types.js'

export const liveWidgetsDocs: DocSection = {
  id: 'live-widgets',
  label: 'Pushed Widgets',
  content: [
    { type: 'h1', id: 'live-widgets', text: 'Pushed dashboard and report widgets' },
    {
      type: 'p',
      text: 'A dashboard or report widget on screen asks the server to watch it. When someone saves a record in a collection the widget reads, the server works the widget out again — at most once every 10 seconds per widget — as YOU, with your role, row filters and User Scopes, and sends the new figure to your screen only. Nobody else’s figure ever reaches you, and yours never reaches them.'
    },
    {
      type: 'table',
      head: ['Widget', 'How it refreshes'],
      rows: [
        [
          'Report: KPI, charts, tables, pivots, heatmaps, movers, KPI groups, …; dashboard: count, sum, average, latest rows, charts, saved view',
          'Pushed when its data changes. Its own refresh interval drops to a 5-minute safety net.'
        ],
        [
          'Query widgets (raw SQL), AI insight, narrative, calc formulas, metric catalog, queue stats',
          'Unchanged: the widget keeps its refresh interval.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'You must still be able to open the dashboard or report AND read every collection the widget reads; when that stops being true the push ends and the widget goes back to its normal refresh.',
        'Every widget — pushed or polled, on a dashboard, a report, a public dashboard link or a record page — reads as the person viewing it: their read permission on each collection, their row filters and User Scopes, and only fields their role can read. A widget built on a field you cannot read shows "Forbidden" instead of a figure; a public dashboard link shows what its creator can see.',
        'After a lost connection the widget refreshes once when it is back, then pushing resumes.',
        'Recomputes are capped per server (`WIDGET_LIVE_MAX_PER_MIN`, default 300 a minute); a widget over the cap catches up in the next minute.'
      ]
    },
    {
      type: 'pre',
      code: `socket → widgets:watch   { watches: [{ key, kind: 'report'|'dashboard', widget, report?, params? }] }
server → widget:watching { accepted: [key], refused: [{ key, reason }] }   reason: not-live | forbidden | not-found | busy
server → widget:data     { key, widget, data }      (to this socket only)
server → widget:stale    { key }                    (too large to push: refetch)
server → widget:unwatched { key, reason }
socket → widgets:unwatch { keys }                   (re-send widgets:watch every minute; a watch lapses after 150 s)`
    },
    {
      type: 'p',
      text: 'Hosts built on `@nivaro/shared` get this from `useLiveWidget({ kind, widget, report, params, onData })`, which returns whether the push is on; `liveWidgetInterval(live, ms)` gives the poll to keep meanwhile.'
    }
  ]
}

export const viewStreamDocs: DocSection = {
  id: 'view-change-stream',
  label: 'Saved-View Change Stream',
  audience: 'admin',
  content: [
    { type: 'h1', id: 'view-change-stream', text: 'Change stream for a saved view' },
    {
      type: 'p',
      text: 'A partner system can follow one saved view instead of a whole collection. The stream sends an event only for a record that matches the view’s filter AS THE CALLER — for a partner, the API key that opened it, with its scopes and row restrictions, the role’s row filters and User Scopes. Payloads are record ids and the names of changed fields the key may read; values only with `values=1`, and then only what the key could read through /items.'
    },
    {
      type: 'pre',
      code: `GET /api/events/views/:viewId/stream            Authorization: Bearer nvk_…   (or ?ticket= from GET /api/events/ticket)
    ?values=1                                     include readable field values
    Last-Event-ID: 18234   (or ?last_event_id=)   resume after that event

id: 18240
event: record.change
data: {"item":"42","action":"update","changed_fields":["status"]}

event: record.leave    {"item":"42"}     stopped matching the view
event: record.delete   {"item":"42"}     deleted while it was in the view
event: view.refresh    {"reason":"bulk_write"}      re-read the view
event: reset           {"reason":"cursor_expired"}  cannot replay from your cursor: re-read the view
event: view.closed     {"reason":"forbidden"}       the view is gone or no longer visible to the key
event: session.ended   {"reason":"key_revoked"}     the key was revoked or expired`
    },
    {
      type: 'ul',
      items: [
        'The view must be visible to the key’s user (their own, shared, or shared to their role) and its collection readable; a view that filters on a field the key cannot read is refused (403) — otherwise the stream would reveal that field one record at a time.',
        'Every event’s id is the realtime journal sequence. Reconnect with Last-Event-ID and the missed events replay from the last 24 hours; delivery is at least once, so dedupe by id. `entered: true` marks a record that has just started matching.',
        'Access is re-checked every 25 seconds: a revoked or expired key, a deleted or unshared view, or a lost permission closes the stream.',
        'Views over 5,000 records report deletes only for records the stream has seen match.'
      ]
    }
  ]
}
