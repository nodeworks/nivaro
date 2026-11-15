import type { DocSection } from '../types.js'

export const collabRecordContext: DocSection = {
  id: 'record-context',
  label: 'Names, Uploads, Reasons and Help',
  content: [
    { type: 'h1', id: 'record-context', text: 'Names, Uploads, Reasons and Help' },
    {
      type: 'p',
      text: 'Four more things a record page keeps current while it is open, without a reload. Everything is read as you: you only see names, files, fields and requests you could open yourself. Your Live updates setting (Profile → Display) applies: Calm shows the same information without fades or "who is uploading" lines, Off waits for the refresh button.'
    },
    { type: 'h3', id: 'record-context-names', text: 'Linked names follow renames' },
    {
      type: 'p',
      text: "When someone renames a record that another page shows by name — the project on a workflow, the vendor in a list column, a name inside the record heading — the name changes in place on every open page within about a second. Only a change to the fields that make up that record's name counts; other edits to it cause no reads. Each name is read again as you, so a record you cannot open never shows its new name."
    },
    { type: 'h3', id: 'record-context-uploads', text: 'Who is uploading' },
    {
      type: 'p',
      text: 'While someone uploads into a file field on a record you have open, that field shows "Beth is uploading “quote.pdf” · 60%" with a thin progress bar, and it goes away when the upload finishes, is cancelled or their page closes. The file name is shown only to people allowed to read that field; everyone else reads "Beth is uploading a file". Your own upload button shows its percentage too.'
    },
    { type: 'h3', id: 'record-context-reasons', text: 'Why a value moved' },
    {
      type: 'p',
      text: 'When the app works a value out again by itself — a formula field, a value copied from a linked record, a total of the record\'s lines, or a form rule — the field says why, under its value: "Moved 2 days later because PO due date changed", "Up 1,200 because Amount on Line 4 changed". Hover it to see the old and new value. The note shows for three days, and only while the field still holds that value; a later change by hand or by another system retires it. A field or linked record you cannot read is never named — if none of the reasons is visible to you, no note is shown.'
    },
    {
      type: 'note',
      text: 'Notes are kept for a week in the cache, not in the database. Changes made outside the app (procedures, scripts, imports that bypass it) leave no note.'
    },
    { type: 'h3', id: 'record-context-help', text: 'Help requested' },
    {
      type: 'p',
      text: 'When someone asks the support team for help from a record (⋯ → Request a change or Get help), the record heading shows a "Help requested by …" chip until the request is closed, but only for the people allowed to see that request: the person who asked, the person working on it, the support team and administrators. They can open the request from the chip. Everyone else sees nothing. The chip appears and goes away live.'
    },
    {
      type: 'table',
      head: ['Endpoint / event', 'What it does'],
      rows: [
        [
          'GET /api/records/:collection/:id/derived',
          'Why derived values on the record moved, judged for you: field, old and new value, what changed (field and linked record labels only when you may read them).'
        ],
        [
          'GET /api/support/record/:collection/:item',
          "Open support requests raised from the record that you may see (requester, assignee, the request's team, administrators); nothing for anyone else."
        ],
        [
          'record:uploading (record room)',
          'Upload start, progress, finish and cancel from a co-viewer. The file name only reaches people who may read the field; others get "a file".'
        ],
        [
          'collection:update with $support',
          'A request raised from the record opened, moved or closed (ids and the aspect name only).'
        ]
      ]
    }
  ]
}
