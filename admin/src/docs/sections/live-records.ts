import type { DocSection } from '../types.js'

export const collabLiveRecords: DocSection = {
  id: 'live-records',
  label: 'Live Records',
  content: [
    { type: 'h1', id: 'live-records', text: 'Live Records' },
    {
      type: 'p',
      text: 'An open record keeps up with what other people and automations do to it, without a reload. The server only says THAT something changed (record id and field names, never values); each panel then re-reads through its own permission-checked request, so nobody sees a value they could not already open.'
    },
    { type: 'h3', id: 'live-records-what', text: 'What updates on its own' },
    {
      type: 'table',
      head: ['When', 'What you see'],
      rows: [
        [
          'Someone else moves the record',
          'The state badge, pipeline panel and transition buttons refresh, and a toast says who moved it where ("Kim moved this to Finance Review").'
        ],
        [
          'Owners change (owner matrix, delegation, out of office, team membership)',
          'The owners chip and approval chain refresh.'
        ],
        [
          'Someone else deletes the record',
          'A banner says the record was deleted and saving is turned off. Administrators, and whoever deleted it, also see who and when, and get a Restore button when they have create permission.'
        ],
        [
          'Your access changes (role, policy, row filter, User Scope, subtree grant)',
          'The page re-reads the record as you. If you can no longer see it, the form is cleared — its values, history, comments and any unsaved edits leave the screen and the page’s cache — and only "You no longer have access to this record" with a Back button remains.'
        ],
        [
          'An addendum is created, submitted, approved or rejected',
          'The record’s addendum view refreshes, and list/queue addendum badges follow.'
        ],
        [
          'Comments or tasks are added or closed',
          'The record’s comments and tasks refresh; open-task counts on collection lists and queues, and comment counts on grid rows, update in place.'
        ],
        [
          'A partner push lands, fails or is acknowledged',
          'The Integrations chip and its dialog refresh.'
        ],
        [
          'The after-save integrity check finishes',
          'The integrity banner (or the Summary-mode field marks) refresh at once.'
        ],
        [
          'Fields change while you are in Summary mode',
          'The values refresh and the ones that moved briefly highlight.'
        ],
        ['The history panel is open', 'New changes appear at the top, marked New.'],
        [
          'A flow run is working on the record',
          'A banner names the flow ("Automation is updating this record") until the run ends.'
        ],
        [
          'The same record is open with unsaved changes in another tab of your browser',
          'A banner warns you before you edit here too, with a button that asks the other tab to come forward (browsers may only flag its title).'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Your own saves never echo back as "someone else": writes this tab sent are recognised for a few seconds and skipped.'
    },
    { type: 'h3', id: 'live-records-events', text: 'Socket events' },
    {
      type: 'table',
      head: ['Event', 'Room', 'Payload'],
      rows: [
        [
          '`collection:update`',
          '`collection:<name>`',
          '`{collection, item, action?, changed_fields?}`. A notice with no `action` whose fields are all `$` names (`$state`, `$addendums`, `$comments`, `$tasks`, `$integrations`) says a related surface moved, not the record’s columns.'
        ],
        ['`record:integrity`', '`record:<collection>:<id>`', '`{collection, item}`'],
        [
          '`record:automation`',
          '`record:<collection>:<id>`',
          '`{collection, item, flow_id, flow_name, state: start|end}`'
        ],
        [
          '`owners:changed`',
          'the tenant (cloud: `t:<tenant>:all`; self-hosted: every socket) — coalesced 5 s, at most one per 15 s',
          '`{at}`'
        ],
        [
          '`access:changed`',
          'the tenant for an administrator’s access write; only the person’s own sockets for their own scope pick — coalesced',
          '`{at}`'
        ]
      ]
    },
    {
      type: 'p',
      text: '`GET /api/trash/record?collection=&item=` answers the latest deletion of one record (`deleted_at`, `deleted_by_name`, `can_restore`, and `trash_id` only when you may restore it) — to an unrestricted administrator or to the person who deleted it. Everyone else gets `{ "data": null }`, the same answer as "not deleted": the trash snapshot cannot be checked against your row filter or User Scopes.'
    },
    { type: 'h3', id: 'live-records-hooks', text: 'Building a live panel (shared hooks)' },
    {
      type: 'pre',
      code: `import { useLiveRecord, useLiveRecordQueries, useLiveCollection,
  useLiveRecordEvent, useLiveEvent, batchTouches, LIVE_ASPECTS } from '@nivaro/shared'

// Refetch react-query keys when this record changes (someone else's write):
useLiveRecordQueries('orders', id, [['my-panel', 'orders', id]], { client: queryClient })

// Custom reaction — events inside 250 ms arrive as one batch:
useLiveRecord('orders', id, (batch) => {
  if (batch.deleted) return showGone()
  if (batchTouches(batch, LIVE_ASPECTS.state)) refetchState()
  if (!batch.aspectsOnly) refetchRecord()
})

// A whole list:
useLiveCollection('orders', (batch) => refreshRows(batch.ids), {
  match: (ev) => visibleIds.has(String(ev.item))
})

// A record-room event:
useLiveRecordEvent('record:integrity', 'orders', id, () => refetchIntegrity())`
    },
    {
      type: 'ul',
      items: [
        'Handlers live in a ref — pass inline arrows. Options: `debounceMs` (default 250; 0 = per event), `includeOwn`, `match`, `enabled`.',
        'A batch reports `ids`, `changedFields` (null = unknown, treat as everything), `aspectsOnly`, `created`, `deleted`, `own`.',
        'Without a host realtime adapter the collection hooks do nothing and the panel behaves as before. Hosts whose record room rides a separate socket forward its events with `relayLiveEvent(event, payload)`. A portal or headless app gets the adapter from the socket it already holds with `createSocketRealtime({ socket })` (see React — Live Data), and `useLiveRecord` / `useLiveList` in `@nivaro/react` wrap these hooks around a react-query read.',
        'Never trust a payload value — re-read through your own permission-checked query.'
      ]
    },
    { type: 'h3', id: 'live-ops-pages', text: 'Live operations pages' },
    {
      type: 'p',
      text: 'Readiness, the Issue log, the Support desk, Team pages and the person page team-load card, My Work, the Delegation console and Broadcast receipts refresh on their own when what they show changes. The server sends one small `ops:changed {topic}` event to a topic room; the page re-reads through its normal permission-checked route. A poke never names a row, a person or a value, and a burst of writes is one poke.'
    },
    {
      type: 'table',
      head: ['Topic', 'Who may join', 'What moves it'],
      rows: [
        ['`readiness`', 'Administrators', 'A finished run of the checks (the report rides the event, so other open pages show it without re-running) and a fix finishing'],
        ['`issues`', 'Signed-in users', 'Any write to the issue log: new issues appear at the top, occurrence counts tick'],
        ['`issue:<id>`', 'Administrators', 'Each new occurrence of that issue: the person (id), route and build, streamed into the open issue'],
        ['`support`', 'Signed-in users', 'Tickets, claims, replies and status moves'],
        ['`team`', 'Signed-in users', 'Owner changes, tasks, SLA acknowledgements and escalations'],
        ['`my-work`', 'Signed-in users', 'Owner changes, tasks, approvals; new notifications arrive on your own room. New rows highlight briefly'],
        ['`delegation`', 'Signed-in users', 'Out-of-office, delegate and owner-seat changes'],
        ['`broadcasts`', 'Administrators', 'Deliveries, acknowledgements and notifications being read']
      ]
    },
    {
      type: 'pre',
      code: `import { useLiveOps, useFreshIds } from '@nivaro/shared'

// Refetch when the topic pokes (inert without a host realtime adapter):
useLiveOps('support', () => queryClient.invalidateQueries({ queryKey: ['support-tickets'] }))

// A short highlight for rows that arrived after the first load:
const fresh = useFreshIds(rows.map((r) => r.id))`
    },
    {
      type: 'note',
      text: 'Writes are noticed at the database driver (the same seam that signals "who owns what changed"), so raw SQL, procedures and imports poke the pages too. Pages keep a slow safety poll in case an event is missed.'
    }
  ]
}

export const collabLiveOps: DocSection = {
  id: 'live-ops',
  label: 'Live Operations Screens',
  content: [
    { type: 'h1', id: 'live-ops', text: 'Live Operations Screens' },
    {
      type: 'p',
      text: 'The operations screens, and help videos, follow what is happening without a reload. As with live records, the server only says THAT something moved (ids, counts and field names — never values); each screen re-reads through its own permission-checked request. A slow poll stays underneath as the safety net, so a screen is never worse off when the socket is down.'
    },
    {
      type: 'table',
      head: ['Screen', 'What moves on its own'],
      rows: [
        [
          'Data Integrity — Form conformance',
          'A running sweep shows a progress bar per collection (records checked of the table’s size, issues so far) and its findings appear in the run as the sweep goes. Sweeps started by someone else or by the nightly schedule appear too.'
        ],
        [
          'Background Jobs',
          'Running jobs, next-run countdowns and each job’s last outcome update as jobs start and finish. Open the arrow on a run to see its log lines and progress as the job writes them (kept for a day).'
        ],
        [
          'Header (administrators)',
          'While a heavy job, bulk run, render or import is running, a pill reads "System busy: nightly reforecast running, about 12 minutes left". The estimate is the median of that job’s last completed runs; with no history it only says "running". Click it to open Background Jobs.'
        ],
        [
          'Help videos',
          'A video that was "getting ready" starts playing by itself when its render completes. While you watch, a newer published version is offered with a Switch button that keeps your place in the recording where the new cut allows. The Videos button’s required count follows publishes and requirement changes. A viewer’s question shows the author’s reply as soon as it is posted, and authors see new questions arrive.'
        ]
      ]
    },
    { type: 'h3', id: 'live-ops-events', text: 'Socket events' },
    {
      type: 'table',
      head: ['Event', 'Room', 'Payload'],
      rows: [
        [
          '`conformance:progress`',
          '`watch:conformance` (administrators; per tenant in cloud)',
          '`{run, collection, status, checked, violations, total}`'
        ],
        ['`job:update`', '`watch:jobs` (administrators)', 'run id, kind, job id, status, progress'],
        [
          '`job:log`',
          '`watch:jobs` (administrators)',
          '`{id, log: {seq, at, level, line}}` — lines are written by the job itself or are lifecycle/progress lines'
        ],
        [
          '`help-video:changed`',
          'every socket of the tenant',
          '`{video_id, kind}` — kind is render, published, required or archived'
        ],
        [
          '`help-video:question`',
          '`user:<id>` of the asker or the authors',
          '`{video_id, question_id, kind}` — kind is asked or answered'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Routes: `GET /job-runs/:id/log?after=<seq>` (the lines a page missed) and `GET /job-runs/busy` (what is running now, with estimates). Both are administrators only.'
    },
    {
      type: 'pre',
      code: `import { useLiveEvent, useLiveWatchRoom } from '@nivaro/shared'

// Join an administrators-only room while mounted; false = no live adapter, keep polling.
const live = useLiveWatchRoom('conformance')
useLiveEvent('conformance:progress', (p) => setProgress(p), { includeOwn: true })`
    }
  ]
}
