import type { DocSection } from '../types.js'

export const readyToSend: DocSection = {
  id: 'ready-to-send',
  label: 'Ready to Send',
  content: [
    { type: 'h1', id: 'ready-to-send', text: 'Ready to Send' },
    {
      type: 'p',
      text: 'Integrations → Ready to send lists records that a partner system would turn away at their next send, before anyone presses the button. Every night the app finds each open record whose next manual step sends to a partner API and checks that step the same way the record page’s Push readiness chip does. Problems can then be fixed during the day instead of turning into failed sends.'
    },
    { type: 'h2', id: 'rts-what', text: 'What is checked' },
    {
      type: 'ul',
      items: [
        'Values the step asks for when it is pressed, per field and per line ("Asks for Sales order on 2 lines").',
        'The step’s conditions, as sentences ("PO number must be filled in").',
        'Each push the step makes: its guard, whether its payload can be built, and anything the partner’s contract requires that would be empty.',
        'Only pushes that apply to the record count. If a record can take two sending steps and only one of them is open to it, the other is not listed.'
      ]
    },
    { type: 'h2', id: 'rts-board', text: 'Reading the board' },
    {
      type: 'table',
      head: ['Label', 'Meaning'],
      rows: [
        ['Refused', 'The step would stop, or a blocking push would not go. Fix this first.'],
        [
          'Incomplete',
          'The step would go through, but a push would be skipped or the partner would get something empty.'
        ],
        [
          'Asks on send',
          'The step’s own dialog will ask for these values when it is pressed. Not a problem, but it shows what the person will need.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Use the Partner and Problem lists on the left to narrow the records. Each record shows its current step, the step that sends, what stands in the way, and who owns the current step. Open the record to fix it, then press Check again: the record is checked live, as you, and the board takes the new answer.'
    },
    {
      type: 'note',
      text: 'You only see records you are allowed to read. That is decided when you open the board, not when the nightly check ran.'
    },
    { type: 'h2', id: 'rts-run', text: 'When it runs' },
    {
      type: 'p',
      text: 'The job `ready-to-send` runs at 04:20 each night (Jobs → Runs & schedules, where it can be paused or moved). Administrators can press Run now on the board. A run checks every such record, 100 at a time, and lets other work through between batches, so a large instance may take a while. If a run is cut short (a deploy or a restart), the board keeps showing the last complete check and says where the latest one stopped; the next run starts from the beginning. The check only reads: nothing is sent, written back or logged against the partner. The result is kept on the job’s own run, and the daily operations report has a Ready to send section with the counts.'
    },
    {
      type: 'pre',
      code: `GET  /api/ready-to-send          newest board (records you may read), grouped
POST /api/ready-to-send/run      administrators: run the check now (202)
POST /api/ready-to-send/check    { collection, item } — check one record again, live`
    }
  ]
}
