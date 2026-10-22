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
          'The tolerance on each line. Past it for three samples in a row (about 15 seconds) the run aborts on every replica.'
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
      type: 'note',
      text: 'Link straight into the builder with /chaos?tab=builder&fault=<fault key>, &preset=<preset key>, or &spec=<JSON> carrying fault_key, target, params, seconds and hypothesis. The Traffic Map’s “Inject fault here” and Ask AI’s drafts use these links.'
    },

    { type: 'h2', id: 'chaos-presets', text: 'Presets' },
    {
      type: 'p',
      text: 'A preset is a saved experiment: fault, target, strength, duration and what stays true, with a sentence on what it proves and the claims it tests. The Presets tab lists the shipped presets (one for each common claim, such as “Redis outage fails open”) and the ones saved on this instance. Run opens the preset in the builder to check and confirm; nothing arms from the list.'
    },
    {
      type: 'ul',
      items: [
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
          'Start a drill from the preset; the body may override target, params, seconds and hypothesis.'
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
