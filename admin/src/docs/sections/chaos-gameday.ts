import type { DocSection } from '../types'

export const chaosGamedayDocs: DocSection = {
  id: 'chaos-gamedays',
  label: 'Chaos game days',
  content: [
    { type: 'h1', id: 'chaos-gamedays', text: 'Chaos game days' },
    {
      type: 'p',
      text: 'A game day is a planned drill: a date and time, the people taking part, and a timed list of things that will go wrong. It lives on the chaos console (Operations → Health → Chaos) under Game days. Chaos is refused in cloud mode and on production unless CHAOS_ENABLED=true, so game days are for staging and development.'
    },
    { type: 'h2', id: 'gameday-planning', text: 'Planning a day' },
    {
      type: 'ul',
      items: [
        'Plan a game day opens the editor. Start from a blank plan or the monthly staging template (kill a web task, drop Redis, block the file share, slow the database, with checkpoints before and after).',
        'Times are Eastern. The length is 15 minutes to 8 hours.',
        'People: a lead (faults are armed as the lead), an optional scribe, and responders. Everyone named gets an invitation at once and reminders 24 hours and 15 minutes before (notification category "Chaos drills and game days").',
        'Injects run at +mm:ss after the start: arm a fault from the catalog for a number of seconds, post an announcement to the day’s channel (as the lead, through the normal chat send), or reach a checkpoint. A fault key this instance does not have is a warning when you save and is skipped on the day.',
        'Chat channel: a private channel for the participants. A timeline bot posts each fault and checkpoint as it happens, with fixed wording only — never the plan’s own labels. Start a huddle from the channel header.',
        'Repeat monthly: when the day ends or is cancelled, the same slot next month (same weekday, same week of the month, same Eastern time) is planned with the same people.'
      ]
    },
    { type: 'h2', id: 'gameday-running', text: 'On the day' },
    {
      type: 'ul',
      items: [
        'The lead presses Start now, or the scheduler starts the day at its time when "Start automatically" is on. Each fault inject goes through the drill pre-flight; a refusal is recorded on the timeline instead of stopping the day.',
        'Injects fire on time from the chaos-gamedays job (every minute, one server) and from a timer on the server that started the day; whichever comes first fires it, and it fires once. An inject more than ten minutes late is marked missed and never fired late.',
        'Fire now runs a waiting inject by hand. End day closes the day, stops any fault still armed and writes the result; Abort does the same with the verdict aborted. Stop all on the console always works and ends a running day too.',
        'The day’s verdict is the worst of its fault runs (held, broke or aborted).'
      ]
    },
    { type: 'h2', id: 'gameday-scribe', text: 'Scribe marks' },
    {
      type: 'p',
      text: 'While a day runs, anyone taking part can stamp what happened in one click — Noticed, Found cause, Fixed — or type a note. The marks become the day’s time to detect, time to find the cause and time to fix, measured from the first fault that went live, and show on the inject track and in the report. Notes stamped on one of the day’s fault runs land on the day itself.'
    },
    { type: 'h2', id: 'gameday-blind', text: 'Blind mode' },
    {
      type: 'ul',
      items: [
        'A blind day hides its faults from the responders: no drill banner for them, and drill-tagged alerts are not marked as a drill for them. The lead and chaos operators (administrators) still see everything.',
        'Declare incident (Ops Console header) is open to everyone signed in. It stamps a "Declared incident" mark on every running game day and blind drill — the responders’ time to detect — and always answers the same way, so it never gives away that a drill is running.',
        'The lead reveals the drill at any time; the faults then show on the banner for everyone and the channel gets a line saying so. A single drill can also be started blind through POST /api/chaos/blind/runs.'
      ]
    },
    { type: 'h2', id: 'gameday-kill-task', text: 'Killing a web task' },
    {
      type: 'p',
      text: 'The API never writes to Docker. The "Kill a web task" fault queues the host runbook chaos-kill-web-task in the Runbooks host queue; the host agent on the swarm manager runs it and swarm replaces the task. A deployment declares that runbook in its extension (runs on the host, no dry run needed, a target such as staging). Without it the fault is refused with that reason. Stopping the fault withdraws a kill still waiting in the queue.'
    },
    { type: 'h2', id: 'gameday-api', text: 'API' },
    {
      type: 'table',
      head: ['Route', 'Who', 'What'],
      rows: [
        ['GET /api/chaos/gamedays', 'admin', 'Every game day'],
        [
          'GET /api/chaos/gamedays/:id',
          'admin',
          'Plan, timeline, fault runs, people, time to detect / fix'
        ],
        [
          'GET /api/chaos/gamedays/active',
          'signed in',
          'The days I take part in (titles and times only)'
        ],
        [
          'POST /api/chaos/gamedays',
          'chaos operator',
          'Plan a day; PATCH /:id edits it while planned'
        ],
        [
          'POST /api/chaos/gamedays/:id/start | step | end | cancel | reveal',
          'chaos operator',
          'Run the day; step takes {inject_id}, end takes {how}'
        ],
        [
          'GET / POST /api/chaos/runs/:id/notes',
          'admin or participant',
          'Scribe marks {mark, text}'
        ],
        ['POST /api/chaos/declare', 'signed in', 'Declare incident'],
        [
          'POST /api/chaos/blind/runs',
          'chaos operator',
          'One drill, blind; /blind/runs/:id/reveal reveals it'
        ]
      ]
    }
  ]
}
