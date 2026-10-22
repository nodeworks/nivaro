import type { DocSection } from '../types.js'

export const chaosOpsDocs: DocSection = {
  id: 'chaos-ops',
  label: 'Operators, Limits, Monkey & Phone Stop',
  audience: 'admin',
  content: [
    { type: 'h1', id: 'chaos-ops', text: 'Operators, Limits, Monkey & Phone Stop' },
    {
      type: 'p',
      text: 'Four things keep chaos drills safe in day-to-day operations: who may run them, how far a run may reach on each instance, a Chaos Monkey that runs small drills at random times when you switch it on, and a Stop button that reaches your phone.'
    },
    { type: 'h2', id: 'chaos-ops-operators', text: 'Chaos operators' },
    {
      type: 'p',
      text: 'Administrators may always run faults. In **Chaos → Settings** an administrator can name roles whose members may also start, stop and record drills (and read the chaos console). Only administrators change these settings, so an operator can never widen their own reach. API keys limited to named collections are refused. Only administrators may override the working-hours pre-flight check.'
    },
    { type: 'h2', id: 'chaos-ops-limits', text: 'Limits on this instance' },
    {
      type: 'p',
      text: 'Each instance keeps its own limits, so development and staging can differ even when they share a database. The server applies them to every run started there — from the console, a game day, Chaos Monkey or a script — whatever the form sent.'
    },
    {
      type: 'table',
      head: ['Limit', 'What happens over it'],
      rows: [
        ['Faults allowed', 'A fault off the list is refused (403 `CHAOS_CAP`).'],
        [
          'Share of traffic',
          'A larger share is lowered to the limit. A run aimed at everything becomes that share when the fault can take a share; any other target (some routes, a table, a person, a replica) is sampled at the limit on top. A route pattern with fewer than two fixed parts (`/*`, `/api/*`) is refused.'
        ],
        ['Added delay', 'Every delay measured in ms is lowered to the limit.'],
        ['Run length', 'The window is shortened (never under 5 seconds).'],
        [
          'Replicas',
          'A run that would reach more replicas is narrowed to the one it started on, or refused when the fault cannot aim at one replica.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Whatever was lowered is recorded on the run (`meta.caps`). Empty means no limit beyond the fault’s own.'
    },
    {
      type: 'note',
      text: 'Socket drills started from the Realtime page (/realtime → Verification) are the one path outside these limits and the pre-flight: they are administrator-only, pass the same gate, and keep their own 5–600 s window and share/room/person targets. Stop all on the Chaos page ends them too. Start a socket drill from the Chaos console (fault “Socket drill”) when you want the limits, the pre-flight and a run with a verdict.'
    },
    {
      type: 'note',
      text: 'Stored under the `chaos` key of this instance’s `nivaro_settings_overrides` row (`GET`/`PATCH /api/chaos/settings`, administrators). No migration.'
    },
    { type: 'h2', id: 'chaos-ops-drill-alerts', text: 'Alerts during a drill' },
    {
      type: 'p',
      text: 'An alert that fires while a fault is armed — log alert rules, request rules, monitors, metric alerts, integration alerts, a readiness check turning to fail — is never silenced or rerouted: everyone who normally hears about it still does, by every channel they normally get. Its message gains a line naming the run: “May be caused by the chaos drill …” when the alert is about what the fault touches (a database alert during a database fault), otherwise “Fired during the chaos drill …”. The drill’s people (whoever started it, the game day’s lead, scribe and responders; for Chaos Monkey, administrators and chaos operators) are told too, in-app, when they were not already. The Ops Console, Telemetry and the Integrations console show a **Drill** tag on alerts that fired during a run. In a blind game day the note is left out of the normal recipients’ copy; the alert itself still reaches them.'
    },
    { type: 'h2', id: 'chaos-ops-monkey', text: 'Chaos Monkey' },
    {
      type: 'p',
      text: 'Off until an administrator turns it on in **Chaos → Monkey**. Every 15 minutes, inside the days and hours you set (Eastern time), it may start one drill from the faults you approved, at random moments so that about the weekly number land across the week. Each drill is small (a share of traffic, else one replica) and short, and the instance’s limits apply on top. Administrators and chaos operators are told when it starts and when it ends, with the verdict.'
    },
    {
      type: 'ul',
      items: [
        'Never on an instance that looks like production (its instance key, or `NIVARO_TIER=production`), and never while another drill is armed.',
        'Pre-flight still judges every drill (deploys, maintenance, open incidents…); a refusal is kept as a refused monkey run and does not count toward the week.',
        '**Try now** runs one tick at once, skipping only the dice.',
        'The `chaos-monkey` job ticks only where scheduled jobs run, on one server at a time.'
      ]
    },
    { type: 'h2', id: 'chaos-ops-phone', text: 'Stop from your phone' },
    {
      type: 'p',
      text: 'When a drill starts, and again if it stops itself because what should stay true broke, the person who started it and its participants get a browser notification with **Stop all faults**. Tapping it ends every fault on the instance, even when that phone is not signed in.'
    },
    {
      type: 'p',
      text: 'The button carries a signed token that works once, only for that person and run, and only until the drill’s window ends (five minutes after an abort). The person must still be a chaos operator. It keeps working while Redis is down and during maintenance.'
    }
  ]
}
