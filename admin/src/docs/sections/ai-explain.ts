import type { DocSection } from '../types.js'

export const aiExplainGuide: DocSection = {
  id: 'ai-explain-guide',
  label: 'AI Explain (operations)',
  content: [
    { type: 'h1', id: 'ai-explain-guide', text: 'AI Explain for operations' },
    {
      type: 'p',
      text: 'Administrators get an Explain button next to things that go wrong or need describing. It reads the facts the console already holds, sends a redacted fact sheet to the configured AI provider, and shows a short answer: the likely cause, numbered steps, whether a retry is safe and who to contact. It is a suggestion, not a verdict.'
    },
    { type: 'h2', id: 'ai-explain-where', text: 'Where it appears' },
    {
      type: 'ul',
      items: [
        'Issues: a likely cause from the details, the first occurrence and similar issues resolved before.',
        'Slow requests: where the time went, from the waterfall and its SQL shapes, linking a database tuning proposal when one covers it.',
        'Background jobs: a failed run, from its log and error.',
        'Webhooks: a failed delivery, from the receiver response, with whether a retry is safe.',
        'Go-Live Readiness: steps to fix a warning or failing check.',
        'Data Model: a plain-words description of the collections, how they relate and their life cycle.',
        'Imports (admin and every app that hosts the Import Console): open a failed run, or one that took two minutes or more, for "Explain this failure" / "Explain why this was slow" (phases against the definition\'s usual runs).',
        'Integrations console: every open row has "Explain this failure": the plain cause from the partner response, whether a retry is safe and the integration owner to contact.',
        'API Analytics, Real-user timings: Explain on a route says where the time goes (server wait, rendering, navigation) and what would help most.',
        "Pipeline editor, a collection's Field rules and the layout editor: Describe this pipeline / these rules / this layout in plain English."
      ]
    },
    { type: 'h2', id: 'ai-explain-groups', text: 'Grouped issues' },
    {
      type: 'p',
      text: 'On the Issues page (administrators), switch from List to Grouped to see open issues clustered by meaning: ten variants of one bug read as one problem with the variants underneath. Split out sends a variant (or a whole group) back to standing alone; tick several groups and Merge to fold them into the first one ticked. Your changes are stored on the server, apply on top of every later re-clustering and can be undone with Reset my changes.'
    },
    { type: 'h2', id: 'ai-explain-privacy', text: 'What the model never sees' },
    {
      type: 'p',
      text: 'Secrets, tokens, passwords, request bodies and file contents are removed before the fact sheet is built. Answers are cached for 30 minutes by the hash of the facts, so an unchanged situation costs nothing twice; Explain again bypasses the cache.'
    },
    { type: 'h2', id: 'ai-explain-monday', text: 'Monday summary' },
    {
      type: 'p',
      text: 'On the Go-Live Readiness page, Monday summary opts you in to two short AI-written sections of your daily summary email on Mondays: issues this week (new, getting worse, resolved) and operations this week (changes, slowest routes, failures, storage growth). Stored as the ai_weekly_summary preference; nobody receives it who did not opt in.'
    },
    { type: 'h2', id: 'ai-explain-api', text: 'API' },
    {
      type: 'table',
      head: ['Route', 'Purpose'],
      rows: [
        [
          'POST /api/ai-explain/:kind',
          'Explain one subject. Body: kind-specific ids; fresh: true skips the cache. Admin only.'
        ],
        ['GET /api/ai-explain/kinds', 'The kinds on offer.'],
        [
          'GET /api/ai-explain/issue-groups',
          'Open issues clustered by meaning (message and route), variants under each lead, admin overrides applied.'
        ],
        [
          'POST /api/ai-explain/issue-groups/overrides',
          "Body {op: split|merge|reset, ids, into?}: split issues out, merge them into another issue's group, or reset. Returns the regrouped list. Admin only."
        ]
      ]
    },
    {
      type: 'p',
      text: 'Kinds: issue, trace, import-run, job-run, readiness, signal-row, webhook-delivery, rum-route, config, data-model, issues-weekly, ops-weekly. Import-run covers both a failed and a slow import run; signal-row covers partner failures on the Integrations console.'
    }
  ]
}
