import type { DocSection } from '../types.js'

export const copyingRecordsDocs: DocSection = {
  id: 'copying-records',
  label: 'Copying Records',
  content: [
    { type: 'h1', id: 'copying-records', text: 'Copying Records' },
    {
      type: 'p',
      text: 'A copy of a record is a new record. It starts at the first step of its workflow, like any record someone creates by hand: its owners are worked out again, its deadline clocks start now, and none of the original’s history, approvals or notes come along. Only the values a person would type again are copied.'
    },
    { type: 'h2', id: 'copying-records-paths', text: 'Where people copy records' },
    {
      type: 'ul',
      items: [
        '**Clone** on the record page (More menu, admin and efp-new) — a dialog to change or leave out fields, then `POST /api/items/:collection/:id/clone`; the copy opens at once, so nobody mistakes the original (still at its step) for the copy. Linked lists (Zone, Project Sub Type…) copy too; a list you may not set stays behind and the message names it.',
        '**More → Duplicate** on the record page (admin and efp-new) — opens a new, filled-in form; nothing is saved until the person saves it.',
        '**Save as template** — the template keeps the same values a copy would.',
        'Lines copied with a record (a grid’s child rows) follow the same rule for their own collection.'
      ]
    },
    { type: 'h2', id: 'copying-records-never', text: 'What is never copied' },
    {
      type: 'table',
      head: ['Kind of field', 'Why'],
      rows: [
        [
          'The workflow step field (the pipeline’s state field)',
          'The copy starts at the first step.'
        ],
        ['Id, created / changed stamps, creator, last step change', 'The copy gets its own.'],
        ['Generated ids (auto-id fields)', 'A new number is given on save.'],
        ['Calculated fields and totals from lines', 'Worked out again for the copy.'],
        ['Read-only fields', 'Written by the system: partner statuses, shipped quantities.'],
        ['Hidden fields', 'Integration and system state: external ids, triggers.'],
        ['Fields marked “do not duplicate”', 'Partner numbers such as an order number.'],
        [
          'Fields on the collection’s “Never copied” list',
          'Anything else that belongs to the original only.'
        ]
      ]
    },
    { type: 'h2', id: 'copying-records-setting', text: 'Adding fields to the list' },
    {
      type: 'p',
      text: '**Table Editor → Settings → Collection Browser → Never copied when duplicating**: pick the fields. Stored as `browser_config.never_copy` (a list of field names) on the collection; no migration. The card also lists the fields that are always left out and why.'
    },
    { type: 'h2', id: 'copying-records-api', text: 'API' },
    {
      type: 'pre',
      code: `GET /api/copy-rules/:collection
→ { "data": { "skip": { "request_state": "pipeline-state", "order_number": "do-not-duplicate", … } } }`
    },
    {
      type: 'p',
      text: 'Signed in, and only for collections the caller may read. Field names and reasons only, never values. The clone endpoint applies the same rule, so `field_overrides` cannot set a field that never copies. It also copies the many-to-many lists under the same rule, each link written as the caller; a list the caller may not set or a refused link comes back as `not_copied: [{ field, reason }]` (`no-access` | `refused`).'
    }
  ]
}
