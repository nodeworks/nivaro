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
          'A partner push lands, fails, is acknowledged or is skipped (a partner rule, a guard, a held send), or the nightly check finds a partner that should have been told',
          'The Integrations chip and its dialog, the "Waiting to send" / failure lines and the external ids refresh.'
        ],
        [
          'A change proposal is made, accepted, declined or withdrawn',
          'The Change proposals panel and the Propose button refresh.'
        ],
        [
          'A GitLab issue linked to the record (or to a request raised from it) is closed, reopened, relabelled, linked or unlinked',
          'The GitLab chip refreshes, and so does the "Help requested" chip when the request moved.'
        ],
        [
          'Someone changes one of the record’s dynamic attributes',
          'The attributes panel refreshes.'
        ],
        [
          'A deleted line or linked record is restored (Trash, Undo in the activity log, Ask AI plan undo, rollback, merge undo)',
          'The parent’s line grid, child summary and totals refresh, and tasks the restore reopened appear.'
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
          'Someone links, renames, replaces or removes one of the record’s files',
          'The Files panel and file fields refresh quietly. A new file fades in where it lands; a file someone else removed stays a few seconds as a faded "Removed" row instead of vanishing. Your own uploads and removals never do either. You only ever see files you may read.'
        ],
        [
          'A child or linked record changes (a line added, a PO created from the record, an invoice matched to it)',
          'The record’s line grids, link lists, related panel and record widgets refresh quietly, without a flash and without touching what you are typing. Totals the change moves (stored rollups) refresh on their own. A burst of many records (an import) arrives as one refresh.'
        ],
        [
          'Someone adds, renames or removes a record a dropdown lists (a vendor, a project, a lookup value)',
          'The dropdown reads its options again the next time you open it, so the new record is there. An open dropdown never reshuffles under you; picker filters, cascades and your permissions still apply.'
        ],
        [
          'A flow run is working on the record',
          'A banner names the flow ("Automation is updating this record") until the run ends.'
        ],
        [
          'Who owns the record changes without anyone editing it (owner matrix, a delegation or out-of-office starting or ending, a hand-over)',
          'The owners chip and approval chain update quietly. Lists, queues and My Work pick up records that became (or stopped being) yours.'
        ],
        [
          'An administrator changes your role, policies, field access or User Scopes',
          'Menus, buttons, fields and list rows appear or go without signing out. A record you can no longer read says so calmly instead of erroring.'
        ],
        [
          'Someone joins, or changes their name, title, photo or out-of-office status',
          'Pickers, @mentions, people cards and avatars show the change.'
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
          "`{collection, item, action?, changed_fields?}`. A notice with no `action` whose fields are all `$` names (`$state`, `$addendums`, `$comments`, `$tasks`, `$integrations`, `$files`, `$related`) says a related surface moved, not the record’s columns. `$files` and `$related` ride other records’ writes: they are coalesced per collection over one second, and a second that names more than 50 records of one collection arrives as one collection-wide notice (`item: '*'`)."
        ],
        ['`record:integrity`', '`record:<collection>:<id>`', '`{collection, item}`'],
        [
          '`record:automation`',
          '`record:<collection>:<id>`',
          '`{collection, item, flow_id, flow_name, state: start|end}`'
        ],
        [
          '`collection:update` with `$owners`',
          '`collection:<name>` + `record:<name>:<id>`',
          "`{collection, item, changed_fields: ['$owners']}` — sent only for OPEN records (live viewers, at most 300) whose resolved owners moved; owners are never computed for every record"
        ],
        [
          '`owners:changed`',
          'the tenant (cloud: `t:<tenant>:all`; self-hosted: every socket) — one per burst of owner changes',
          '`{at, collections?, checked?, queues?}` — `checked`: open records were told one by one; `queues`: materialized worklists finished re-syncing their owners'
        ],
        [
          '`access:changed`',
          'only the people a change can touch: the person named, a role’s holders (a policy’s role, an access request’s role), or the tenant when it cannot say — coalesced',
          '`{at, perms: true}` — the client refetches the signed-in user and what is on screen as them'
        ],
        [
          '`people:changed`',
          'every fully signed-in socket of the tenant — coalesced 1 s, at most one per 3 s',
          '`{at, user_ids?, created?}` — ids only (never a name, value or credential); no `user_ids` = anyone'
        ]
      ]
    },
    {
      type: 'p',
      text: '`GET /api/trash/record?collection=&item=` answers the latest deletion of one record (`deleted_at`, `deleted_by_name`, `can_restore`, and `trash_id` only when you may restore it) — to an unrestricted administrator or to the person who deleted it. Everyone else gets `{ "data": null }`, the same answer as "not deleted": the trash snapshot cannot be checked against your row filter or User Scopes.'
    },
    {
      type: 'p',
      text: 'Owner changes are heard where they are written (the owner tables, delegate and out-of-office columns) and by the 15-minute out-of-office sweep, which also catches a delegation that simply ran out. A bulk owner change (an owner-matrix spreadsheet apply) may call `ownerChangeBaseline()` before it writes and `announceOwnerChange({collections})` after (services/owner-change-live.ts) so each open record is told exactly whether its owners moved.'
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
    { type: 'h3', id: 'live-records-queries', text: 'Queries that say what they read' },
    {
      type: 'p',
      text: 'A react-query read can skip the hooks above and simply declare what it reads. The host mounts one bridge (`useLiveQueryBridge()` — the admin app and efp-new do it in their shell), and socket events then refresh exactly the queries they touch.'
    },
    {
      type: 'pre',
      code: `import { liveQueryMeta, useLiveRefetchInterval } from '@nivaro/shared'

// A count of open orders: refreshed by any write to orders (at most once per 10 s).
const poll = useLiveRefetchInterval(60_000, { requireBridge: true })
useQuery({
  queryKey: ['open-orders'],
  queryFn,
  refetchInterval: poll, // 60 s without a live socket, a 5-minute safety net with one
  meta: liveQueryMeta({ reads: ['orders'], fields: ['status'] })
})

// One record's panel: refreshed only by writes naming it, or by a $state move.
useQuery({
  queryKey: ['order-summary', id],
  queryFn,
  meta: liveQueryMeta({ record: { collection: 'orders', id }, aspects: ['$state'] })
})`
    },
    {
      type: 'ul',
      items: [
        'Meta keys: `reads` (collections), `record` (`{collection, id}`), `fields` (only writes naming one of them count; creates, deletes and writes naming no fields always do), `aspects` (`$state`, `$comments`… — aspect notices are ignored otherwise), `includeOwn` (default on for `reads`, off for `record`, whose save already refreshed it), `minGapMs` (default 10 s for `reads`, 0 for `record`; a trailing refresh is never dropped), `reconcileOnly`, `staleOnly` (events only mark it stale and it reads again the next time it is shown — picker option lists use it through `pickerOptionsMeta(collection)`, so an open dropdown never reshuffles).',
        'The bridge joins the collection rooms that active tagged queries read and leaves them 30 s after the last one goes. Events coalesce for 300 ms per collection. Only queries on screen refetch; the rest are marked stale and refetch when they next mount. A hidden tab marks stale and refetches when it is shown again.',
        'Reconcile — every tagged query plus the active record, list, queue, My Work and widget reads refetch once — after a reconnect whose catch-up could not replay the gap (`status().resumed` is `unverified`), on `nvr:catchup-full`, and when a tab comes back after being hidden five minutes or more. A reconnect that replayed every missed event does not reconcile.',
        'Resync after any reconnect or a wake from sleep: only collection events are journaled, so notifications, read markers, ops pokes (`ops:changed`), owner changes and chat messages sent while the socket was down never come back in the catch-up. After every reconnect — whatever `resumed` says — and when the machine wakes from sleep, each held `useLiveOps` topic is poked once (`{topic, reconnect: true}`) and the bridge re-reads the active queries named in `LIVE_RESYNC_HEADS` (the bell, chat, owner chips, My Work) plus the host’s `resyncHeads`. One burst per tab, spread over up to 4 s; a hidden tab runs it when shown; Live updates Off skips it. Listen yourself with `onResync(adapter, cb)`, `useResync(cb)` or the window event `nvr:resync`.',
        'Open lists and queues follow schema and layout pushes (`config:update`): a push naming the collection (or naming none) re-reads the list’s field and browser settings once — `useConfigUpdateRefresh(collections, keys)` for your own screens. Picker option lists also go stale when a record is hidden from pickers (`$picker`).',
        'At sign-in the server sends `catchup:cursor {seq}` — the event journal position — so a tab that has not received an event yet still replays its gap after a reconnect instead of missing it.',
        'Permissions: the refetch runs through the query’s own route as the viewer. An event naming a record the viewer cannot read only re-asks for what they could already see.',
        'The notification badge, the Issue log, broadcast receipts, a record’s partner submissions, a help video’s render status and the chat Online list follow socket events the same way: while the socket is live their polls drop to a safety net (five minutes; two for the badge, since a timed snooze coming back sends no event). Operations pages with no event behind them (Traffic Map, health, logs, jobs, crons) keep polling, and only while the tab is visible.'
      ]
    },
    { type: 'h3', id: 'live-records-round2', text: 'Moves, deadlines, replies and widgets' },
    {
      type: 'ul',
      items: [
        'Move buttons follow other people’s changes. When someone else fills the field a move needs, a partner writes back a PO number, a file is uploaded or a line is added, the pipeline panel asks again which moves you may make and the button appears (or goes away) without a reload. It asks at most once every 1.5 seconds per record, and waits while you have a move’s confirm or requirements open.',
        'Deadlines count down. The SLA line on a record, the SLA column on queues and the chips on My Work say "due in 1 h 59 m" or "overdue by 20 m" and turn amber and red at the rule’s own lines, from times the server already sent — nothing is re-read to tick. One page clock moves every 30 seconds and pauses while the tab is hidden.',
        'Clocks that pass a line with nobody writing are announced. Every minute the server checks the SLA collections someone has open and tells their pages about records that just turned amber or red (the `$sla` notice, ids only), so counts and colours are right without a reload. Highlight (at-risk) rules compare field values, never the time, so they do not change by themselves.',
        '"Beth is replying…" shows under a record’s comments and inside a field’s comment thread while someone types there. It stops 6 seconds after their last keystroke or when they send. A field thread’s signal reaches only people who may read that field; everyone else sees nothing.',
        'Record widgets (custom query panels, roll-ups, review lists and widgets fed from the record) refresh when someone else changes the record or a line under it — the `$related` notice — at most once every 5 seconds each, worked out as you. A folded widget refreshes when it is opened.'
      ]
    },
    {
      type: 'note',
      text: 'New notices on `collection:update`: `$sla` (an SLA clock passed its warning or breach line) and `$related` (a child row of the record changed; one per parent per 0.8 s). List pages ignore both for their rows. SLA answers (`GET /sla/status/:collection/:item`, `POST /sla/status/batch`, queue rows, My Work) now carry `warning_at` and `due_at` (queue rows: `sla_warning_at`, `sla_due_at`). A `record:signal` of kind `note` may carry `field`.'
    },
    { type: 'h3', id: 'live-records-access', text: 'Access, maintenance and search' },
    {
      type: 'ul',
      items: [
        'A record or list that said "You can\'t view this" opens by itself when an administrator grants the access request while it is still on screen. The content appears with one quiet line, "Access granted by Beth" (who decided comes from `GET /api/access-requests/mine`, the person\'s own request only). Nothing pops up.',
        'The Request access page a new person waits on (efp-new) opens the portal by itself the moment an administrator approves them. The approval reaches their own socket as `access:changed`; the page still checks every minute while the connection is down.',
        'The full maintenance page returns to the app by itself when maintenance ends — switched off by an administrator, a scheduled window closing, or a rebuild job deleting its Redis flag. The server notices the change (within a few seconds for the Redis flag) and sends `announcements:changed`; each tab re-reads `/announcements/active` as itself. The 30-second check stays as the fallback. The maintenance strip administrators see goes away the same way.',
        'A record saved a moment ago is found by search on the next look. The server keeps a search answer for 20 seconds only until any collection it searched is written, here or on another server; where SQL Server full-text indexes are in use, the newest 200 rows of a collection are also matched by plain text until the index catches up.'
      ]
    },
    { type: 'h3', id: 'live-records-round5', text: 'Two tabs, record chat, covering and compare' },
    {
      type: 'ul',
      items: [
        'The same record open in two of your tabs stays in step. When you save in one, the other shows the saved values at once (a short fade on the fields that save changed). While the other tab holds unsaved changes, this one says so in one quiet line — "Also open in another tab — editing there" — with a link to switch to it. If both tabs hold unsaved changes, both say so; save one first, and the other then asks about any field changed in both, the same way it does for someone else’s save.',
        'The chat button in a record’s header shows how many messages in the record’s room you have not read, and the count moves as messages arrive or as you read the room anywhere — no reload. Only people who may see the room get a count.',
        'When someone who named you their delegate is out, My Work (and Your work on the home page) says "You’re covering for Jane Smith today — 4 of Jane’s records need you". Show them narrows the waiting list to those records. The count drops as records are handled, and the line goes away when the cover ends or Jane is back. Records you own yourself are not counted — they would need you anyway.',
        'Compare (two or three records side by side, from a list’s selection) stays live: a save to either record re-reads it as you, the changed values fade in place, and the difference count follows. With Differences only on, a row already shown stays put even when the values become the same, so nothing jumps under you.'
      ]
    },
    {
      type: 'note',
      text: 'Socket notice `record:chat {collection, item}` goes to the record room when a message lands in that record’s chat room (ids only); pages re-read `GET /api/chat/record-room` as the viewer. `GET /api/my-work/covering` answers `{covering: [{user_id, name, first_name, ends_at, records, keys}]}` for the signed-in person — one quick read when they cover nobody. The tab channel’s `saved` note carries field names only, never values.'
    },
    { type: 'h3', id: 'live-records-comments', text: 'Replies, seen by and who a mention reached' },
    {
      type: 'ul',
      items: [
        'Replies while you type. If someone posts a comment on the record while you have an unsent comment in the box, a small note above the box says "2 new replies since you started typing" and lists them — name, first words, when. Nothing scrolls; click a name to go to that reply. The note goes when you post, empty the box or close it with ✕. A field’s comment thread does the same for replies on that field.',
        '"Seen by Beth, Mark" under a comment names the people who opened the record after it was written. Hover or click it for the full list with times. It only ever names people who may open this record — and, for a comment on one field, read that field — never the person who wrote it, and never you. People a comment mentions keep their own line ("Beth saw this 2 h ago"), so the seen line then reads "Also seen by". With live updates set to Calm or Off it shows a count ("Seen by 3") and the names on hover, and the mention line becomes one summary ("3 mentioned · 2 seen").',
        'An administrator using View as never counts as the person seeing anything: opening a record or marking a notification read in a View-as tab leaves the person’s marks alone.',
        'Who a mention reached. On a comment you wrote that mentions people, Delivery opens one line per person: Seen in app (with the time), In their notifications but not seen yet, Phone or browser alert sent, Emailed 10:42 AM, Email bounced, Teams message sent, or Won’t be told (shown in amber, because it needs you to reach them another way). The mention line under your comment says the same thing ("Kim Lowe won’t be told"). Only the comment’s author and administrators see this; only administrators learn that someone muted mentions and why ("Muted — turned off in-app alerts for Mentions"). Everyone else just sees who has seen the comment.'
      ]
    },
    {
      type: 'note',
      text: 'GET /api/comments now carries `seen_by [{id, name, seen_at}]` and `delivery_visible` per comment. GET /api/comments/:id/delivery (the author or an administrator, 403 `NOT_COMMENT_AUTHOR` otherwise) answers per mentioned person `{headline: seen|in_inbox|muted|not_told, seen_at, delivered_at, channels [{key: push|email|teams, status, at}], reason}` from the mention’s notification row, its delivery record and the mail log. Opening a record that reveals someone else’s comment sends the record room the existing `record:comment` notice (ids only), so open threads refresh their seen lines.'
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
        [
          '`readiness`',
          'Administrators',
          'A finished run of the checks (the report rides the event, so other open pages show it without re-running) and a fix finishing'
        ],
        [
          '`issues`',
          'Signed-in users',
          'Any write to the issue log: new issues appear at the top, occurrence counts tick'
        ],
        [
          '`issue:<id>`',
          'Administrators',
          'Each new occurrence of that issue: the person (id), route and build, streamed into the open issue'
        ],
        ['`support`', 'Signed-in users', 'Tickets, claims, replies and status moves'],
        ['`team`', 'Signed-in users', 'Owner changes, tasks, SLA acknowledgements and escalations'],
        [
          '`my-work`',
          'Signed-in users',
          'Owner changes, tasks, approvals; new notifications arrive on your own room. New rows highlight briefly'
        ],
        ['`delegation`', 'Signed-in users', 'Out-of-office, delegate and owner-seat changes'],
        [
          '`broadcasts`',
          'Administrators',
          'Deliveries, acknowledgements and notifications being read'
        ]
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
    { type: 'h2', id: 'config-reach', text: 'Who a config change reaches' },
    {
      type: 'p',
      text: 'When an administrator saves a layout, a field, a rule, a pipeline step or transition, or a draft of the owner matrix, the save shows **This reaches 34 open forms, 12 people right now** — the record pages of the affected collections that are open at that moment, not counting your own. Open the line to see who, with how many forms each. It is worked out from the live connections in memory (`GET /api/realtime/config-reach?collections=…`, administrators only) and refreshed every 15 seconds while shown.'
    },
    { type: 'h2', id: 'search-live', text: 'Search results stay current' },
    {
      type: 'p',
      text: 'While the search palette (⌘K) is open, its record results follow changes to the collections they come from: a renamed record shows its new name in place, a record that no longer matches stays where it was, struck through and marked **No longer matches** (it cannot be opened from there), and new matches are counted on a small **1 new match · Show** pill — Show asks again and lays the results out afresh. Nothing moves under the keyboard selection on its own. It is the same live results the full search page has: every re-ask is your own search, so a record you can no longer see stops matching; bursts of changes are one re-ask, and nothing arrives when live updates are **Off**.'
    },
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
          'Jobs',
          'Running jobs, next-run countdowns and each job’s last outcome update as jobs start and finish. Open the arrow on a run to see its log lines and progress as the job writes them (kept for a day).'
        ],
        [
          'Header (administrators)',
          'While a heavy job, bulk run, render or import is running, a pill reads "System busy: nightly reforecast running, about 12 minutes left". The estimate is the median of that job’s last completed runs; with no history it only says "running". Click it to open Jobs.'
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
        [
          '`job:update`',
          '`watch:jobs` (administrators)',
          'run id, kind, job id, status, progress; `busy: true` on runs the System busy pill counts (long-running kinds and heavy cron jobs)'
        ],
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
    },
    { type: 'h2', id: 'live-surfaces', text: 'Live surfaces and the socket inspector' },
    {
      type: 'ul',
      items: [
        'Notes: comment edits, deletes and reactions (on comments and on recorded notes), plus machine entries (transitions, partner events, import runs, change reasons), refresh in an open record as they happen. The notice carries the `$comments` aspect only; each viewer re-reads the thread as themselves.',
        "Tasks: assigning, claiming, editing, completing and deleting a task refresh the record's Tasks section (`$tasks`).",
        'Record chips in chat and linked record tokens update their state pill when the record moves. No state name travels in the notice; each viewer re-reads the pill with their own access.',
        'Queue item sheets follow their record (state, comments) the way the full record page does; drill sheets rendered by the record form already did.',
        'A record open in a drill-down sheet counts as open: the sheet joins the record room, so the people on that record see the viewer, and its strip shows who else has it open.',
        "Realtime console, Sockets and rooms, Inspect: pick a connected client to see its rooms and the last 100 events sent to it (name, room, size, time, never the payload). Recording is off until an administrator opens the panel and stops when it closes or after 10 minutes unread. Routes (administrators only, caller's tenant only): `GET|POST|DELETE /realtime/sockets/:id/inspect`.",
        'The inspector also lists the events the client sent, with how long the server took to handle each one, and how many bytes are waiting to reach that client.'
      ]
    },
    { type: 'h2', id: 'socket-health', text: 'Socket health' },
    {
      type: 'p',
      text: 'Realtime console → Socket health shows every API server at once (each one reports through Redis every 10 seconds): bytes waiting to be sent, the clients with the most waiting, the biggest rooms, waiting bytes over the last 10 minutes, how long each socket event handler takes (p50, p95, slowest, and the longest stretch one call kept the server busy), and how often a connected client caught up a room after missing an event. Route: `GET /realtime/health` (administrators only, your tenant only).'
    },
    {
      type: 'ul',
      items: [
        'Slow clients: once more than `SOCKET_BUFFER_SOFT_BYTES` (default 1 MB) is waiting to reach a client, it stops getting each room event. When it has caught up it gets one `realtime:stale {rooms}` and reloads what those rooms show.',
        'Past `SOCKET_BUFFER_HARD_BYTES` (default 8 MB) the client is disconnected and its queued events dropped, so one slow client cannot hold server memory. When that tab reconnects it reloads its lists and records instead of replaying (`catchup:full {reason: "slow-consumer"}`).',
        'Missed events while connected: journaled events carry the room they went to (`_room`) and that room’s own counter (`_rseq`). A client that sees the counter skip asks for that room alone (`catchup:room {room, cursor, missed}` → `catchup:room:events {room, full, events}`) instead of reloading everything. The admin app and `createSocketRealtime` both do this.',
        'Missed changes per record: a change of one record also carries that record’s own counter (`_iseq`; a merged burst carries `_iseqs {id: [lowest, highest]}`). A client keeps the last number per record it has seen and, when one skips and the missing change has not arrived 4 seconds later, re-reads that record alone — the list row or the open record, as you — never the whole page. These numbers outlive a reconnect, so a reconnect whose catch-up went unanswered still finds what it missed on the records you are looking at. Clients that ignore the field see no difference.',
        'Connections that repair themselves: a connection can look open while nothing reaches it (the computer slept, the Wi-Fi changed, a proxy dropped it). Each tab’s connection (or the shared worker’s, when tabs share one) is checked after 40 seconds without a word from the server, when the computer wakes, when the tab comes back after 30 seconds or more out of sight, and when the network comes back or changes: one `time:sync` that must be answered within 5 seconds. A dead connection is reopened at once and the usual catch-up replays what was missed. Nothing is shown while that happens; the “Live updates paused” strip appears only if two repairs in a row fail to sign in again within 12 seconds each.'
      ]
    },
    {
      type: 'note',
      text: 'Binary socket frames (msgpack) were measured against JSON with per-message compression on the realtime message mix and not adopted: compressed, msgpack sent about 5% more bytes, and encoding and decoding took about twice as long.'
    },
    { type: 'h2', id: 'live-events-switch', text: 'Turning live updates down for one collection' },
    {
      type: 'p',
      text: 'Table Editor → Settings → Collection Browser → Live updates (`browser_config.live_events`): Every change (default), Batched (changes gathered for 2 seconds and sent as one list of ids) or Off (no live record events, no journal entry, no cross-server stream; lists on the collection refresh every 30 seconds instead). Use Off for import staging tables and other high-churn rows nobody watches live. Other API servers pick up a change within 30 seconds.'
    }
  ]
}

export const collabLiveAdmin: DocSection = {
  id: 'live-admin-signals',
  label: 'Live Sessions & Usage',
  content: [
    { type: 'h1', id: 'live-admin-signals', text: 'Live Sessions & Usage' },
    {
      type: 'p',
      text: 'Two administrator screens keep up on their own: a person’s signed-in browsers and phones, and the instance’s usage figures. Only administrators receive these updates, and the update itself names nothing private — the screen re-reads through the same administrator-only request it always used.'
    },
    { type: 'h2', id: 'live-admin-sessions', text: 'Signed-in browsers and phones' },
    {
      type: 'p',
      text: 'People → a person → Access shows Signed-in browsers (which browser, the address it signed in from, when, and when the session ends) and Signed-in phones. When that person signs in, signs out, is signed out by an administrator or has a phone removed, both lists refresh within about a second; a newly signed-in browser gets a short, soft highlight (none when Live updates are Calm or Off, or when your device asks for reduced motion). Session ids are never shown. Sessions that started before this was added say “Signed in before this was recorded”.'
    },
    {
      type: 'table',
      head: ['Signal', 'Who gets it', 'What it carries'],
      rows: [
        [
          'ops topic `sessions` (`ops:join {topic: "sessions"}`)',
          'Administrators only (checked when the socket joins)',
          '`ops:changed {topic, user_id}` — the person whose sessions changed (or `{all: true}` when one action touched more than 50 people). Never a session id, device, address or token.'
        ]
      ]
    },
    { type: 'h2', id: 'live-admin-usage', text: 'Usage figures' },
    {
      type: 'p',
      text: '`GET /api/usage/live` (administrators) answers what the instance holds right now: records (rows in every table that is not a `nivaro_` system table, from the database’s own running counts — `records.approx` is true, so they can trail a write by a few seconds), file storage (bytes and files), AI tokens used this calendar month (UTC) and people who can sign in (accounts that are not suspended). The answer is kept a few seconds and read once at a time, so many open screens cost one read.'
    },
    {
      type: 'pre',
      code: `GET /api/usage/live
→ { data: { records: { count: 128450, approx: true },
            storage: { bytes: 5368709120, files: 2210 },
            ai: { tokens: 1240000, calls: 812, since: "2026-11-01T00:00:00.000Z" },
            users: { count: 64 },
            at: "2026-11-15T15:42:07.000Z" } }

socket  ops:join {topic: "usage"}   → ops:changed {topic: "usage", at}   (≤ 1 every ~2 s)`
    },
    {
      type: 'p',
      text: 'A record created or deleted, a bulk write announced by a procedure or import, a file added, replaced or removed, an AI call, or a person added, removed, suspended or restored sends one coalesced `usage` notice to administrators watching; the screen then reads `GET /api/usage/live` again. There are no plans or limits here: a hosting layer sets these figures against its own plan (Nivaro Cloud’s Account page shows them as a live meter).'
    },
    {
      type: 'note',
      text: 'Extension UI bundles get `useLiveOps(topic, onEvent, {debounceMs, match})` on `window.__NIVARO__`, and the Account page has an `account-usage` slot: a bundle that fills it replaces the built-in Usage details card.'
    },
    { type: 'h2', id: 'live-admin-allowance', text: 'AI allowance (for hosting layers)' },
    {
      type: 'p',
      text: 'Nivaro sets no AI allowance of its own: a self-hosted instance is never limited by it. A hosting layer can register one from an extension with `ctx.ai.registerAllowance(check)`. Before every AI provider call the check runs in the caller’s context and answers `null` (go ahead) or `{message, action_url?, resets_at?}`; a refusal stops the call with 429 `AI_ALLOWANCE_USED` and that message. A check that throws or takes over 1.5 seconds lets the call through. Extensions can read the same figures as the route with `ctx.usage.read({maxAgeMs})` — `maxAgeMs` reuses an older answer for checks that run on every write (a record limit).'
    }
  ]
}

export const collabPresence: DocSection = {
  id: 'presence-signals',
  label: 'Presence, Do Not Disturb & Tab Sync',
  content: [
    { type: 'h1', id: 'presence-signals', text: 'Presence, Do Not Disturb & Tab Sync' },
    {
      type: 'p',
      text: 'Small live signals tell you who else is on the thing you are working on, and your own state follows you across tabs and devices. They carry names only, never content, and only reach people who could already open the same record, ticket or page.'
    },
    { type: 'h3', id: 'presence-signals-who', text: 'Who is doing what' },
    {
      type: 'table',
      head: ['You see', 'Where', 'Who sees it'],
      rows: [
        [
          '"Beth is replying"',
          'Under the Notes thread while someone has an unsent note',
          'Everyone viewing that record (the record read gate, row filters and User Scopes included)'
        ],
        [
          '"Kim is approving"',
          'A pill on the pipeline panel while someone has a transition confirm or requirements dialog open',
          'Everyone viewing that record. The repeat-transition guard still refuses a second move; this warns before it happens.'
        ],
        [
          '"Kim is looking at this"',
          'A support ticket sheet, and an issue row in the Issue log',
          'People who can open the ticket (requester, assignee, its team, administrators); anyone signed in for an issue'
        ],
        [
          '"Kim is replying"',
          'Above a support ticket reply box while someone is typing a reply',
          'People who can open the ticket'
        ],
        [
          'Online, idle or away, and the page',
          'A person’s page header and their user card',
          'The same people the chat Online list shows: a person restricted to other zones or regions does not see presence outside their own scopes, and the page follows the Presence display setting'
        ]
      ]
    },
    {
      type: 'p',
      text: 'A signal is a heartbeat: the sender repeats it every four seconds while it is true and receivers let it lapse after seven, so a closed tab never leaves a stale "is typing". Typing relays through the record room (`record:signal`), ticket and issue pages through a topic room (`ops:ticket:<id>`, `ops:issue-view:<id>`) whose join is gated like the page and re-checked when access changes.'
    },
    {
      type: 'table',
      head: ['Event', 'Room', 'Payload'],
      rows: [
        [
          '`record:signal`',
          '`record:<collection>:<id>` (sender must already be in it)',
          '`{collection, item, kind: note|transition, state: start|stop, user: {id, name}}`'
        ],
        [
          '`ops:changed` with `viewers`',
          '`ops:ticket:<id>`, `ops:issue-view:<id>`',
          '`{topic, viewers: [{id, name}]}`'
        ],
        [
          '`ops:changed` with `signal`',
          '`ops:ticket:<id>`',
          '`{topic, signal: {kind: reply, state, user}}`, sent from the client with `ops:signal`'
        ]
      ]
    },
    { type: 'h3', id: 'presence-signals-dnd', text: 'Do not disturb' },
    {
      type: 'p',
      text: 'Turn it on from the avatar menu or the chat Online tab, for 30 minutes, an hour, four hours, until tomorrow morning, or until you switch it off. While it is on, toasts and sounds are held on every tab and device, and a red mark shows on your avatar (colleagues see it on your people page while you are online). Notifications still land in your inbox and the badge still counts them. Critical notifications (the Critical lane) still break through with their toast and sound. It is stored as `preferences.dnd = {until}` through `PATCH /users/me/preferences` (`null` turns it off) and syncs live, so ending it in one tab ends it everywhere.'
    },
    { type: 'h3', id: 'presence-signals-mentions', text: 'Read receipts on mentions' },
    {
      type: 'p',
      text: 'Under a note that mentions someone, a line says whether they have seen it. A mention counts as seen once the person opens the record or reads the mention’s notification after the note was written; both come from watermarks the app already keeps (`nivaro_record_views`, `nivaro_notifications.read_at`), so nothing new is tracked. `GET /api/comments` adds `seen_at` to each mention, only for readers who can open that very record. Open thread views update the moment the person opens the record.'
    },
    { type: 'h3', id: 'presence-signals-sync', text: 'Your tabs and devices stay in step' },
    {
      type: 'ul',
      items: [
        'Reading a notification, or a chat room, clears its unread state on every other tab and device at once (`read:changed` on your `user:<id>` room), instead of on their next poll.',
        'Saving a display preference (font size, time format, sound, density, do not disturb…) applies in your other tabs and windows immediately: over a BroadcastChannel in the same browser, over `prefs:changed` on your user room across devices.',
        'The theme (light, dark or system) and the row density of lists and queue worklists (Compact or Comfortable) are saved on your account as `theme` and `table_density`, so a choice made on your laptop shows on your phone and in your other tabs without a reload. A tab opened with "View as" neither saves nor adopts them.',
        'Your saved views, saved searches and Overview pins refetch quietly in your other tabs and devices when you change them (`mine:changed {kind}` on your user room); favorites ride `prefs:changed`, and the shared collection pins reach everyone signed in (`pins:changed`). Nothing blanks or jumps: lists keep what they show until the fresh answer lands.',
        'Relative times ("2m ago", "Last changed 5m ago") move forward by themselves in lists, records, notes, tasks and the inbox. Every one of them rides one shared ticker per tab (30 seconds, paused while the tab is hidden, caught up when you return), so a list of a hundred rows costs one timer; times older than a week read as a date and never tick. Hosts use `<RelativeTime value={...} />` or `useRelativeText(value)` instead of calling `formatRelative` in JSX.',
        'A dot beside a name in people pickers (record people and task assignee), the @ mention list in notes and the chat @ list shows who is online (green) or idle (hollow amber). It is only a dot: nobody moves up the list for being online. It comes from the same presence read as the Online tab, so you only see a dot for people you may see as present.',
        'With several tabs open, a notification or chat sound plays once, from the tab you used last. Tabs that stop answering are ignored, so a frozen tab never takes the sound with it. A "View as" tab keeps its own channels.'
      ]
    },
    {
      type: 'pre',
      code: `import { useRecordSignalPeers, useRecordSignalWhile, useTopicPresence,
  signalSentence, useUserSync, isDndActive } from '@nivaro/shared'

// Others signalling on this record, and your own while a dialog is open:
const approving = useRecordSignalPeers('orders', id, 'transition')
useRecordSignalWhile('orders', id, 'transition', dialogOpen)

// A ticket or issue page:
const { viewers, replying, signalReplying } = useTopicPresence(\`ticket:\${ticketId}\`)

// Once in the app shell (cross-tab read state and preferences):
useUserSync({ onPrefsChanged: refetchMe })`
    },
    { type: 'h3', id: 'presence-signals-rows', text: 'Who has a row open' },
    {
      type: 'p',
      text: 'List rows in the collection browser and in queues show who else has that record open right now: up to three small avatars where the unseen dot usually sits (the browser) or after the label (queues), "+N" when more people are there, and the names in the tooltip. It arrives live through the presence room — a list tells the server which rows it shows (`presence:watch`) and hears `presence:rows` whenever a record\'s viewers change — instead of the old 30 second count poll, which remains the fallback for a host without a realtime adapter. Your own tabs are never counted. Only people you may see as people (the same rule as the Online tab) get a face and a name; the rest count towards the number.'
    },
    { type: 'h3', id: 'presence-signals-hooks', text: 'Presence hooks for headless apps' },
    {
      type: 'pre',
      code: `import { usePresence, useFieldFocus, useTyping, useRowPresence, RowPresence,
  rowPresenceKey } from '@nivaro/react'

// Who else has this record open (joins its room over the host's realtime adapter):
const { viewers } = usePresence('orders', id)

// The field or grid cell each co-viewer is in; announce your own:
const { editing, focus, blur } = useFieldFocus('orders', id, { capture: true })

// "Beth is writing a note" on the comment thread:
const { typing, setTyping } = useTyping('orders', id)

// A list: who has each row open, keyed collection:item
const rowViewers = useRowPresence(rows.map((r) => ({ collection: 'orders', item: r.id })))
<RowPresence viewers={rowViewers[rowPresenceKey('orders', row.id)]} />`
    },
    {
      type: 'ul',
      items: [
        "All four need the host's `RealtimeContext` adapter — `createSocketRealtime({ socket })` over the app's socket, or the shared-worker socket below. Without one they are inert.",
        'Names only, server-gated: the record room admits only people who may open the record; `presence:rows` carries user ids and the names come from `GET /presence/people`, which answers only with people you may see.',
        "The admin's own record page keeps its `useRecordPresence`; these hooks are for portals and headless frontends."
      ]
    },
    { type: 'h3', id: 'presence-signals-worker', text: 'One socket per browser' },
    {
      type: 'p',
      text: "With several tabs open, one browser used to hold one live connection per tab (plus one per open record page). Now every tab of an app attaches to one SharedWorker, served by the API at `/api/realtime/worker.js`, which owns the single connection: it signs in once, keeps the union of every tab's rooms (a room is joined when the first tab needs it and left when the last one goes), runs one catch-up after a reconnect, routes each collection, record and chat room's events to the tabs that hold it, and reports the tab you used last as your current page. Tabs talk to it through `createWorkerSocket` (`@nivaro/react`), which looks like a socket.io socket, so chat, presence and every live surface work unchanged."
    },
    {
      type: 'ul',
      items: [
        'Fallbacks are automatic: no SharedWorker (Safari before 16), a "View as" tab, an API on another origin, a worker that does not answer, speaks another protocol version or goes silent, or a worker whose socket cannot connect while the API answers HTTP — the tab opens its own socket and the older leader-tab relay (one tab carries the noisy rooms over a BroadcastChannel) takes over.',
        "Off switches: `REALTIME_SHARED_WORKER=off` on the server (the script answers 404), or `localStorage.setItem('nvr-realtime-worker', 'off')` in one browser. `/realtime` lists shared-worker connections with the `shared_worker` flag in their hello.",
        'A new release is picked up by the next worker start; a running worker lives until its last tab closes, and a tab meeting a worker from another protocol version simply uses its own socket.'
      ]
    },
    {
      type: 'note',
      text: 'Everything here is best effort and per server node, like the viewer avatars: with several API replicas a viewer list may show only the people connected to the same node.'
    }
  ]
}
