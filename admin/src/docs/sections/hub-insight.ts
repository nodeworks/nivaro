import type { DocSection } from '../types.js'

export const hubInsightDocs: DocSection = {
  id: 'hub-insight',
  label: 'Health, usage, dependencies and Ask the Hub',
  content: [
    { type: 'h1', id: 'hub-insight', text: 'Health, usage, dependencies and Ask the Hub' },
    {
      type: 'p',
      text: 'Four Apps hub tabs tell you how the apps the Hub looks after are doing and what they rely on: Health (a 0–100 score per environment), Usage (how many people use each app), Dependencies (what each app talks to, and what a change would touch) and Ask the Hub (questions in plain words, answered from Hub data). Hub administrators see every app; app owners see only their own. Every page reads the Hub’s own tables: loading one never makes the Hub call an app.'
    },

    { type: 'h2', id: 'hub-insight-health', text: 'Health score' },
    {
      type: 'p',
      text: 'Each environment gets a score from 0 to 100, built from figures other Hub tabs already keep. The Health tab shows every part beside the score, so a low number always says why. The Fleet tab shows the same score in its Score column.'
    },
    {
      type: 'table',
      head: ['Part', 'Figure', 'Scores'],
      rows: [
        [
          'Uptime',
          'Fleet uptime over 30 days (24 hours when 30 days is unknown)',
          '99.9 % or better = 100, 95 % or less = 0'
        ],
        [
          'Errors',
          'Failed requests ÷ requests over the last 24 hours (Capacity samples)',
          '0.1 % or less = 100, 5 % = 0'
        ],
        ['Drift', 'Open Fleet drift alerts', 'none 100, one 60, two 30, more 0'],
        ['Issues', 'Open issues the app reported over its hub link', '100, less 5 for each'],
        ['Readiness', 'The readiness score the app reported', 'as reported'],
        [
          'Backups',
          'Age of the newest Hub database backup or recorded sighting (Backups & data)',
          'a day or less = 100, a week = 0'
        ],
        [
          'Secrets',
          'Rotation state of the environment’s secrets (Secrets)',
          'overdue 0, due soon 60, on time 100'
        ],
        [
          'Incidents',
          'Open Hub incidents on the environment, or on the whole app (Incidents)',
          'none 100, worst sev3 70, sev2 40, sev1 0'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'A part the Hub has no figure for is left out and the weights of the others scale up, so a new or watch-only environment is not punished for what the Hub cannot see. No part at all = no score (—).',
        'Backups count on production environments (the Hub’s production rule) and wherever a database backup policy is on. Elsewhere "no backup" is not a fault.',
        'Bands: 90 and up Good, 70–89 Fair, below 70 Poor (always written beside the number).',
        'Administrators set each part’s weight (0–10, 0 leaves it out) under Health → Weights. Changing a weight changes every viewer’s score at once; stored days keep the score they had.',
        'The job hub-insight-health (hourly at :25) stores each environment’s score under the UTC day for the trend; the last run of a day wins. Days older than 400 are dropped.'
      ]
    },

    { type: 'h2', id: 'hub-insight-usage', text: 'Usage' },
    {
      type: 'p',
      text: 'How many different people used each app per day over the last 14 completed days, the average per day for each week, adoption (people active in the last 7 days ÷ people with an account) and the busiest screens. The figures come from the app’s own page views (page loads and screen changes — never rage clicks, dead clicks or widget beacons), read once a day (job hub-insight-collect, 05:10 UTC) over the hub link, or the shared deployment’s link for an app on a shared deployment.'
    },
    {
      type: 'note',
      text: 'Counts only, and built so that no two answers can be subtracted into a small group. The Hub never receives a person’s name, id or email, a record, or a raw address. The app enforces all of this before anything leaves it: only completed UTC days are counted (today is counted tomorrow, so two reads on one day are identical); the windows are fixed (14 days, with the last 7 inside it) whatever the Hub asks; every count is rounded down to a multiple of 5; a figure under the privacy floor (never below 5) is not sent — a day says only "fewer than N", a screen is not listed — and the 7-day figure is held back when it is within the floor of the 14-day one. A screen is its route pattern with every segment that is not a route parameter or a known static route segment (the app’s own routes and collection names) shown as :id, so ids, slugs and record keys never appear, and people are counted per masked screen. The Hub re-checks the floor on what arrives; an administrator can raise it (Health → Weights), which hides stored figures under it at once.'
    },
    {
      type: 'p',
      text: 'An app before 0.3.215 does not report usage (the page says so). Administrators can read every environment now with Read now (one run at a time, in the background; it also refreshes dependencies). The app answers usage behind its read gate, one read at a time per floor.'
    },

    { type: 'h2', id: 'hub-insight-dependencies', text: 'Dependency map and impact' },
    {
      type: 'p',
      text: 'The Dependencies tab draws apps on the left and what they depend on on the right, grouped by kind. Pick a dependency to list every app and environment a change to it would touch, production first — before you patch a database server, move a partner’s host or upgrade an extension.'
    },
    {
      type: 'table',
      head: ['Kind', 'From'],
      rows: [
        [
          'Partner APIs',
          'The app’s external API configs (with this environment’s overrides) — the host only'
        ],
        ['Webhooks', 'The app’s webhooks, counted per host'],
        [
          'Mail relay, Sign-in',
          'The SMTP host and the sign-in issuer host (sign-in is not named on a shared deployment)'
        ],
        ['Issue trackers', 'The app’s tracker connections — the host only'],
        ['Extensions', 'The extensions the app’s process loaded, with their version'],
        ['Database servers', 'The Hub’s own database record for the environment'],
        ['Shared deployments, Drivers', 'The Hub’s own placement of the environment']
      ]
    },
    {
      type: 'note',
      text: 'Host names only (host[:port]): never a scheme, a path, a query, a user or a credential. The app answers that way and the Hub drops anything that is not a bare host.'
    },

    { type: 'h2', id: 'hub-insight-digest', text: 'Weekly digest' },
    {
      type: 'p',
      text: 'Every app owner gets one email on Monday mornings (job hub-insight-digest, 12:00 UTC, caught up within 48 hours) about the apps they own: last week’s deploys, incidents, open drift alerts and health against a week ago, and the next 14 days’ scheduled promotes and freeze windows. On a standalone Hub it wears the Hub’s mail layout. A person never gets two for one week.'
    },
    {
      type: 'ul',
      items: [
        'Turn your own off with the Weekly digest switch on the Health tab (it shows only to app owners).',
        'Administrators can switch it off for everyone under Health → Weights.',
        'The email follows your Profile → Notification rules for Reports (No email and quiet hours apply; it is never held for the daily summary, since it is a summary itself). An in-app notice says the same in one line.'
      ]
    },

    { type: 'h2', id: 'hub-insight-ask', text: 'Ask the Hub' },
    {
      type: 'p',
      text: 'Ask questions in plain words — "which environments are unhealthy and why", "what went to production this week", "which apps share this database server". The answer names the records it used (Sources), and each links to the Hub page.'
    },
    {
      type: 'ul',
      items: [
        'Read-only, always: the AI gets only read and plan tools (the Hub’s own MCP read tools plus health, usage, dependencies and impact). Every tool call goes back into the Hub as you, so it sees exactly what you see on the other tabs; it cannot start, cancel, change or delete anything.',
        'It uses the instance’s AI settings, your personal AI limits and the AI call log (feature "hub").',
        'What tools return is treated as data, never as instructions. The answer is cleaned before you see it: no images, no HTML, and only links to Hub pages stay clickable.',
        'Nothing is stored: the conversation lives in your browser tab. New conversation clears it. The newest 20 turns are sent, starting on a question; a long earlier answer is cut, never refused.',
        'A tool the model asks for that is not offered, or a write it tries, is refused and logged (activity action hub-ask-refused, names and paths only).',
        'Only in your own signed-in session in the Hub: named API keys, connected apps and assistants, phone tokens, View-as and run-as keys get 403 ASK_OWN_SESSION (it spends your AI allowance and is a chat for a person).'
      ]
    },

    { type: 'h2', id: 'hub-insight-api', text: 'Routes' },
    {
      type: 'table',
      head: ['Route', 'Who', 'What'],
      rows: [
        [
          'GET /api/hub/insight/health',
          'admin, owner',
          'Score, parts and 30-day trend per environment'
        ],
        ['GET /api/hub/insight/usage', 'admin, owner', 'Usage per environment (stored days 7–400)'],
        ['GET /api/hub/insight/dependencies', 'admin, owner', 'Nodes, edges and uses'],
        ['GET /api/hub/insight/impact?node=', 'admin, owner', 'Who depends on one node'],
        [
          'GET/PUT /api/hub/insight/settings',
          'admin',
          'Weights, privacy floor, digest switch (logged)'
        ],
        [
          'POST /api/hub/insight/collect',
          'admin',
          'Read usage + dependencies now (202; 409 COLLECT_RUNNING)'
        ],
        ['GET/PUT /api/hub/insight/digest/me', 'signed in', 'Your own digest switch'],
        ['GET /api/hub/insight/digest/preview', 'signed in', 'Your digest as it would go out'],
        ['POST /api/hub/insight/ask', 'admin, owner (own session only)', 'Ask the Hub'],
        [
          'GET /api/hub-link/ops/usage, /ops/dependencies',
          'Hub (link bearer)',
          'App side: the counts and hosts, under the floor'
        ],
        [
          'GET /api/hub-deployment/ops/apps/:id/usage, …/dependencies',
          'Hub (deployment bearer)',
          'The same, inside one app of a shared deployment'
        ]
      ]
    }
  ]
}
