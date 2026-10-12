import type { DocSection } from '../types'

export const accessInsightsDocs: DocSection = {
  id: 'access-insights',
  label: 'Access & Ownership Explained',
  content: [
    { type: 'h1', id: 'access-insights', text: 'Access & Ownership Explained' },
    {
      type: 'p',
      text: 'Plain-language answers to "why was I refused", "why does Kim own this", "who can act on this now", "what would this role change do" and "what can Beth see". Every answer is built by the same gates and resolvers the app runs — role policies, row rules, User Scopes, the owner matrix, delegation — and only phrased afterwards, so the words cannot disagree with what actually happens.'
    },
    { type: 'h3', text: 'Why was I refused?' },
    {
      type: 'p',
      text: 'When a save, delete or workflow move is refused (403), the message carries a "Why?" link: on the save dialog it opens beside the error, on a refused move or delete it is the toast’s action. It names the role policy, row rule, User Scope, the transition’s role list or owner-only rule that stopped you, and who can change it (an administrator, the step’s owners, people with the required role). Someone else’s edit lock is mentioned as context — it is advisory and never the refusal itself. A record you cannot open at all keeps the existing "You can’t view this record" panel.'
    },
    { type: 'h3', text: 'Why these owners? Who can act now?' },
    {
      type: 'p',
      text: 'The Owners section of a record’s pipeline panel has a "Why?" link. For each owner it says how they got there: the owner group that matched (its filters against the record’s own values), the team that sits in the group, a manual add, the binding’s fallback field, or an out-of-office owner they stand in for. It also says who can act right now — available owners after delegation, with who is online. If your role cannot read a field a group filters on, the record’s value for it is shown as "not visible to you". Ask AI answers the same questions with the who_can_act and explain_owners tools.'
    },
    { type: 'h3', text: 'Role changes, before saving' },
    {
      type: 'p',
      text: 'On Roles → Permissions, ticking or unticking a box no longer saves at once. Changes are staged (outlined amber) and a bar above the matrix says what they would do — "Vendor would gain read on invoices (2.7M rows) and lose update on inventory request lines. This affects 12 people." — including changes that would do nothing because the role’s all-collections policy already covers them. Save changes applies them; Discard drops them. Row counts are the table’s approximate size.'
    },
    { type: 'h3', text: 'A person’s access' },
    {
      type: 'p',
      text: 'A person’s Access tab has a "What they can see" card: per main collection, how many records they see of the total and why ("Beth sees 4,271 of 88,000 workflows because their Zone filter is Zone 1 and their role reads workflows"), and what they cannot edit. Counts run through the same row rules and scopes their own reads use. Ask AI answers it with explain_person_access (administrators may name another person).'
    },
    { type: 'h3', text: 'Unowned records' },
    {
      type: 'p',
      text: 'The owner-gap advisor (pipeline editor → Owner coverage → Analyze) now says why each cluster has no owner — "38 Zone 4 CMTS requests in Finance Review match no owner group because no group covers Zone 4" — beside the closest group it already suggested. "No group covers Zone 4" means no owner group in that step names Zone 4 on that dimension.'
    },
    { type: 'h3', text: 'When access narrowed an answer' },
    {
      type: 'p',
      text: 'When Ask AI reads records (query_items, aggregate, semantic_search) and your scopes, a row rule on your role or a field limit shaped the result, the tool result carries an access note and the answer says so — "limited to Zone 1 by your access". It names only your own limits, never how many records were left out.'
    },
    {
      type: 'table',
      head: ['Route', 'Who', 'Returns'],
      rows: [
        [
          'GET /api/access-insights/denied/:collection/:id?action=update|delete|read|transition&transition=<id>',
          'Signed in (about yourself)',
          '{allowed, reasons[], who_can_change[], summary}'
        ],
        [
          'GET /api/access-insights/owners/:collection/:id',
          'Anyone who can see the record (else 404)',
          '{state, groups[], owners[{name, sources, sentences, unavailable}], delegations[], summary}'
        ],
        [
          'GET /api/access-insights/act-now/:collection/:id',
          'Anyone who can see the record (else 404)',
          '{state, people[{name, available, online, stands_in_for}], summary}'
        ],
        [
          'POST /api/access-insights/roles/:id/explain-change {changes:[{collection, action, grant}]}',
          'Administrators',
          '{role, members, changes[], summary}'
        ],
        [
          'GET /api/access-insights/people/:id',
          'Administrators, or yourself',
          '{lead, sentences[], cannot_line, collections[], summary}'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Online status is only reported for people you may see on the online list; anyone outside your visibility reads as "not shown", never as offline.'
    }
  ]
}
