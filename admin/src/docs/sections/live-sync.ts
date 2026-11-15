import type { DocSection } from '../types.js'

export const collabLiveSync: DocSection = {
  id: 'live-sync',
  label: 'Offline saves and shared budget grids',
  content: [
    { type: 'h1', id: 'live-sync', text: 'Offline saves and shared budget grids' },
    { type: 'h3', id: 'live-sync-offline', text: 'Saves made while you were offline' },
    {
      type: 'p',
      text: 'A Save pressed while the connection was down waits and goes out when you are back online. Before it goes, the app checks each field against what others changed while you were away. Fields nobody else touched are saved at once.'
    },
    {
      type: 'p',
      text: 'A field someone else changed is never sent on its own. A small card in the corner lists it — for example “Beth changed Amount while you were offline” — with their value and yours, and three choices:'
    },
    {
      type: 'ul',
      items: [
        '**Keep mine** — your value is saved over theirs.',
        '**Take theirs** — your change to that field is dropped.',
        '**Merge** — for long text and multi-value fields; combine both, then **Use merged**.'
      ]
    },
    {
      type: 'p',
      text: 'Nothing on the card is sent until every field on it has a choice. If someone changes the same field again before it goes, it comes back to the card instead of being overwritten. The check reads the record as you: a field you may no longer see shows only that it changed, never its value. If the record is open in a form, the form’s own merge dialog handles it instead. Fold the card away with the arrow; it stays as one line until something new needs a look.'
    },
    { type: 'h3', id: 'live-sync-grids', text: 'Who is editing a budget or forecast grid' },
    {
      type: 'p',
      text: 'On the forecast worksheet, allocation matrices and browse-then-edit grids, a quiet line near the top says who else is editing and where — “Beth is editing allocations for 4471 · East · Fiber” — and the cell they are in has a thin outline in their colour (point at it for their name). Moving quickly across cells shows only the cell they stop on.'
    },
    {
      type: 'ul',
      items: [
        'You only see people on rows you are allowed to read; the server checks this for every row, as you.',
        'Names, rows and cells only — never the amounts someone is typing.',
        'With live updates set to Calm or Off (Profile → Display) the line and outlines are hidden. Others still see you.',
        'A mark fades by itself within a minute if the other person’s browser closes without saying goodbye.'
      ]
    },
    {
      type: 'note',
      text: 'Matrix and grid pages can name what they edit with the `presence_noun` option (for example `allocations`); without it the line uses the collection name.'
    }
  ]
}
