import type { DocSection } from '../types.js'

export const collabTabCount: DocSection = {
  id: 'live-tab-count',
  label: 'Tab Count and Screen-Reader Notices',
  content: [
    { type: 'h1', id: 'live-tab-count', text: 'Tab Count and Screen-Reader Notices' },
    {
      type: 'p',
      text: 'Two quiet ways the app tells you something changed while you are looking elsewhere. Both are on by default and both are yours to change under Profile, Display.'
    },
    { type: 'h3', id: 'live-tab-count-title', text: 'The count in the browser tab' },
    {
      type: 'p',
      text: 'When things are waiting on you, the tab title starts with the number, for example "(3) My Work · EFP", and the tab icon carries a small red dot with the same number (9+ above nine). The number counts records you own, approval steps waiting on you and questions put to you. Open tasks are not counted. It follows live, so you do not have to look at the page to learn that something arrived. When nothing is waiting, the title and icon go back to normal. A custom (white-label) icon stays your icon; the dot is drawn over it.'
    },
    {
      type: 'note',
      text: 'Turn it off with "Count in the browser tab" in Profile, Display. It then leaves the title and icon alone.'
    },
    { type: 'h3', id: 'live-announce', text: 'Live changes for screen readers' },
    {
      type: 'p',
      text: 'The app has one polite announcement area for screen readers. When something on the page you are viewing changes because of someone else, it says so in a short sentence ("Status changed", "2 rows updated"). It never repeats more than once every five seconds, folds a burst into one sentence, never speaks about your own changes, and never reads a value out; it names the field only.'
    },
    {
      type: 'table',
      head: ['Setting', 'What you hear'],
      rows: [
        [
          'Say what changed (default)',
          'The field names when one record changed, otherwise a count of rows.'
        ],
        ['Brief', 'Only that something changed ("Updated", "5 rows updated").'],
        ['Off', 'Nothing.']
      ]
    }
  ]
}

export const collabLiveTrace: DocSection = {
  id: 'live-trace',
  label: "Why Didn't My Page Update?",
  content: [
    { type: 'h1', id: 'live-trace', text: "Why Didn't My Page Update?" },
    {
      type: 'p',
      text: 'A trace for administrators and support when someone says a page showed old data. It is read-only and never shows a value: only record ids, field names, people and times.'
    },
    {
      type: 'ul',
      items: [
        'On a record: the More menu, "Why didn\'t this update?" (administrators only).',
        'On a person: their page, Admin tools, "Why didn\'t their page update?".'
      ]
    },
    {
      type: 'p',
      text: 'Pick a window (15 minutes up to 24 hours). The trace lists the writes to the record, the live events the server sent for it, who is listening, and a short "What this says" summary in plain words.'
    },
    {
      type: 'table',
      head: ['Section', 'What it tells you'],
      rows: [
        [
          'Writes',
          'Saved changes, announcements still waiting to be sent, and rows whose updated time moved with no activity entry (a procedure or script that wrote without announcing). Each write says whether a live event covered it.'
        ],
        [
          'Who is subscribed now',
          'Who has the record (or its whole list) open right now, and whether their screen confirmed an event.'
        ],
        [
          'Live events sent',
          'Each event with its time, action and field names. The journal keeps 24 hours.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Two limits are stated on the page. The server keeps no history of who was connected earlier, so subscribers are a picture of now. And screens confirm only a sample of events (about 1 in 50), so "not confirmed" is a hint, not proof that an event was missed.'
    },
    {
      type: 'p',
      text: 'On a person it shows their live connections (app, transport, since when), how many rooms each is in, and how many events went to those rooms in the window. If they have no live connection, nothing can be pushed to them.'
    },
    {
      type: 'p',
      text: 'The API is GET /api/realtime/trace?collection=&item= for a record or ?user= for a person, with optional from and to (ISO dates, at most 24 hours apart). Administrators only.'
    }
  ]
}
