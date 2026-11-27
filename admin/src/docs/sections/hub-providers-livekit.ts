import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 3, Task 35: LiveKit Cloud. Facts are from the adapter:
// api/src/services/hub/providers/livekit/**. Nothing here ran against a live project yet.

const HUB_ONLY =
  'Everything on this page exists only on a Nivaro Hub (`HUB=on`). A regular install, Nivaro Cloud and a Hub shared deployment have none of it.'

export const hubProvidersLivekitDocs: DocSection = {
  id: 'hub-providers-livekit',
  label: 'Provider: LiveKit Cloud',
  content: [
    { type: 'h1', id: 'hub-providers-livekit', text: 'Provider: LiveKit Cloud — Hub mode only' },
    { type: 'warn', text: HUB_ONLY },
    {
      type: 'p',
      text: 'Gives an app the media server its large huddles use. LiveKit Cloud has no public API to make a project, so the project is made in the LiveKit dashboard and adopted; the Hub never creates or deletes one. A key is pasted once, sealed, and handed to the app’s huddle settings by a binding. The app’s own huddle code is not touched.'
    },
    { type: 'h2', id: 'hub-providers-livekit-connection', text: 'Connection' },
    {
      type: 'p',
      text: 'Three fields: the project URL (`wss://<project>.livekit.cloud`, no port, path or login), the API key name and the sealed API secret. The only allowed host is that project host, so a URL that is not a `*.livekit.cloud` address allows nothing. The Hub talks to LiveKit’s server API over HTTPS and signs each call with a 60 second token made from the key and secret (HS256, node crypto). Test lists rooms and checks that egress and SIP are reachable; SIP shows as missing when the project does not have it turned on.'
    },
    { type: 'h2', id: 'hub-providers-livekit-types', text: 'Resource types' },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`livekit.project`',
          'the project host',
          'Shared, adopt only. Health shows rooms open, people connected and whether the project answers. An id that is not the connection’s project reads as gone.'
        ],
        [
          '`livekit.api_key`',
          'the key name',
          'A key pair pasted once. Create checks the pair against the project (a list-rooms call signed with it), seals it and answers the outputs. Nothing is made at LiveKit. Delete only forgets it in the Hub: the key keeps working until it is deleted in the dashboard.'
        ],
        [
          '`livekit.room`',
          'the room name',
          'Read, plus a Close action for a stuck huddle (flagged `destructive`: everyone in it is disconnected). The app names rooms with a hash, never the channel or record.'
        ],
        [
          '`livekit.egress`',
          'the egress id',
          'Read, plus a Stop action while it is starting or active (flagged `downtime`; the output is finalised, not discarded).'
        ],
        [
          '`livekit.sip_trunk`',
          'the trunk id',
          'Inbound or outbound phone trunk: create, update, delete. A create that finds the name already in the project is refused `ALREADY_EXISTS` (adopt it). Changing direction is a replace. An inbound trunk with no address limit (or 0.0.0.0/0) and no SIP login is open to the whole internet: `public_exposure`, Hub administrators only. The SIP password is write-only.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'LiveKit bills usage, so none of these types has a cost class and none adds to the monthly estimate.'
    },
    { type: 'h2', id: 'hub-providers-livekit-outputs', text: 'Outputs and bindings' },
    {
      type: 'table',
      head: ['Output', 'Kind', 'Bind it to'],
      rows: [
        ['`api_key`', 'secret', 'app setting `huddle_livekit_key`'],
        ['`api_secret`', 'secret, shown once', 'app setting `huddle_livekit_secret`'],
        ['`url`', 'plain', 'app setting `huddle_livekit_url`']
      ]
    },
    {
      type: 'p',
      text: 'Bind all three and a created app has huddles with no hand setup. The secret is shown once, when LiveKit makes the key: if the Hub’s sealed copy is lost it cannot be read again. Make a new key in the dashboard and paste that one on the same resource; the Hub checks it and replaces the sealed copy.'
    },
    { type: 'h2', id: 'hub-providers-livekit-safety', text: 'Safety rules' },
    {
      type: 'ul',
      items: [
        'Close and Stop send only the room or egress named by the resource itself; an op whose target is not that resource is refused `TARGET_MISMATCH` before any call.',
        'A key the project refuses is `KEY_NOT_ACCEPTED`; the pasted secret is masked in every error.',
        'A 429 is a retryable failure and says when to retry.'
      ]
    },
    {
      type: 'note',
      text: 'Not yet checked against a live project: the exact JSON shape of SIP trunk updates (list fields are sent as `set` lists) and the SIP permission on a project without SIP. Run the live check (Task 32) before relying on them.'
    }
  ]
}
