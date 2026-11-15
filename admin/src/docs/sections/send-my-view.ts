import type { DocSection } from '../types.js'

export const collabSendMyView: DocSection = {
  id: 'send-my-view',
  label: 'Send My View',
  content: [
    { type: 'h1', id: 'send-my-view', text: 'Send my view' },
    {
      type: 'p',
      text: 'Show a colleague exactly what you are looking at. On a record, a list or a queue worklist, press the paper-plane button, pick the person, add a note if you like, and press Send. A list keeps its filters, sort, columns and page size; a record opens on the same tab.'
    },
    { type: 'h3', id: 'send-my-view-recipient', text: 'What the other person gets' },
    {
      type: 'ul',
      items: [
        'If they have the app open, a small card appears in the corner: "Rob sent you: Workflows — Region: NER". Open takes them there; Later puts it in their notifications instead.',
        'If they do not have the app open, it arrives as an ordinary notification in the "Views sent to you" category, which they can mute under Profile → Notification rules.',
        'They see the screen with their OWN access. A list shows the rows they may read; a record they cannot read shows the usual no-access page. Nothing of what you can see is sent — only where to go and how the view is set up.'
      ]
    },
    {
      type: 'note',
      text: 'Sending is for people on their own sign-in: API keys, connected apps and View-as cannot send. Each person can send a few views a minute.'
    },
    { type: 'h3', id: 'send-my-view-api', text: 'API' },
    {
      type: 'table',
      head: ['Route', 'What it does'],
      rows: [
        [
          'POST /api/send-view',
          '`{to, view: {kind: record | list | queue, collection?, item?, queue?, lv?, tab?, summary?}, note?}` → `{id, mode: live | notification}`. 429 RATE_LIMITED, 403 SEND_VIEW_PEOPLE_ONLY.'
        ],
        [
          'GET /api/send-view/:id',
          'The recipient only (404 for anyone else): the view described as THEY may see it, with the target to open.'
        ],
        [
          'POST /api/send-view/:id/later',
          'The recipient keeps it as a notification instead of the card.'
        ]
      ]
    },
    { type: 'h2', id: 'list-viewers', text: 'Who else is viewing this list' },
    {
      type: 'p',
      text: 'Administrators see small avatars on a list or queue toolbar when other people have the same list open ("Beth and 2 others are viewing this too"). Hover for the names. Everyone else sees nothing, and their browser is never sent the names. Someone using View-as is never counted.'
    },
    { type: 'h2', id: 'record-room-chip', text: 'Live state chip in record chat rooms' },
    {
      type: 'p',
      text: 'The top of a record\'s chat room shows the record\'s current step, its owners and when the step is due ("Due in 5h", "3h overdue"). It updates by itself when the record moves or its owners change. It only shows for people who can see the room and read the record.'
    }
  ]
}
