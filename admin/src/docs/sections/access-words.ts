import type { DocSection } from '../types.js'

export const permissionSummaryDocs: DocSection = {
  id: 'permission-summary',
  label: 'Permissions in words',
  content: [
    { type: 'h1', id: 'permission-summary', text: 'Permissions in words' },
    {
      type: 'p',
      text: "A role or a person's access as plain sentences: \"Buyers can see, add and edit purchase orders in their own Zones, can't delete, can't see the Cost and Price fields.\" It shows on the Roles page (In words tab) and on a person's page (Access tab → Permissions in words)."
    },
    { type: 'h2', id: 'permission-summary-source', text: 'Where the words come from' },
    {
      type: 'ul',
      items: [
        'See / add / edit / delete come from the same permission check every API call runs; field lists from the same allowed-fields check; row rules from the same row filter; User Scopes from the same routing the read path uses. The summary cannot say something the API would not do.',
        "A collection without its own policy answers like the role's wildcard (`*`) policy, so all of those share one line.",
        'Collections with full access (see, add, edit and delete, no limits) collapse into one line, as do see-only ones. Collections with a pipeline come first, then the biggest.',
        'Role view: "in their own Zones" when people holding the role carry a Zone restriction ("for 3 of 5 people" when not all of them do). Person view: their own values ("Zone 1 or Zone 4").',
        'Pages turned off for the role (UI Access) and a role without app access are listed at the end.'
      ]
    },
    { type: 'h2', id: 'permission-summary-api', text: 'API' },
    {
      type: 'table',
      head: ['Request', 'Who', 'Answer'],
      rows: [
        ['`GET /api/access/summary?role=<id>`', 'Administrators', 'The role in words'],
        [
          '`GET /api/access/summary?user=<id>`',
          'Administrators; anyone for their own id',
          'The person in words. A person reading their own summary is never told the names of fields their role hides, nor how many collections are closed to them.'
        ]
      ]
    }
  ]
}

export const appGlossaryDocs: DocSection = {
  id: 'app-glossary',
  label: 'App glossary hints',
  content: [
    { type: 'h1', id: 'app-glossary', text: 'App glossary hints' },
    {
      type: 'p',
      text: 'A few app words — Layout, Field Rules, Owner Matrix, Dimensions, Queues, Section, Row-level security — carry a dotted underline; hover for a one-line meaning. Nivaro ships about 30 built-in meanings (pipeline, owner group, layout, queue, User Scope, rollup, addendum, picker, hidden from pickers …), so the hints work with no AI configured.'
    },
    {
      type: 'ul',
      items: [
        'Your own wording wins: a glossary entry on AI → Knowledge → Glossary whose term or alias matches a built-in term replaces it everywhere. "Built-in app terms" at the foot of the Glossary tab lists them; "Use our wording" starts an entry from the built-in text.',
        'Developers: `<Term id="pipeline">pipeline</Term>` from @nivaro/shared, and `useGlossary({ withCore: true })` for the merged list (one cached read of `GET /api/ai-knowledge/glossary`, which every signed-in person may read).'
      ]
    }
  ]
}
