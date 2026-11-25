import type { DocSection } from '../types.js'

export const hubIncidentsDocs: DocSection = {
  id: 'hub-incidents',
  label: 'Hub incidents, on-call and status pages',
  content: [
    { type: 'h1', id: 'hub-incidents', text: 'Hub incidents, on-call and status pages' },
    {
      type: 'p',
      text: 'When an app is in trouble the Hub runs the whole response from one place: an incident that freezes the app’s deploys and tells its users, an on-call rota that reaches a person first, a status page for people outside the Hub, and a post-mortem drafted from what the Hub recorded. The screens are the Apps hub tabs Incidents (`/hub/incidents`), On-call (`/hub/on-call`) and Status pages (`/hub/status`). Hub mode only (HUB=on).'
    },
    { type: 'h2', id: 'hub-incidents-open', text: 'Opening an incident' },
    {
      type: 'p',
      text: 'An administrator opens an incident for an app, or for one of its environments, with a title, a severity (SEV 1 = down or losing data for everyone, SEV 2 = a major feature fails for many people, SEV 3 = degraded or a small group) and, optionally, an internal summary and a banner line. Opening it:'
    },
    {
      type: 'ul',
      items: [
        'Freezes deploys for the app: a freeze window tagged as this incident’s (named “Incident #…”) is added, so promotions, stack applies, shared upgrades and moves are refused with 409 FROZEN exactly as under any freeze. A rollback to an older version is still allowed. “Lift freeze” ends it early (a fix that must ship); “Freeze deploys” puts it back. Resolving the incident lifts it. While the incident stays open the freeze is kept on (it is extended before it runs out); a lifted freeze stays lifted.',
        'Shows a banner in the app: one line of plain text (at most 280 characters, never HTML — `<` and `>` are dropped) every signed-in person sees at the top of every page, in admin and in front ends built on the shared banner strip. It goes to the incident’s environment, or to the app’s production environments for an app-wide incident. The Hub sends it over the hub link; the app keeps it for two hours and the Hub refreshes it every 30 minutes, so a banner never outlives a Hub that went away. A push that fails is retried every two minutes; the incident shows where the banner landed.',
        'Starts the timeline: every step above, every page and escalation, notes people add, and the resolution.',
        'Pages on-call (below). An app without a rota tells its owners and the Hub administrators instead (urgent for SEV 1 and SEV 2).'
      ]
    },
    {
      type: 'note',
      text: 'The banner needs the app at Nivaro 0.3.215 or later (it shows “App too old” otherwise) and a hub link: a dedicated app’s HUB_TOKEN, or the shared deployment’s link for an app placed on one. An incident may be opened while a move is open — that is when one is needed; the banner goes to whichever home the app answers from.'
    },
    { type: 'h2', id: 'hub-incidents-oncall', text: 'On-call rotas and escalation' },
    {
      type: 'p',
      text: 'Each app can have one weekly rota: Hub accounts in order (administrators, app owners and people who signed in through the Hub), a hand-over day and time on the clock of a chosen time zone (09:00 Monday in New York stays 09:00 across daylight saving), and the moment the first person starts. Each hand-over passes to the next person, round the list. An override puts someone else on call for a time range (up to 31 days); the newest override wins where two overlap.'
    },
    {
      type: 'p',
      text: 'An urgent Hub alert for an app with a rota that is on — a failed deploy, an automatic rollback, an outage, an incident — goes to the person on call first, then, every N minutes (1–240, default 15) while nobody acknowledges it, to the next escalation step: next on the rota, the app’s owners, the Hub administrators (the person on call is always first, and every chain ends with the owners and then the administrators even when the rota leaves them out; a rota needs at least one person). Every step is a notification through the person’s own channels — inbox, browser and phone push, email — under their own notification rules. Acknowledging (from the notification, the On-call tab or the incident) stops the escalation. A repeat of the same alert (app, environment, kind) joins the page while it is open or acknowledged, however old. A step is recorded before anyone is told and each person is marked once told, so a tick that fails or a Hub that restarts mid-step resumes where it stopped (within two minutes) and tells nobody twice. An app without a rota keeps the old behaviour: its owners and the administrators are told.'
    },
    {
      type: 'p',
      text: 'Outage watch: for an app with a rota that is on, a production environment whose last three minute probes (Fleet uptime) all failed pages on-call — one page for the whole outage, steps at least 30 minutes apart, then a reminder to the person on call every 30 minutes while nobody acknowledges it (a 2-hour outage is at most five notices); once it answers twice in a row the page closes and whoever was paged is told it is back. What a page says depends on who reads it: owners and administrators get the alert’s own words (for an incident: app, environment, severity and title — never the internal summary); anyone else on the rota gets the app name, the kind of environment (production or another), the severity and a generic title, never a version, an environment key or the producer’s text. On the On-call tab such a person sees their own shifts and their own pages as receipts, and acknowledging answers a receipt, never the incident.'
    },
    { type: 'h2', id: 'hub-incidents-status', text: 'Status pages' },
    {
      type: 'p',
      text: 'A status page lists apps (all of them, or the ones picked) with one state word each — Operational, Degraded performance, Partial outage, Major outage, No recent data — taken from the Fleet’s last probe of the app’s production environments and worsened by an open incident of the whole app or of a production environment (SEV 1 major, SEV 2 partial, SEV 3 degraded; an incident on staging never shows), 30 days of daily uptime, the incident banner line when one is open, and planned maintenance for the next two weeks (scheduled promotions and trains as “Planned update”, freeze windows as “Change freeze”, never a version or a freeze’s own name). It never shows a hostname, an address, an environment key, a version, an error text or a person.'
    },
    {
      type: 'table',
      head: ['Kind', 'Who opens it', 'How'],
      rows: [
        [
          'Public',
          'Anyone with the link',
          '`/api/hub/status-page/<token>` — a page with no script that refreshes every minute (`?format=json` for the same answer as JSON). The token is shown once when the page is made or its link replaced; the Hub keeps only its SHA-256. It expires (1–366 days, default 90); Replace link issues a new one and the old link stops working.'
        ],
        ['Internal', 'Everyone signed in to the Hub', 'The Status pages tab. No token.']
      ]
    },
    {
      type: 'ul',
      items: [
        'The public route is the one Hub route with no sign-in, in its own plugin, mounted only with HUB=on. A wrong, expired or replaced link gets the same “does not work” page. The token is masked in every request log, trace and access line.',
        'Apps on a page: none listed (null) = every app the Hub looks after; an empty list = no apps.',
        'Limits: 60 reads a minute and 20 wrong links a minute per address (then 429), 600 reads a minute per page; one answer per page is built at most every 15 seconds and shared.',
        'The page carries the operator’s project name and colour when set (Settings → Project), else the Hub’s own.'
      ]
    },
    { type: 'h2', id: 'hub-incidents-postmortem', text: 'Post-mortems' },
    {
      type: 'p',
      text: 'An administrator drafts the post-mortem from the incident (open or resolved). The Hub collects, from two hours before the incident opened to thirty minutes after it closed: Hub deploys, rollbacks and stack applies of the app’s environments, moves, Fleet alerts, pages, errors first seen in the window (Issues), and uptime — runs of failed probes as “stopped answering … answered again after N min” while the minute samples are kept (48 hours), the hourly rollups after that — plus the incident’s own timeline. People then write the summary, impact and root cause, add follow-up actions with owners, and edit or remove timeline entries. Draft again replaces the document with a fresh draft.'
    },
    {
      type: 'p',
      text: 'Download it as Markdown, or as a PDF (rendered by the Hub’s own Chromium, or by its render peer on a slim image — without either the PDF answers 503 and Markdown still works). Times on both exports are UTC. Owners of the app may read and download; administrators write.'
    },
    { type: 'h2', id: 'hub-incidents-ops', text: 'For operators' },
    {
      type: 'ul',
      items: [
        'Job hub-incident-tick (every minute, Hub only, one leader; scheduled jobs tick only where they are enabled): escalates due pages, refreshes and retries banners, keeps open incidents’ freezes on, runs the outage watch. Its state is the rows, so a tick missed while the Hub was down is picked up by the next.',
        'Tables (migration 576): nivaro_hub_incidents, nivaro_hub_incident_events, nivaro_hub_oncall_rotas, nivaro_hub_oncall_overrides, nivaro_hub_pages, nivaro_hub_status_pages. Created everywhere, used only with HUB=on; never promoted, and an environment refresh keeps the target’s own.',
        'App side: PUT / DELETE /api/hub-link/status-banner (bearer HUB_TOKEN) on a dedicated app, PUT / DELETE /api/hub-deployment/apps/:id/status-banner on a shared deployment. The banner is a Redis key per app with a two-hour lifetime; GET /api/announcements/active carries it as a row nobody can dismiss.',
        'API: every route is in the Hub API reference (groups Incidents, On-call, Status pages); writes need hub:write on an API key and are never open to connected apps.'
      ]
    }
  ]
}
