import type { DocSection } from '../types.js'

export const ideasDocs: DocSection = {
  id: 'ideas',
  label: 'Idea Board',
  audience: 'all',
  content: [
    { type: 'h1', id: 'ideas', text: 'Idea board' },
    {
      type: 'p',
      text: 'The idea board collects feature requests from everyone who signs in. Each idea is a record of the `ideas` collection, so it works in queues, reports, dashboards and Ask AI like any other collection, and its edits show in activity and revisions.'
    },
    { type: 'h2', id: 'ideas-suggest', text: 'Suggest a feature' },
    {
      type: 'p',
      text: '**Suggest a feature** (in the Home panel, next to Support and Videos) opens a short form. As you type a title, ideas that look similar appear underneath (matched by meaning when an embedding model is set up, otherwise by words), each with a **Vote** button. Vote for an existing idea instead of filing a duplicate; if none fits, add a description and **Submit idea**. Your vote is added to a new idea automatically.'
    },
    { type: 'h2', id: 'ideas-vote', text: 'Voting' },
    {
      type: 'p',
      text: '**Ideas** (same panel) lists every open idea, most-voted first, with a status filter. Click the vote button to vote or take your vote back — one vote per person per idea. When an admin changes an idea’s status, everyone who voted for it gets an in-app notification with the new status and the admin’s note.'
    },
    {
      type: 'table',
      head: ['Status', 'Meaning'],
      rows: [
        ['Under review', 'New, not decided yet (every idea starts here)'],
        ['Planned', 'Accepted and scheduled'],
        ['Built', 'Shipped'],
        ['Declined', 'Not going to happen — the note says why']
      ]
    },
    { type: 'h2', id: 'ideas-admin', text: 'Managing ideas (admins)' },
    {
      type: 'ul',
      items: [
        '**Status** — pick a status, write a note for voters and **Save status and notify voters**. Every change is kept in the idea’s status history.',
        '**Merge** — find the idea to keep and **Merge**. Votes move to it (someone who voted for both still counts once), the merged idea is kept but hidden from the board and from similar results, and its voters are told where their vote went.',
        '**Link to a backlog record** — pick a collection and a record. The link is an ordinary related-record link (`relates to`), so it shows on the idea and on the record’s Related records panel.'
      ]
    },
    {
      type: 'note',
      text: 'Every role that existed when the idea board was installed can read and add ideas. Grant **read** and **create** on `ideas` to roles you add later.'
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `GET    /api/ideas?status=planned          list (not merged), with your vote state
GET    /api/ideas/similar?q=export%20queue  ranked matches, merged ideas excluded
GET    /api/ideas/:id                      idea, status history, merges, links
POST   /api/ideas                          { title, description }  → creator's vote added
POST   /api/ideas/:id/vote                 vote (a second vote changes nothing)
DELETE /api/ideas/:id/vote                 take the vote back
PATCH  /api/ideas/:id/status               admin: { status, note } → voters notified
POST   /api/ideas/:id/merge                admin: { into } → votes moved, source kept
POST   /api/ideas/:id/link                 admin: { collection, id } → 'relates to' link`
    }
  ]
}
