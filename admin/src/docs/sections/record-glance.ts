import type { DocSection } from '../types.js'

export const collabRecordGlance: DocSection = {
  id: 'record-glance',
  label: 'Changes, Cards and Files',
  content: [
    { type: 'h1', id: 'record-glance', text: 'Changes, Cards and Files' },
    {
      type: 'p',
      text: 'Four small things that keep a record page current without a reload. Each one reads as you: you only ever see fields and records you could open yourself.'
    },
    { type: 'h3', id: 'record-glance-move', text: 'Before you move a record' },
    {
      type: 'p',
      text: 'When you press a move (Submit, Approve, Send back…), the page checks whether someone else changed the record since you opened it in a way your page has not shown yet — for example while your connection dropped, or when an automated process wrote without telling the page. If so, the confirm step lists those changes ("Beth Smith changed Amount 1,200 → 1,450 · 3 min ago", line and file changes too). Review re-reads the record so the changes appear on the page; Continue moves it as it is now. When nothing changed there is no extra step.'
    },
    {
      type: 'note',
      text: 'Changes that already reached your screen live are not listed again. Fields you cannot read never appear, and a linked record you cannot open reads "a record you can\'t see".'
    },
    { type: 'h3', id: 'record-glance-title', text: 'Live title' },
    {
      type: 'p',
      text: 'When a record is renamed, or gets its number from a partner or a procedure (even right after you saved it yourself), the heading, the browser tab name and the breadcrumb update quietly in place with a short fade. No message is shown.'
    },
    { type: 'h3', id: 'record-glance-cards', text: 'Hover cards on record links' },
    {
      type: 'p',
      text: 'Pause the mouse on a link to another record — a related record on a record page, a link column in a list, or a record number mentioned in a comment — and a small card shows its current step, who it is with, and its key amounts. The card stays up to date while it is open. A record you cannot open shows no card at all.'
    },
    { type: 'h3', id: 'record-glance-files', text: 'File processing' },
    {
      type: 'p',
      text: 'After an upload, images get a small thumbnail and documents (PDF, Word, Excel, text) have their text read in the background, so Ask AI can use them straight away. While that runs the file shows "Processing…"; it updates in place when done, for everyone who has the record open.'
    },
    {
      type: 'table',
      head: ['Endpoint', 'What it answers'],
      rows: [
        [
          'GET /api/records/:collection/:id/unseen?since=&fields_since=',
          'Changes by other people since that time, as you may read them (field before/after, lines, files).'
        ],
        [
          'GET /api/records/:collection/:id/card',
          'The hover card: name, step, owners, SLA, key amounts. 404 when you cannot read the record.'
        ],
        [
          'GET /api/files/processing?ids=a,b',
          'Processing status per file you can read: processing, ready or failed. The end is announced as file:processed in the record room.'
        ]
      ]
    }
  ]
}
