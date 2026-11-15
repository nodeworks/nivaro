import type { DocSection } from '../types.js'

export const collabLiveSetting: DocSection = {
  id: 'live-updates-setting',
  label: 'Live Updates: Normal, Calm or Off',
  content: [
    { type: 'h1', id: 'live-updates-setting', text: 'Live Updates: Normal, Calm or Off' },
    {
      type: 'p',
      text: 'Screens follow other people’s changes on their own. Some people like that; some find it distracting. Choose how much movement you want under Profile, Display, Live updates. It applies to every open tab and device straight away.'
    },
    {
      type: 'table',
      head: ['Setting', 'What you see'],
      rows: [
        [
          'Normal',
          'Changes appear as they happen. A changed value fades in briefly, a new row carries a small dot, and you see who else has the record open and who is writing a note.'
        ],
        [
          'Calm',
          'The same up-to-date data, quieter. Values change without fades, flashes or dots. A list keeps its order while you move the pointer or type, and settles once you pause for a few seconds. No typing or "who else is here" indicators.'
        ],
        [
          'Off',
          'Nothing updates by itself. Press ↻ (refresh this page’s data) to see the latest; it keeps your edits and your place. A small "Live updates off" note sits beside ↻ so a still screen is never mistaken for one with nothing new.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Off still lets through what you need: your own saves, notifications, requests to release a record you are editing, changes to your access, and a new version of the app.'
    },
    { type: 'h3', id: 'live-updates-role-default', text: 'A default for a role' },
    {
      type: 'p',
      text: 'Administrators can set the starting point for a role under Roles, UI Access, Live updates. People with that role get it until they choose for themselves; "Role default" in their Display settings shows which one applies. Normal means no default is set.'
    }
  ]
}
