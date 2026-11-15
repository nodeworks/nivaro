import type { DocSection } from '../types.js'

export const liveFormsDocs: DocSection = {
  id: 'live-forms',
  label: 'Live Forms, Lines, Approvals & Sends',
  content: [
    { type: 'h1', id: 'live-forms', text: 'Live Forms, Lines, Approvals & Sends' },
    {
      type: 'p',
      text: 'An open record keeps up with what other people and other systems do, without a reload. Changes land quietly where they belong — no pop-ups — and nothing you are typing is replaced. Every notice the server sends names records and fields only; the page reads the details again as you, with your own access.'
    },
    { type: 'h3', id: 'live-forms-linked', text: 'When a record you picked changes' },
    {
      type: 'p',
      text: 'A form holds links to other records: a vendor, a project, a unit. If one of them changes while the form is open — deactivated, hidden from pickers, closed, retired — the form checks the link again: whether it is still one of the options the picker offers you, and any field rules that fill other fields from it (only fields that are still empty). Your value is never cleared. If it is no longer offered, the line under the field says what happened, for example "Vendor ABC was deactivated 2 min ago by Beth Lee". A change made outside the app (by a database procedure) shows as "… is no longer offered here".'
    },
    { type: 'h3', id: 'live-forms-lines', text: 'Line prices and stock' },
    {
      type: 'p',
      text: 'A line keeps the price it was given when it was added; a price never changes by itself. While the record can still be changed, a line whose catalog price has moved since then says so — "Catalog price now $412.00 (was $398.00 when added)" — with Use new price, which is an ordinary edit by you (the amount works itself out again from it). A line asking for more than the stock at the record’s warehouse says "Only 3 in stock at Main Warehouse (this line needs 5)". Both follow the catalog live. Once the record is locked (after approval), they are not shown.'
    },
    {
      type: 'note',
      text: 'Prices and stock changed by a database procedure reach open forms only when the procedure announces its writes (the raw-write announcer). Procedures that do not announce show the new figures the next time the form reads them.'
    },
    { type: 'h3', id: 'live-forms-approvals', text: 'Approval progress' },
    {
      type: 'p',
      text: 'The approval chain on the pipeline panel, parallel branch lanes and approval chains on a record update as each approver acts: a tick on every finished step, "Waiting on Jane Doe, Mark Li" on the step it is at, and "Approved by Beth Lee at 10:42 AM" on steps already done.'
    },
    { type: 'h3', id: 'live-forms-sends', text: 'Sends to other systems' },
    {
      type: 'p',
      text: 'When a record is sent to another system (a partner push on a move), its pipeline row and its row in lists say exactly where the latest send to each system stands. Sends run as part of their move, side by side across records, so there is no queue and no place in line.'
    },
    {
      type: 'table',
      head: ['What you see', 'What it means'],
      rows: [
        ['Sending to Ledger now (started 10:42 AM)', 'The request is on its way; no answer yet.'],
        [
          "Sent to Ledger at 10:42 AM — waiting for Ledger's answer",
          'Ledger took the request and has not said yes yet. "Usually answers within …" appears only when there are enough earlier answers to say so.'
        ],
        [
          'Ledger accepted it at 10:43 AM — reference PO 12345',
          'Done. The reference is the one Ledger gave back.'
        ],
        [
          'Ledger refused it at 10:43 AM: <reason> — fix what it names, then send it again',
          'Ledger answered no. Its own words are shown when it gave any.'
        ],
        [
          'Ledger could not take it at 10:43 AM … — send it again in a few minutes',
          'The call did not get through, or Ledger was down or busy. Nothing was refused.'
        ],
        [
          'No answer from Ledger after 25 minutes — the send is held and will not be repeated automatically',
          'Ledger may already have it. An administrator checks Ledger and marks the send received or not received (Integrations → ERP submissions).'
        ]
      ]
    },
    {
      type: 'pre',
      code: `GET /api/erp-submissions/send-status?collection=&ids=a,b,c   → {data: {id: [latest send per system]}}  (≤ 100 ids; only records you can see)
GET /api/picker-exclusions/linked-change?collection=&item_id=&since=   → who changed a linked record, when, and which fields`
    }
  ]
}
