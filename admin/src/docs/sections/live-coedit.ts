import type { DocSection } from '../types.js'

export const collabLiveCoedit: DocSection = {
  id: 'live-coedit',
  label: 'Writing together in long text',
  content: [
    { type: 'h1', id: 'live-coedit', text: 'Writing together in long text' },
    {
      type: 'p',
      text: 'Rich-text fields on a record (notes, descriptions, anything with the formatting toolbar) can be written by several people at once. When two of you have the same field open and type in it, each person’s typing appears in the other’s field as it happens — nobody overwrites anybody.'
    },
    { type: 'h3', id: 'live-coedit-see', text: 'What you see' },
    {
      type: 'ul',
      items: [
        'The other person’s cursor: a thin line in their colour with their first name above it. What they select is tinted in the same colour.',
        'A quiet line under the field: “Writing together with Ana”.',
        'Their text lands where they type it. Your own cursor stays where you put it.'
      ]
    },
    { type: 'h3', id: 'live-coedit-save', text: 'Saving' },
    {
      type: 'p',
      text: 'The field saves the normal way: whoever presses Save saves the whole text, both people’s writing included. The other person is not asked about it — their form already holds the same text, so there is nothing to choose and nothing more to save. If they keep typing after that save, only their newer writing is still unsaved.'
    },
    { type: 'h3', id: 'live-coedit-who', text: 'Who takes part' },
    {
      type: 'ul',
      items: [
        'People who may change the field type together and see each other’s cursors.',
        'People who may only read the field see the text change as it is written, without cursors.',
        'People who may not see the field get nothing at all — not the text, not that someone is writing there.',
        'With record locking on, the person holding the lock is the one writing; everyone else watches the text live until the lock is released.'
      ]
    },
    { type: 'h3', id: 'live-coedit-apart', text: 'When your text stays separate' },
    {
      type: 'p',
      text: 'If you had already changed the field (and not saved) before someone else started writing in it, your version stays yours. A line under the field says so. When one of you saves, the other gets the usual Keep mine / Take theirs / Merge choice (see Working on the same record).'
    },
    {
      type: 'p',
      text: 'The same happens if your connection drops: the field becomes an ordinary field again, what you typed stays in your form, and Save checks it against what others saved.'
    },
    {
      type: 'note',
      text: 'Plain multi-line text boxes (no toolbar) are not written together live — they keep the per-line Merge when two people save different text.'
    },
    { type: 'h3', id: 'live-coedit-tech', text: 'For developers' },
    {
      type: 'p',
      text: 'The writing session is temporary: the starting text, the edits since and who is in it live in Redis for as long as someone is writing (10 minutes after the last activity at most), never in the database. Socket events `coedit:watch|open|steps|sync|cursor|close` ride the app’s socket; the rooms are gated by the record read check and the field’s read permission (write permission to type). A session holds at most about 2 MB of edits; past that it ends and the field saves the ordinary way. Someone whose right to change the field ends while they type (a lock, the record moving on) drops out within seconds and keeps watching. Headless apps get it through the shared record form — no extra wiring.'
    }
  ]
}
