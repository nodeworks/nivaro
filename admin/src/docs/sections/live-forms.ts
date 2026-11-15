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
          'Ledger accepted it at 10:43 AM — PO 12345',
          'Done. The number is the one Ledger gave back, under the word Ledger uses for it (the API\u2019s Reference label; "reference" when none is set).'
        ],
        [
          'Ledger refused it at 10:43 AM: <reason>. Fix what it names, then send it again.',
          'Ledger answered no. Its own words are shown when it gave any.'
        ],
        [
          "Couldn't reach Ledger — nothing was sent. Retrying at 10:45 AM (attempt 2 of 5)",
          'The call did not get through (network, time-out, or Ledger was down). Nothing was refused, and it will be tried again by itself at that time; the line counts down to it.'
        ],
        [
          "Couldn't reach Ledger — nothing was sent. Try again or ask an admin.",
          'The same, with nothing set up to try again. A quieter line under it says why: "Will not retry — automatic retries are not set up for Ledger".'
        ],
        [
          'No answer from Ledger after 25 minutes — the send is held and will not be repeated automatically',
          'Ledger may already have it. An administrator checks Ledger and marks the send received or not received (Integrations → ERP submissions).'
        ]
      ]
    },
    { type: 'h3', id: 'live-forms-retries', text: 'Sends that retry by themselves' },
    {
      type: 'p',
      text: 'A failed send is tried again with nobody pressing anything only in two cases, and the record says which: the external API has a retry policy (External APIs → the API → Automatic retry for failed pushes: how many times and how long to wait), or Settings → Integrations → automatic remediation is on and the send was one the integration ledger tracks (it waits 1, 5, 30, 120 and 120 minutes, five attempts in all, and only for a call that did not get through). The time shown is the next run of the job that does it, so it matches what will happen. Anything else says "Will not retry —" and why: the partner refused it (sending the same thing again cannot fix it), every attempt was made, retries are paused, or there is nothing stored to send. Dead letters and failed flow runs are always retried by a person.'
    },
    { type: 'h3', id: 'live-forms-reference-label', text: 'Reference label' },
    {
      type: 'p',
      text: 'Each external API can say what it calls the number it gives back — "PO", "order" — in its Reference label (External APIs → the API → Integration Type card). Records then read "Ledger accepted it at 10:43 AM — PO 12345". Empty means "reference".'
    },
    { type: 'h3', id: 'live-forms-catalog-notice', text: 'Catalog updates tell record owners' },
    {
      type: 'p',
      text: 'When a catalog, price or stock import changes the catalog under open records, the owners of those records hear it once — not once per line: "Catalog update changed prices on 14 lines in 6 of your open records". Opening it shows the list filtered to exactly those records; each line then says what changed (above). Only records you can read are counted, only records that can still be changed (an open step that does not lock the record), and the same findings are never sent twice. A newer notice replaces an unread older one.'
    },
    {
      type: 'p',
      text: 'It is off until an administrator turns on "Tell owners about catalog updates" for the record collection (Data Model → the collection → Browser settings). It covers the catalog lines field\u2019s price columns and its stock column when that stock is matched to the record by one field (for example the record\u2019s warehouse). Imports that announce their writes, staged imports and collection imports all count; changes are gathered for 20 seconds after the last one (two minutes at most) so a large import is one notice.'
    },
    {
      type: 'pre',
      code: `GET /api/erp-submissions/send-status?collection=&ids=a,b,c   → {data: {id: [latest send per system]}}  (≤ 100 ids; only records you can see)
   each send: … ref_label, retry {at, attempt, of} | null, no_retry (why it will not be retried) | null
PATCH /api/external-apis/:id {reference_label: "PO" | null}   (admin; kept in integration_config)
GET /api/picker-exclusions/linked-change?collection=&item_id=&since=   → who changed a linked record, when, and which fields`
    }
  ]
}
