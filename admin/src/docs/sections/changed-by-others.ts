import type { DocSection } from '../types.js'

export const collabChangedByOthers: DocSection = {
  id: 'changed-by-others',
  label: 'Changed by Others',
  content: [
    { type: 'h1', id: 'changed-by-others', text: 'Changed by Others' },
    {
      type: 'p',
      text: 'Two ways to see what other people did to a list while you were away, without reloading anything.'
    },
    { type: 'h3', id: 'changed-by-others-chip', text: 'The "Changed by others" filter' },
    {
      type: 'p',
      text: 'Every collection list has a "Changed by others" button next to Add Filter. Pick a period: Last hour, Last 24 hours, Last 2 days, Last 5 days, Last 7 days, or Custom range (a start and an optional end date and time). The list then shows only records someone other than you created, edited or moved through its pipeline in that period. Your own changes never count.'
    },
    {
      type: 'ul',
      items: [
        'The period rolls: "Last 24 hours" always means the 24 hours before the list was read. A custom range stays fixed.',
        'It combines with your other filters, search and saved views, and saving a view keeps it.',
        'While the filter is on, a record someone else changes appears in the list on its own.',
        'It reads the activity log. A collection whose audit level is "none" keeps no log, so nothing in it shows as changed. A custom range looks back at most 31 days from its end.',
        'Click the chip to change the period, or the × to remove it.'
      ]
    },
    { type: 'h3', id: 'changed-by-others-views', text: 'Changed since you last opened a view' },
    {
      type: 'p',
      text: 'A saved view you have opened before shows a small cyan pill with a number, for example "• 12": twelve records in that view were changed by someone else since you last opened it. The number is counted as you, so it only includes records you can see, and it moves on its own as people work.'
    },
    {
      type: 'ul',
      items: [
        'Opening the view resets the number. The rows that changed in between get a pale tint and a hollow ring in the first column until you switch to another view.',
        'Each person has their own number for each view, shared views included.',
        'The view you have open shows no number: its rows already update in place.',
        'A view you last opened more than 31 days ago counts the last 31 days.',
        'An administrator viewing as someone sees their numbers but does not reset them.'
      ]
    }
  ]
}
