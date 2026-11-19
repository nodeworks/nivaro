import type { DocSection } from '../types.js'

export const aiCallLogDocs: DocSection = {
  id: 'ai-call-log',
  label: 'AI usage & call log',
  content: [
    { type: 'h1', id: 'ai-call-log', text: 'AI usage & call log' },
    {
      type: 'p',
      text: 'AI → Usage lists every call Nivaro made to the AI provider: Ask AI, the chat bot and every one-shot AI feature, with tokens, list-price cost, time and result. Administrators only. Call bodies are kept 30 days.'
    },
    { type: 'h2', id: 'ai-call-log-filters', text: 'Filter, sort and search' },
    {
      type: 'p',
      text: 'One filter drives the whole page: the figures at the top, the trend, the breakdowns and the call list all count exactly the same calls. Pick a window (24 hours to 90 days) or click a bar of the trend to see only that hour or day. Filter by feature, model, person, tool the model called and result (answered, called tools, hit the length limit, stopped, error); More filters adds cost, token and time ranges, the error text and whether the answer got a thumbs up or down. The search box finds the questions people typed. Every column of the list sorts. Click a row of a breakdown (by feature, model, person or result) to filter to it, click it again to drop it; the Error rate and Helpful figures do the same. Every filter shows as a chip you can remove, and the whole state is in the address, so a filtered view or an open call is a link. Views saves the current filters by name, for yourself or shared with every administrator. CSV downloads every call in the filter, newest first.'
    },
    { type: 'h2', id: 'ai-call-log-detail', text: 'Reading a call' },
    {
      type: 'p',
      text: "Clicking a call opens it in a side panel as it read to the person: their question, each tool the model called with its inputs as a small table and what came back (the row count, the columns, a peek at the first rows, or the error), and the answer rendered the way the person saw it. The system prompt, the tool definitions and cache markers are left out and counted at the foot. Beside it: input, cached and output tokens, cost and time, where the input tokens went (tool definitions, rules, guides, history), the model and how it was routed, the request id, the other calls of the same question and the feedback. View raw shows the stored request and response as a folding JSON tree with Copy; values under credential-looking names are masked and file contents are left out. A call the provider refused shows the provider's own words."
    },
    { type: 'h2', id: 'ai-call-log-thread', text: 'The whole conversation' },
    {
      type: 'p',
      text: 'An Ask AI call opens its conversation: every turn in order, who asked, the tools each answer used, its model calls folded under it (each opens back in the call view), thumbs and comments, and the cost, tokens and time per turn and in total. The turn the call belongs to is marked and scrolled to. When the person had their history off there is no saved thread; the panel then shows the earlier turns the model was sent with the question. Like the chat compliance view, every search of the call log, every call opened, every conversation opened and every CSV is written to the activity log (ai-call-search, ai-call-read, ai-conversation-admin-read, ai-call-export).'
    },
    {
      type: 'note',
      text: 'Migration 539 adds question, tools and conversation_id to nivaro_ai_calls. Calls logged before it get the question and tools filled in the background the first time the page is opened; until then a page reads them from the stored bodies. Searching question text needs the migration.'
    },
    {
      type: 'pre',
      code: `GET    /api/ai/call-log            (admin) ?hours=|from=&to= &feature= &model= &user= &tool= &result= &q= &error=
                                   &request_id= &conversation= &feedback=up|down|any|none
                                   &cost_min= &cost_max= &tokens_min= &tokens_max= &ms_min= &ms_max=
                                   &sort=-when|+cost|… &page= &limit=
GET    /api/ai/call-log/summary    (admin) same filter → figures, p50/p95, breakdowns, trend, facets
GET    /api/ai/call-log/export     (admin) same filter → CSV, streamed
GET    /api/ai/call-log/:id        (admin) ?raw=1 → readable transcript (+ masked bodies)
GET    /api/ai/call-log/thread     (admin) ?call=<id> | ?conversation=<id>
GET    /api/ai/call-log/views      (admin)
POST   /api/ai/call-log/views      (admin) {name, query, shared}
DELETE /api/ai/call-log/views/:id  (admin, own views)`
    }
  ]
}
