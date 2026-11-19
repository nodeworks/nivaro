import type { DocSection } from '../types.js'

export const overviewPageDocs: DocSection = {
  id: 'overview-page',
  label: 'The Overview page',
  audience: 'all',
  content: [
    { type: 'h1', id: 'overview-page', text: 'The Overview page' },
    {
      type: 'p',
      text: 'Overview (the first page after signing in, route `/`) shows what needs you and what changed, computed as you: a number never counts a record you cannot open, and figures only administrators may see are left out for everyone else.'
    },
    { type: 'h2', id: 'overview-header', text: 'Greeting and since your last visit' },
    {
      type: 'ul',
      items: [
        'The greeting says how many things need you (records waiting on you, your tasks, approvals and questions — the same counts as My Work) and how many of your records someone else changed since your last visit. Parts that are zero are left out.',
        '“Since Tuesday: 38 records changed, 1 release, 1 new person” sums up what happened since your previous visit. Click it for the list: your records that changed (with how many changes), the release, new people and failed jobs (the last two for administrators).',
        'A visit is a sitting: opening Overview again within 30 minutes keeps the same starting point. A last visit more than 14 days ago reads as “In the last 14 days”.'
      ]
    },
    { type: 'h2', id: 'overview-figures', text: 'Today’s figures' },
    {
      type: 'table',
      head: ['Figure', 'Compared with', 'Opens', 'Who sees it'],
      rows: [
        [
          'Records changed today (with changes per hour, last 24 hours)',
          'Yesterday up to the same time',
          'The records (one row per record) and every change, broken down by collection, person and hour',
          'Everyone — non-administrators count only records they can open'
        ],
        [
          'People active today',
          'Yesterday up to the same time',
          'Who they are: role, first and last seen, entries, records changed and opened, here now',
          'Administrators'
        ],
        ['Failed jobs, 24 h', 'The 24 hours before', 'Each failed run', 'Administrators'],
        [
          'Open issues',
          'Open issues 24 hours ago',
          'Each open issue',
          'Everyone — non-administrators count the issues they raised or were assigned'
        ]
      ]
    },
    { type: 'h2', id: 'overview-today-drill', text: 'Drilling into a figure' },
    {
      type: 'p',
      text: 'Each figure opens a side sheet showing what the number is made of. It reads the same source over the same window as the figure: from your midnight to when the figure was worked out. So the sheet shows the number on the tile. Every row goes one level deeper. A breadcrumb trail and Back walk up. Each level is a link (`?today=records|people|jobs|issues|slot` with `td_…` parameters).'
    },
    {
      type: 'ul',
      items: [
        '**Records changed today**: the record and change counts, changes per hour (a bar shows that hour’s changes), and the top collections and people (each one a filter). **Records** lists one row per record with its number of changes and its last change. A record opens its changes today. **Every change** (administrators) is the Activity table locked to today’s record changes.',
        '**People active today**: one row per person with an entry today, reads included. Each row shows role, first and last seen, entries, records changed, records opened and a dot when they are here now. Sort any column, find by name, or filter by role. A person opens their activity today in the Activity table.',
        '**Failed jobs, 24 h**: each failed run with what it said. A run opens with its error, outcome, log lines and Run now (scheduled jobs only, after a second press, because a run repeats its effects).',
        '**Open issues**: open and in-progress issues, sorted by severity, last seen, newest or count. An issue opens in the issue log’s own detail panel.',
        '**Today on this instance**: a half-hour slot opens every event in it. A job run opens its detail and a config change its activity entry.',
        'Any activity row opens one entry to the last leaf, the same detail as the Activity table’s drawer.'
      ]
    },
    { type: 'h2', id: 'overview-sections', text: 'Sections' },
    {
      type: 'ul',
      items: [
        'Quick actions — the screens you pinned, then the ones you opened most in the last 30 days, then a starting set for your role. Use the pin to keep or drop one, and “Pin a screen” to add any screen you may open.',
        'Pinned widgets — dashboard widgets you pinned with the pin on the widget (up to 8). Each figure is computed as you, the same as on its dashboard.',
        'Recently viewed — records you opened lately with their current state; three or more from one collection are grouped. A dot marks a record that changed after you last looked.',
        'Recent activity — plain sentences of what changed. Choose Everyone (administrators), Mine, or My records: records you own in a pipeline, created, or starred. Overview remembers the choice on this device.',
        'Your work — what is waiting on you and the tasks due soonest; opens My Work.',
        'This instance (administrators) — version, environment, database, session store, extensions, flows and who is online, in one grid.'
      ]
    },
    {
      type: 'note',
      text: 'Administrators see new entries and figures as they happen. For everyone else Overview refreshes every minute.'
    },
    { type: 'h2', id: 'overview-customize', text: 'Customize' },
    {
      type: 'ul',
      items: [
        'Customize (top right) lists every section with Move up, Move down and a Show switch. Changes save as you make them, for you only.',
        'Some sections (Issues) can sit in either column: the two-way arrow moves one to the top of the other column, and it changes its layout to fit (compact rows on the side, a table in the main column).',
        'Reset to my role’s default drops your own arrangement and brings back your role’s starter layout (or the built-in one when your role has none).',
        'Administrators: Role starter layouts sets, per role, the order and sections its people start from. Anyone who already customised keeps their own until they reset.',
        'On a phone the figures scroll sideways, the side column moves under the main one, and the Needs you section comes first.'
      ]
    },
    { type: 'h2', id: 'overview-api', text: 'API' },
    {
      type: 'pre',
      code: `GET  /api/overview/stats?day_start=<ISO local midnight>   # figures + 24 hourly bars, as the caller
GET  /api/overview/since                                 # since-last-visit digest (null on a first visit)
POST /api/overview/visit                                 # roll the last-visit watermark (30-minute sitting)
GET  /api/overview/prefs                                 # own layout, pins, role starter
PUT  /api/overview/prefs {layout?, pinned_actions?, dismissed_actions?, pinned_widgets?}   # layout null = role default
GET  /api/overview/my-routes                              # own most-opened admin screens, 30 days
GET  /api/overview/pinned-widgets                        # own pinned widgets still visible to the caller
GET  /api/overview/role-defaults                         # admin
PUT  /api/overview/role-defaults {defaults: {<role id>: {order, hidden, shown, columns?}}}  # admin; columns = {<key>: main|side} for movable sections
GET  /api/activity?scope=mine|my_records                 # open to anyone signed in (not scoped keys / connected apps)
GET  /api/overview/today/records?day_start=&until=&collection=&person=&offset=&limit=   # the records figure's rows + breakdown, as the caller
GET  /api/overview/today/people?day_start=&until=        # admin: one row per person the figure counts
GET  /api/overview/timeline/slot?start=<slot start>      # admin: every event in one timeline slot
GET  /api/job-runs?status=error&since=&until=            # admin: the failed runs the figure counts (also ?id=)`
    },
    {
      type: 'p',
      text: 'Personal settings live in `nivaro_users.preferences.overview`; role starter layouts in `nivaro_settings.overview_role_defaults` (migration 522). `scope=my_records` judges every record as the caller first, and non-administrators never get IP addresses or field changes their role cannot read.'
    }
  ]
}
