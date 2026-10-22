import type { DocSection } from '../types.js'

export const chaosBuilderDocs: DocSection = {
  id: 'chaos-builder',
  label: 'Experiment builder, presets and "what if"',
  content: [
    { type: 'h1', id: 'chaos-builder', text: 'Experiment builder, presets and "what if"' },
    {
      type: 'p',
      text: 'The experiment builder is how a drill is set up on the Chaos page. It opens under a fault when you press Run on the Faults tab, and at full width on the Builder tab. It walks through eight steps and keeps a summary beside them that reads the run back in plain words.'
    },
    {
      type: 'table',
      head: ['Step', 'What you choose'],
      rows: [
        ['Fault', 'Which fault to arm, with the claim it proves and how far it can reach.'],
        [
          'Target',
          'Everything, a route pattern (picked from the Traffic Map’s last 15 minutes or typed, such as `/api/items/*`), one table, one person, a share of traffic or one replica.'
        ],
        ['Strength', 'The fault’s settings, such as the added delay. Sliders stop at the caps.'],
        ['Duration', 'How long it stays armed. It ends by itself when the time is up.'],
        [
          'What stays true',
          'The steady state: lines such as “server errors < 1 %”, each checked every 5 seconds.'
        ],
        [
          'Abort limits',
          'How many bad samples in a row stop the run (1 to 10, usually 3; one sample every 5 seconds, so 3 is about 15 seconds), and the tolerance on each line. Past the tolerance for that many samples in a row the run aborts on every replica.'
        ],
        [
          'Blast radius',
          'An estimate from the last 24 hours of traffic of what would stop or slow down if the fault’s dependency went fully down. Faults that take no whole dependency down show “no estimate”.'
        ],
        ['Pre-flight', 'The checks that must pass before Run, re-run by the server at the start.']
      ]
    },
    {
      type: 'p',
      text: 'Run takes two clicks: Run, then a red “Confirm — arms <fault> on <target> for <n>s”. The confirm button goes back to Run after a few seconds if you do not press it. The server checks the target, the strength and the duration again whatever the page sends, including the per-environment caps when chaos settings set them.'
    },
    {
      type: 'p',
      text: 'The limits come from this instance’s chaos settings. Chaos operators who are not administrators get the same limits as administrators: the builder reads them from `GET /api/chaos/operator`.'
    },
    {
      type: 'note',
      text: 'Link straight into the builder with /chaos?tab=builder&fault=<fault key>, &preset=<preset key>, or &spec=<JSON> carrying fault_key, target, params, seconds, hypothesis and abort_after. The Traffic Map’s “Inject fault here” and Ask AI’s drafts use these links.'
    },

    { type: 'h2', id: 'chaos-presets', text: 'Presets' },
    {
      type: 'p',
      text: 'A preset is a saved experiment: fault, target, strength, duration, what stays true and how many bad samples stop it, with a sentence on what it proves and the claims it tests. The Presets tab lists the shipped presets and the ones saved on this instance. Run opens the preset in the builder to check and confirm; nothing arms from the list.'
    },
    {
      type: 'p',
      text: 'There is a shipped preset for every claim a fault on this instance can prove. Each is a small first run: a short window (two minutes at most), a narrow target where the fault allows one, and a light strength.'
    },
    {
      type: 'table',
      head: ['Area', 'Shipped presets'],
      rows: [
        ['Requests and mail', 'Slow answers stay honest · Mail down fails clean'],
        [
          'Database',
          'Slow database queues at the read gate · Database errors fail one request · Background pool held, requests stay fast'
        ],
        [
          'Redis',
          'Redis outage fails open · Slow Redis is tolerated · Read-only Redis is survived · Lost query cache rebuilds · Signed-out sessions stay signed out · Redis eviction is tolerated · Cut-off replica catches up'
        ],
        [
          'Scheduler',
          'Scheduler pauses when its lease expires · No job runs twice when the lease splits'
        ],
        [
          'Partners and services',
          'Partner errors are contained · Full disk fails uploads cleanly · AI down answers 503 · Refused AI model falls back · Sign-in down, sessions hold · Slow sign-in says so · Microsoft Graph down fails clean'
        ],
        [
          'One replica',
          'A stalled replica is drained · The heap guard catches memory pressure · Clock skew is safe · Sockets reconnect and catch up'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Presets for one replica pick the first replica in the builder, or the replica that answers when started straight from the API.',
        'The Redis key-loss and eviction presets are refused on development when Redis runs on database 0, which every local instance shares. The refusal shows when you start the run.',
        'Taking a web task down has no preset: it runs only inside a game day with a host runbook.',
        'Save as preset in the builder stores the current draft under a name and key. Opened from a preset, it can also update that preset.',
        'Editing a shipped preset saves your own copy under the same key. Deleting that copy brings the shipped one back; shipped presets themselves cannot be deleted.',
        'Saved presets are configuration (`nivaro_chaos_presets`) and move between instances with config promotion and show up in Environment Config diffs.',
        'A preset whose fault this instance does not have is listed as “Fault not on this instance” and cannot run.',
        'Runs started from a preset record its key, so the run history shows where it came from.'
      ]
    },
    {
      type: 'table',
      head: ['Route', 'What it does'],
      rows: [
        [
          'GET /api/chaos/presets',
          'Shipped and saved presets, each with whether its fault is installed.'
        ],
        ['POST /api/chaos/presets', 'Save a preset {key, label, proves, claim_keys, spec}.'],
        ['PATCH /api/chaos/presets/:key', 'Edit a preset (a shipped key becomes a saved copy).'],
        ['DELETE /api/chaos/presets/:key', 'Delete a saved preset.'],
        [
          'POST /api/chaos/presets/:key/run',
          'Start a drill from the preset; the body may override target, params, seconds, hypothesis and abort_after.'
        ]
      ]
    },

    { type: 'h2', id: 'chaos-what-if', text: 'Ask “what if X died?”' },
    {
      type: 'p',
      text: 'Administrators can ask Ask AI, the Telemetry page’s Ask, or a connected MCP client what happens if a dependency dies: the database, Redis, the file share, email, the AI provider, the sign-in provider, partner APIs, sockets or one replica. The answer lists the claims about it and when each was last proven by a drill, the routes, screens and jobs the blast-radius estimate expects to fail or slow down, the last drills against it, and a draft experiment.'
    },
    {
      type: 'warn',
      text: 'The answer never starts a drill. Its draft is a link that opens the builder pre-filled, where a person still checks pre-flight and presses Run and Confirm.'
    },
    {
      type: 'p',
      text: 'The same answer is `GET /api/chaos/what-if?dependency=redis` (administrators). The MCP tool is `chaos_what_if`, offered to administrator connections only.'
    }
  ]
}
