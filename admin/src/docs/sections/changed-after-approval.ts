import type { DocSection } from '../types.js'

export const collabChangedAfterApproval: DocSection = {
  id: 'changed-after-approval',
  label: 'Changed After Approval',
  content: [
    { type: 'h1', id: 'changed-after-approval', text: 'Changed After Approval' },
    {
      type: 'p',
      text: 'An approval means something only if what was approved stays the same. When a record that reached an approved step changes afterwards — an administrator editing through the post-approval lock, a process or partner writing back, an accepted change proposal — its header shows an amber "Changed after approval" badge.'
    },
    { type: 'h3', id: 'changed-after-approval-badge', text: 'The badge' },
    {
      type: 'ul',
      items: [
        'Click it for the list of changes: each field with the value it had when it was approved, crossed out, and the value now, plus who changed it and when.',
        '"Changed outside the app" means a procedure, import or script wrote it; the app has no person to name.',
        'Line changes made from the record page are counted on their own row.',
        'You only see fields you are allowed to read. A field you cannot read never shows that it changed.',
        'A field changed and then put back to its approved value is not listed.',
        'The badge updates on its own while the page is open (it follows your Live updates setting). It goes away when the record is sent back or reopened — the next approval starts a new comparison.'
      ]
    },
    { type: 'h3', id: 'changed-after-approval-notice', text: 'The notice to approvers' },
    {
      type: 'p',
      text: 'The people who approved the record get one quiet notice per burst of changes ("Changed after approval: CM26-1234"), never for a change they made themselves, and only when they can still open the record and read a field that changed. A save that changes ten fields, or an import that touches the record many times, is one notice; the next notice comes only after ten quiet minutes. Turn it off or move it to email in Profile → Notification rules → Changed after approval.'
    },
    { type: 'h3', id: 'changed-after-approval-list', text: 'Finding them in a list' },
    {
      type: 'p',
      text: 'Lists of a collection with the badge on have a "Changed after approval" button in the toolbar. It keeps the records that sit in an approved step and were changed in the app since. Saved views and shared links keep it. Changes written outside the app show on the record badge but not in this filter.'
    },
    { type: 'h3', id: 'changed-after-approval-setup', text: 'Setting it up' },
    {
      type: 'p',
      text: 'It is on by default for every collection with a post-approval lock, and watches the lock\'s states. Turn it off in Data Model → the collection → Form UX → Show "Changed after approval" (administrators). Fields the lock leaves open (for example On hold) never count. A collection without a lock can name its approved states in `summary_mode_rules.changed_after_approval: { "states": ["approved"] }`.'
    }
  ]
}
