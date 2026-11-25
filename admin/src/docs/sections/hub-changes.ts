import type { DocSection } from '../types.js'

export const hubChangesDocs: DocSection = {
  id: 'hub-changes',
  label: 'Hub change calendar, deploy windows and checklists',
  content: [
    {
      type: 'h1',
      id: 'hub-changes',
      text: 'Hub change calendar, deploy windows and checklists'
    },
    {
      type: 'p',
      text: 'The Apps hub’s Changes tab (`/hub/changes`) shows every change of the apps you look after on one calendar, holds the deploy windows (the times an app may be promoted), and the pre-deploy checklists a production start must have ticked. App owners see their own apps and tick what an item lets them; Hub administrators change the windows, items and planned maintenance. Every change is logged in the activity log.'
    },
    { type: 'h2', id: 'hub-changes-calendar', text: 'Change calendar' },
    {
      type: 'p',
      text: 'Month, week and list views read what the Hub already records, in your own time zone: promotions and rollbacks (with Apply now), scheduled promotions and trains that have not started, release trains, moves, shared deployment upgrades (shown to the owners of apps placed on that deployment), every occurrence of a freeze window, planned maintenance, and entries other Hub features add (for example a certificate expiry). The week view also shows the open hours of the deploy windows. Pick an app to narrow it, and click the legend to hide a kind.'
    },
    {
      type: 'p',
      text: '**Export .ics** downloads the last 30 days and the next 180 as an iCalendar file for Outlook or Google Calendar — for the app picked, or for all the apps you own. It is a file, not a subscription: download it again for later changes. Deploy windows are left out (they are allowed times, not changes).'
    },
    {
      type: 'p',
      text: '**Planned maintenance** (administrators) adds work that is not a deploy — database patching, a network change — to the calendar and the export, for one app or every app.'
    },
    { type: 'h2', id: 'hub-changes-windows', text: 'Deploy windows' },
    {
      type: 'p',
      text: 'A deploy window says when an app may be promoted: weekly ranges (for example weekdays 7 AM–5 PM) read on the clock of the time zone you pick, daylight saving included, or one extra window with a start and an end. A range that ends at or before it starts runs past midnight. A window covers production environments only (the usual choice) or every environment of the app.'
    },
    {
      type: 'table',
      head: ['Rule', 'What it means'],
      rows: [
        [
          'Which windows count',
          'An app’s own windows that fit the environment. When the app has none that fit, the Hub-wide windows (Applies to: every app without its own). None at all: any time. A one-off window that has ended counts no more; a window switched off is kept but not judged.'
        ],
        [
          'What they stop',
          'Promotions and Apply now outside every window that counts answer “Outside the deploy window” (409 OUTSIDE_WINDOW) with the next opening. Moves and shared deployment upgrades are judged by freezes and checklists, not windows.'
        ],
        [
          'Freezes win',
          'Freeze windows and deploy windows are one engine: a freeze is judged first, so a freeze inside a window still stops the start.'
        ],
        [
          'Rollbacks',
          'A rollback to a version older than the one the environment runs now always goes through, window or not. A “rollback” to the same version, a newer one, or while the running version is unknown is a forward deploy and is judged exactly like a promotion.'
        ],
        [
          'Schedules and trains',
          'A scheduled promotion due outside its window waits for the next opening (or fails, when it was set to fail inside a freeze); a release train step waits before it starts. Neither uses up a try.'
        ],
        [
          'Queue it',
          'When the Promote panel says the window is closed, an administrator who typed the environment key can queue the promotion: it becomes a scheduled promotion a minute into the next opening (Releases → Scheduled), which still waits for a freeze.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-changes-checklists', text: 'Pre-deploy checklists' },
    {
      type: 'p',
      text: 'Checklist items belong to an app: a text, optional help, required or optional, who may tick it, and which starts it is for (promotions, moves, shared upgrades). An item applies to every production environment of the app, or to one. Production is decided by the Hub’s production rule (the environment’s flag, its key, what the app reports, its place in the chain). Development and staging never need a checklist.'
    },
    {
      type: 'table',
      head: ['Who may tick', 'Who that is'],
      rows: [
        ['Administrators and app owners', 'Any Hub administrator or an owner of the app.'],
        ['Hub administrators', 'Hub administrators only.'],
        [
          'Named people',
          'Only the people named on the item — administrators too only when named. They open the checklist from the notification or the Changes tab.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'The checklist shows in the Promote, Move and shared Upgrade panels. Ticking the first item opens a checklist for that one start (that environment or deployment, that action, that version); each tick records who, when and an optional note. Start stays off until every required item is ticked. The checklist is used by the run it starts and stored with it — the next start needs a new one. A start that is refused after the checklist was taken (a lock, GitLab not answering) gives it back with its ticks.'
    },
    {
      type: 'p',
      text: 'A shared deployment upgrade gathers the items of every production app placed on it. A scheduled promotion or a release-train step that reaches production opens its own checklist once, tells the people who may tick it (Hub administrators, the app’s owners and anyone named), and waits under **Waiting for a checklist** on the Changes tab. A scheduled promotion is still missed 6 hours after it was due if nobody ticks it, so nothing deploys by surprise.'
    },
    {
      type: 'note',
      text: 'A real rollback (to an older version than the one running) and Apply now never wait on a checklist: going back must never wait on a list. A “rollback” to the same, a newer or an unknown running version is a forward deploy and needs the checklist like a promotion; for a shared deployment, only a rollback below the version the deployment runs is exempt.'
    },
    { type: 'h2', id: 'hub-changes-api', text: 'API' },
    {
      type: 'table',
      head: ['Route', 'What it does'],
      rows: [
        ['GET /api/hub/calendar?from&to&app_id', 'Calendar events in a range (at most 100 days).'],
        ['GET /api/hub/calendar.ics?app_id | owner', 'The iCalendar download.'],
        ['POST/PATCH/DELETE /api/hub/calendar/entries', 'Planned maintenance (admin).'],
        [
          'GET /api/hub/changes/overview',
          'Windows (open now per environment), items, waiting checklists.'
        ],
        ['POST/PATCH/DELETE /api/hub/deploy-windows', 'Deploy windows (admin).'],
        [
          'GET /api/hub/environments/:envId/deploy-window',
          'Open or closed now, and the next opening.'
        ],
        [
          'POST /api/hub/environments/:envId/promote/queue',
          'Queue a promotion for the next window (admin).'
        ],
        ['POST/PATCH/DELETE /api/hub/checklist-items', 'Checklist items (admin; delete archives).'],
        [
          'GET /api/hub/environments/:envId/checklist, /shared/:id/checklist',
          'The checklist a start needs and the open one.'
        ],
        [
          'POST …/checklist-runs, POST /api/hub/checklist-runs/:id/tick',
          'Open a checklist; tick or untick an item (`key` = item@environment). Send its id as `checklist_run_id` with the promote, move or upgrade start.'
        ]
      ]
    }
  ]
}
