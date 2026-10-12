import type { DocSection } from '../types.js'

export const aiPanelDocs: DocSection = {
  id: 'ai-panel',
  label: 'Ask AI panel shortcuts',
  content: [
    { type: 'h1', id: 'ai-panel', text: 'Ask AI panel shortcuts' },
    {
      type: 'p',
      text: 'Everything here runs as you: starter questions name only what you can open, saved views are the ones you can see, and every figure or row is read with your own permissions, row rules and scopes. None of it adds a model call beyond the answer itself.'
    },
    { type: 'h2', id: 'ai-panel-starters', text: 'Starter questions and follow-ups' },
    {
      type: 'p',
      text: 'The empty chat offers two or three questions fitted to the page it was opened from — “Why is workflows #12 late?” on a record you can open, “Which records in queue 7 breach their SLA today?” on a queue, “What changed since last month?” on a report — plus the examples an administrator wrote into the collection’s data guide. After each answer, three short next questions drawn from what the tools found appear under it; one click asks one. They are written in the same call as the answer.'
    },
    { type: 'h2', id: 'ai-panel-slash', text: 'Slash commands' },
    {
      type: 'p',
      text: 'Type / in the Ask box to list the commands, then Tab or Enter to pick one.'
    },
    {
      type: 'table',
      head: ['Command', 'What it does'],
      rows: [
        [
          '/chart <question>',
          'Answers with a chart (bar, line or pie) built from the numbers the tools return.'
        ],
        ['/table <question>', 'Answers as a table.'],
        [
          '/explain',
          'Explains how the last answer was reached: what was read, how the figure was computed, access limits.'
        ],
        ['/steps <question>', 'Answers as a short numbered list of steps.'],
        [
          '/export [xlsx]',
          'Downloads the last answer’s rows as CSV (or Excel), re-run with your access.'
        ]
      ]
    },
    { type: 'h2', id: 'ai-panel-choices', text: 'Clarifying questions' },
    {
      type: 'p',
      text: 'When a question is genuinely ambiguous (“which zone?”, “this year or the funding year?”) and no sensible default exists, the answer asks with clickable options instead of guessing: the distinct values of a column, matching records you can read, or short interpretations. Picking one continues the same conversation. Answers that ask a question are never cached or shared as replayable.'
    },
    { type: 'h2', id: 'ai-panel-views', text: 'Saved views by name' },
    {
      type: 'p',
      text: 'Say “my late IRs view” and Ask AI resolves it to a saved view you can see — your own, ones shared with everyone, and ones shared with your role. The view’s filter is checked against the fields you may read (a view that filters on a hidden field is refused, not trimmed) and its rows are read as you. The filter can then be extended or grouped by a follow-up question.'
    },
    { type: 'h2', id: 'ai-panel-compare', text: 'Comparing' },
    {
      type: 'p',
      text: 'Ask for “Q1 vs Q2 spend by zone”, “this year vs last year” or “compare these two requests”. The compare tool runs the same guarded aggregate over both sets and returns values with deltas (B minus A, and percent), or lays two to four records side by side with the differing fields first. Fields you cannot read are never shown.'
    },
    { type: 'h2', id: 'ai-panel-drill', text: 'Drilling into a chart' },
    {
      type: 'p',
      text: 'Click a bar, point or slice of a chart answer to open the rows behind it in a sheet. The grouping is re-run as you and matched to the point you clicked; Open as list takes you to the collection filtered to exactly those records (up to 500).'
    },
    { type: 'h2', id: 'ai-panel-live', text: 'Live answers' },
    {
      type: 'p',
      text: 'A number or chart answer that was built only from counts and sums stays current while you leave it open: when records in its collection change, the same aggregate is re-run as you (debounced, no model call) and the fresh figure appears under the answer, marked “updated …”. Updates stop while the tab is hidden and when you pause or close the answer. Only the newest two such answers refresh.'
    },
    { type: 'h2', id: 'ai-panel-api', text: 'API' },
    {
      type: 'pre',
      code: `GET  /api/ai/starters?page=&collection=&id=     (signed in) starter questions for a screen
POST /api/ai/chat                               body.command = chart | table | explain | steps
POST /api/ai/chart-drill {collection, group_by, filter?, label}   (signed in) rows behind a chart point
POST /api/ai/live-answer {input: {collection, op, field?, group_by?, filter?}}   (signed in) re-run one aggregate`
    }
  ]
}
