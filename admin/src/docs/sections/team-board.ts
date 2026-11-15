import type { DocSection } from '../types.js'

export const collabTeamBoard: DocSection = {
  id: 'team-board',
  label: 'Team Board and Write-to-Screen Time',
  content: [
    { type: 'h1', id: 'team-board', text: 'Team Board and Write-to-Screen Time' },
    {
      type: 'p',
      text: 'Two views for administrators under Operations, Realtime: who is working on which record right now, and how long a change someone saves takes to show on everyone else’s screen.'
    },
    { type: 'h2', id: 'team-board-who', text: 'Team board' },
    {
      type: 'p',
      text: 'Realtime, Team board lists everyone signed in, grouped by role, by team (their manager) or by a zone-like dimension when the Online list is set to show one. Each person shows the records they have open, with the record’s name, how long it has been open and a pencil when they are editing it. Click a record to open it. People on a list or another page show where they are instead. A green dot means active, grey means idle (with how long), amber means stuck: at the keyboard on the same record with nothing saved for ten minutes.'
    },
    {
      type: 'ul',
      items: [
        'Only administrators see the team board. It is built from what presence already knows (open tabs, the records they sit on, edit locks) and nothing about it is stored.',
        'Record names come through your own access, so a record you cannot read shows its number only.',
        'When an administrator uses View-as, the board shows the person being viewed, marked View-as. The administrator behind it is not named.',
        'The board follows changes quietly, at most every two seconds, and rows keep their order by name. With Live updates set to Off, press ↻ to refresh it.'
      ]
    },
    { type: 'h2', id: 'write-to-screen', text: 'Write to screen' },
    {
      type: 'p',
      text: 'Realtime, Write to screen measures the whole trip of a change: from the save to the moment another person’s open page has re-drawn it. It is split into reaching the tab (the live event arriving) and re-drawing (the page reading the change and painting it), with the median and p95 by hour, and per screen and collection so a slow page stands out.'
    },
    {
      type: 'ul',
      items: [
        'Screens time a small sample of changes, the same sample the delivery check uses (about 1 in 50, and at least one every 30 seconds per server). Only times, the screen’s pattern and the collection name are sent, never values or record numbers.',
        'Tabs that are hidden, set to Calm or Off live updates, and the tab that made the save are not timed.',
        'The daily report has a line for it, for example "Changes reached other screens in 0.8 s p95", and the slowest screen.',
        'Figures are kept as hourly totals for 15 days.'
      ]
    },
    {
      type: 'pre',
      code: 'GET  /api/realtime/team-board                 administrators\nGET  /api/realtime/write-to-screen?hours=24    administrators (1–336)\nPOST /api/rum/screen-timing                    signed in; the app sends this itself'
    }
  ]
}
