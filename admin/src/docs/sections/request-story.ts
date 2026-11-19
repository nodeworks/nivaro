import type { DocSection } from '../types.js'

export const requestStoryDocs: DocSection = {
  id: 'request-story',
  label: 'Request Story',
  content: [
    { type: 'h1', id: 'request-story', text: 'Request Story' },
    {
      type: 'p',
      text: 'The Request story tab of the Health page (/health/request-story, Operations → Health) reads one API request from start to finish: who sent it, how its time was spent, the SQL it ran, what it wrote and set off, and what else is linked to it. Every part opens down to its last leaf, and each leaf links to where that thing lives in the app. Admins only.'
    },
    {
      type: 'p',
      text: 'Paste a request id — from “Details for support” on an error, an API log row, the Traffic Map or Slowest requests — or pick one of the calls that failed in this browser tab (listed with their status, method and route, the id shown quietly beside it). Press / to jump to the id box.'
    },
    { type: 'h2', id: 'request-story-page', text: 'The page' },
    {
      type: 'ul',
      items: [
        'The verdict: the answer (status and its meaning), the method and route, who sent it and what it did in plain words, when, which instance served it, and the figures — time taken, SQL, hooks, records written, partner calls, people notified, live updates. Each figure jumps to its section. A failed request says why in one line and opens the answer.',
        'Where the time went: the time split (sign-in, access checks, hooks and rules, other measured work, and what no phase measured) and every measured phase on one time axis, nested inside the phase that ran it. A phase that ran one statement over and over is marked N+1.',
        'What it wrote and set off: writes, pipeline moves, flows, partner pushes and their attempts, partner calls, people notified and emails, in time order and nested under the step that caused them. Filter by kind; a failed step is red and says why.',
        'SQL it ran: the heaviest statement shapes the trace kept, with total time, runs, average and share of the SQL wait. N+1 and select * on long-text tables are marked.',
        'Live updates it sent, by event name.',
        'Related: the same page load, the same chain (the event path), the same record, the same caller within five minutes and issues logged for the same error. A related request opens its own story.'
      ]
    },
    { type: 'h2', id: 'request-story-leaves', text: 'Leaves' },
    {
      type: 'p',
      text: 'Any row opens its leaf beside the story on a wide screen, or in a side sheet on a narrow one: the request (path, route, sign-in method, address, browser, GraphQL facts, ids), the caller (profile, their activity, what they did, the API key or the assistant), the answer (what it said and issues with the same error), a phase (start, end, share of the request, round trips, the repeated statement, the phases around it), a statement (full text, tables, flags, the query plan — from the plan cache when SQL Server still has it — and the routes that run it in the Traffic Map), and each write, move, flow, push, call, notification and email (status, fields changed, channels, error, and links to the record, the activity entry, the flow, the ERP submission, the partner API, the person, the notification and the mail log).'
    },
    {
      type: 'p',
      text: 'The open leaf is in the address (?id=<request>&leaf=…), so a copied link reopens the same view. ↑ and ↓ move between rows of a list, Enter opens one, Esc closes the leaf, Back steps out of it.'
    },
    {
      type: 'note',
      text: 'The story shows statement text, field names and ids only — never bound values, request or response bodies, query-string values, notification subject lines, email addresses or a pipeline comment. What was not kept is said, never guessed: traces live in memory on the API process that served the request, and only slow requests are traced.'
    },
    { type: 'h2', id: 'request-story-api', text: 'API' },
    {
      type: 'ul',
      items: [
        'GET /api/ops/request-story/:id — the story: request, caller, trace (phases, time split, statements) and effects, plus the plain-words headline and timeline. A 32-character trace id works as well as the dashed request id.',
        'GET /api/ops/request-story/:id/related — the related groups (not on a cloud instance).',
        'POST /api/traces/:id/explain {index} — the plan of one kept statement.'
      ]
    }
  ]
}
