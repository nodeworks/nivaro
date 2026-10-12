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
        'Data Model: a plain-words description of the collections, how they relate and their life cycle.'
      ]
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
          'Open issues clustered by meaning (message and route), variants under each lead.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Kinds: issue, trace, import-run, job-run, readiness, signal-row, webhook-delivery, rum-route, config, data-model, issues-weekly, ops-weekly. Import-run covers both a failed and a slow import run; signal-row covers partner failures on the Integrations console.'
    }
  ]
}
