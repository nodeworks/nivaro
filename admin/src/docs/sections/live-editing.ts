import type { DocSection } from '../types.js'

export const liveEditingDocs: DocSection = {
  id: 'live-editing',
  label: 'Editing Together',
  content: [
    { type: 'h1', id: 'live-editing', text: 'Editing a record together' },
    {
      type: 'p',
      text: 'When several people have the same record open, the form shows who is where, lets you point someone at a field, and keeps your work safe when a line goes away under you. Nothing here sends a notification or an email.'
    },
    { type: 'h2', id: 'section-presence', text: 'Who is in a folded section' },
    {
      type: 'p',
      text: 'A folded section shows small avatars when someone else is working inside it, for example “Beth is in Shipping”. It counts a field, or a line or cell of a lines grid in that section. You only see this for fields on your own form, so a field you cannot read never shows anyone. Live updates set to Calm or Off hide it.'
    },
    { type: 'h2', id: 'point-to-field', text: 'Point someone to a field' },
    {
      type: 'ul',
      items: [
        'Hover a field and press the small target button (or right-click the field) and choose “Point Beth Ames here”. The list names the people who have this record open right now.',
        'If Beth is idle on the record, her page scrolls to the field and outlines it briefly. If she is typing, has a menu open or uses Calm or Off, she sees a quiet chip instead: “Rob pointed you to Amount · Go”.',
        'Nothing is saved: no comment, no notification. It only reaches people viewing the record now who can read that field, and you can point the same person once every few seconds.'
      ]
    },
    { type: 'h2', id: 'line-removed', text: 'When a line is removed under you' },
    {
      type: 'p',
      text: 'If someone else, or a procedure, deletes the line you are editing or have focus in, the editor closes, focus moves to the next line, and a calm note says who removed it (“Beth removed this line”). Anything you had typed into that line and not saved stays in a chip: Copy puts it on the clipboard, Restore as new line opens a new line filled with it. Nothing is saved until you save.'
    },
    { type: 'h2', id: 'value-source', text: 'Where a value came from' },
    {
      type: 'p',
      text: 'Rest the pointer on a field for a moment, or watch a value change live, and a small line at the end of its label says where the value came from: “Set by Beth · 2 m ago”, “Set by ERP Sync” (a partner system), “Set by import (po-lines)”, “Set by procedure reforecast” or “Changed outside the app”. It reads the record’s history and, for writes made straight to the database, what the procedure announced. Only fields you may read are answered.'
    },
    {
      type: 'note',
      text: 'Procedures name themselves through the `@Source` of `nivaro_announce_writes` (for example `procedure:reforecast`); an announcement without a prefix is shown as that procedure’s name. These sources are kept for a week per record.'
    }
  ]
}
