import type { DocSection } from '../types.js'

export const collabWatchList: DocSection = {
  id: 'watch-list',
  label: 'Watch List',
  content: [
    { type: 'h1', id: 'watch-list', text: 'Watch List' },
    {
      type: 'p',
      text: 'The watch list keeps the records you care about in view on every page, a little like a stock watch list. Each row stays current on its own: you never reload a page to see where a record stands.'
    },
    { type: 'h3', id: 'watch-list-pin', text: 'Pin a record' },
    {
      type: 'ul',
      items: [
        'Click the pin beside a record’s title (on the record page or in the record sheet).',
        'Or choose “Add to watch list” from a list row’s ⋯ menu or its right-click menu.',
        'Or press W while a record is open. Press W again to unpin it.',
        'You can pin up to 50 records. Unpin from the row’s × (hover the row), from the pin again, or from the row menu.'
      ]
    },
    { type: 'h3', id: 'watch-list-rows', text: 'What a row shows' },
    {
      type: 'ul',
      items: [
        'The record’s name and its main figure (an amount, when the record has one).',
        'Its current step and how long it has been there next to the usual time records spend on that step, for example “20 d / usually 17 m” (amber once it has been there longer than usual).',
        'Who owns the current step.',
        'What changed last, who did it and when, for example “Moved to Approved · Beth Lee · 2 m”.',
        'A countdown when the step has a deadline, turning amber and red at the deadline’s own lines.',
        'Hover a row for its card (step, owners, key amounts). Click it to look at the record in the side sheet; Cmd / Ctrl-click opens it in a new tab.'
      ]
    },
    {
      type: 'p',
      text: 'When someone else changes a pinned record, its row gets a soft tint and a small dot until you look at it: open it, or use “Mark all as seen” (the double tick). Your own changes never light a row. A record you can no longer open shows as “No longer available” with a Remove button, and nothing else about it.'
    },
    { type: 'h3', id: 'watch-list-dock', text: 'Open, minimized or closed' },
    {
      type: 'ul',
      items: [
        'Open: a column at the right edge of the page. It takes its own space and never covers the page. Drag its left edge to make it wider or narrower (or focus the edge and use the arrow keys).',
        'Minimized (the – button): a slim strip showing how many records you pin and how many changed. Click it to open the list again.',
        'Closed (the × button): only the binoculars icon stays, in the sidebar (admin) or the top bar. A small dot on it means a pinned record changed, or a mention is waiting, while the list was closed.',
        'Shift W opens or closes the list from anywhere.',
        'On narrow windows and phones the list never takes a column: the binoculars icon opens it as a panel over the page.',
        'Whether it is open, its width, the tab and the sort are remembered for you on every device.'
      ]
    },
    { type: 'h3', id: 'watch-list-sort', text: 'Order' },
    {
      type: 'p',
      text: '“My order” keeps the order you choose: drag a row by the grip on its left edge. “Last change” puts the most recently changed records first; “Due soonest” puts the nearest deadlines first.'
    },
    { type: 'h3', id: 'watch-list-waiting', text: 'Waiting on others' },
    {
      type: 'p',
      text: 'The Waiting tab lists records you raised that are sitting on a step someone else owns: who it is with and how long it has waited, longest first. “Raised” means you created the record (in the last 180 days), or the record’s “created by” field names you. It updates on its own as records move.'
    },
    { type: 'h3', id: 'watch-list-mentions', text: 'Mentions & replies' },
    {
      type: 'ul',
      items: [
        'Mentions: every time someone @mentioned you in the last 30 days. These are your mention notifications, so reading one here also marks it read in the bell, and the other way round.',
        'Replies: comments other people left after your own last comment on the same record (or the same field’s thread).',
        'Click one to look at the record and mark it read. “Mark all read” clears the tab.'
      ]
    },
    { type: 'h3', id: 'watch-list-alerts', text: 'Alerts on a pinned record' },
    {
      type: 'p',
      text: 'Hover a pinned row and click the bell to be told when something happens to that record. The bell stays lit while the record has an alert.'
    },
    {
      type: 'ul',
      items: [
        'It reaches a step: pick the step. You are told when the record arrives there (not when you moved it yourself).',
        'A field changes: pick one of the fields you can see. You are told when someone else changes it.',
        'It’s overdue: you are told when its current step passes its due time, once per step it runs late on.',
        'Choose Once (the alert switches itself off after it fires) or Every time.',
        'Alerts arrive as notifications under “Watch list alerts”, so Profile → Notification rules decides whether they also push or email. Unpinning a record removes its alerts.'
      ]
    },
    { type: 'h3', id: 'watch-list-settings', text: 'Settings' },
    {
      type: 'p',
      text: 'The settings button (the sliders, at the top of the list) holds switches that are yours alone. All of them start off.'
    },
    {
      type: 'ul',
      items: [
        'Desktop alerts: a notice from your computer when someone else changes a pinned record while the page is in the background. Your browser asks for permission the first time you turn it on (never before). One notice per burst of changes, never for your own changes, and only one even with several tabs open.',
        'Daily email: one email a day listing what changed on your pinned records in the last day, by someone other than you. It comes at your own daily-summary hour (Profile → Notifications) in your time zone, or at 7 AM Eastern when you have not set one. Nothing is sent on a quiet day.',
        'Records that land on my step: when a record moves to a step you own, it is pinned for you.',
        'Unpin them when they leave my step: a record pinned that way goes again when it moves on. A record you pinned yourself always stays.'
      ]
    },
    { type: 'h3', id: 'watch-list-completed', text: 'Remove records when they’re completed' },
    {
      type: 'p',
      text: 'A list can tidy itself: when a record on it is completed, the row says “Completed” with a green check, so you see it finished, and then it leaves the list on its own.'
    },
    {
      type: 'ul',
      items: [
        'Completed means the record reached a final step of its pipeline. For a kind of record with no pipeline, it means the same “Inactive” or “Archived” rule the pickers’ badges use.',
        'Your own list: turn it on in Settings → Remove records when they’re completed. It starts off.',
        'A shared list: the person who made it sets it in “Rename or change people”. New shared lists start with it on; lists made before it existed stay off until someone turns it on.',
        'A completed record leaves 24 hours after it was completed, or as soon as you have seen it: opened it, marked it seen, or closed the list after it showed you “Completed”. On a shared list it waits the 24 hours.',
        'If the record is reopened before it leaves, the mark goes away and it stays.',
        'Recently removed, at the bottom of the list, keeps removed records for 7 days. Undo puts one back, and it then stays until you unpin it.',
        'Nobody is notified when a record leaves a list.'
      ]
    },
    { type: 'h3', id: 'watch-list-shared', text: 'Shared lists for a team' },
    {
      type: 'ul',
      items: [
        'Settings → New shared list: give it a name and add people. You are on it; a manager or an administrator can also make one for a team they are not on (“Add my direct reports” adds yours in one go).',
        'Everyone on the list sees it as its own tab in the watch list, and can add records to it from a record page: the people icon beside the pin.',
        'Each person only sees the records on it they are allowed to open. A record someone else cannot open is simply not in their tab.',
        'Changes by others light rows the same way as your own list; your “seen” marks are yours alone.',
        'The person who made it (or an administrator) can rename it, change its people or delete it from the list’s ⋯ menu. Anyone else can leave it there.',
        'If the person who made it can no longer sign in (suspended, removed, or an integration account), the list stays visible but read-only. An administrator can choose Take ownership from its ⋯ menu to keep it going, or delete it.'
      ]
    },
    {
      type: 'note',
      text: 'Everything in the list is read as you: only records, fields and comments you may see. Nothing in it polls; it follows the records over the live connection and refreshes at most once a second, however many changes arrive.'
    }
  ]
}
