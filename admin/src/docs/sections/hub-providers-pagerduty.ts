import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 2: PagerDuty. Facts are from the adapter code:
// api/src/services/hub/providers/pagerduty/**. Nothing here ran against a live PagerDuty account
// yet.

export const hubProvidersPagerdutyDocs: DocSection = {
  id: 'hub-providers-pagerduty',
  label: 'Provider: PagerDuty',
  content: [
    { type: 'h1', id: 'hub-providers-pagerduty', text: 'Provider: PagerDuty — Hub mode only' },
    {
      type: 'p',
      text: 'Connection fields: `region` (US or EU: the hosts are `api.pagerduty.com` + `events.pagerduty.com`, or the `.eu.` pair), `from_email` (the email of a PagerDuty user the Hub writes as; PagerDuty requires it on every write) and a secret `token` (a general access REST API key). A REST key belongs to one PagerDuty account, so an id from another account answers 404 and reads as missing. PagerDuty lists no rights for a key: Test checks that the key can read each kind of resource and that the From email is a real user, and assumes a key that reads can also write (a read-only key fails at its first change). PagerDuty bills per user seat, not per resource, so none of these types has a cost estimate.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`pagerduty.service`',
          '`<serviceId>`',
          'Name, description, the escalation policy (a ref), incident urgency, auto-resolve and acknowledgement timeouts (0 = off) and alert creation. Delete is `destructive` + `data_loss` (its incident history goes). Health: status and the number of open incidents.'
        ],
        [
          '`pagerduty.escalation_policy`',
          '`<policyId>`',
          'Two levels the Hub manages: level 1 pages a schedule (a ref) and/or people, level 2 pages people, each after the same delay, repeated `num_loops` times. People are given as email addresses. A policy that has more levels or other targets at PagerDuty shows "has more levels than the Hub manages" and a change replaces them. Delete is `destructive`.'
        ],
        [
          '`pagerduty.schedule`',
          '`<scheduleId>`',
          'A copy of the Hub on-call rota for the app: one weekly layer with the people (by email, first person first), the hand-over weekday and time on the schedule’s time zone, and the day the rota starts. A change to any of those is the named op **`sync_rota`** ("Copy the Hub on-call rota to …"); it rewrites the first layer in place and removes any other layer. Drift = someone edited the schedule in PagerDuty: the people, hand-over or time zone no longer match.'
        ],
        [
          '`pagerduty.integration`',
          '`<serviceId>/<integrationId>`',
          'An Events API v2 integration on a service (replace on a service change; delete and replace are `destructive`). The **routing key** is an output, never part of observed or desired state. It is also the sender: see below.'
        ],
        [
          '`pagerduty.maintenance_window`',
          '`<windowId>`',
          'Pages nobody for a service between a start and an end (UTC ISO times). Create, change and replace are flagged `downtime` (typed confirm in production). A window that has already ended is left out of Unmanaged. The adapter ships a pure helper that turns a planned Hub freeze or maintenance item into these fields.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-providers-pagerduty-notify', text: 'Hub events through PagerDuty' },
    {
      type: 'p',
      text: 'A `pagerduty.integration` is a sending resource: a notify route (`/hub/connections` → Notify routes) can name it for events such as "Incident opened". One message is one Events API v2 call to `events.pagerduty.com`:'
    },
    {
      type: 'ul',
      items: [
        '**Open** and **update** send a `trigger`; **resolve** sends a `resolve`. The Hub’s own incident key `incident:<id>` becomes the PagerDuty dedup key `hub-incident-<id>`, so one Hub incident is one PagerDuty incident whatever it posts later. Any other key is kept (made safe, at most 255 characters). Resolve without a key is refused.',
        'Severity maps one to one (info, warning, critical). The title is the incident summary, the text goes into the details, and the Hub link is attached as a link.',
        'The adapter reads the routing key from PagerDuty at send time with the REST key, so a key regenerated at PagerDuty keeps working and the Hub never needs the sealed copy to send. The key is never written to a step, an audit row or an error: PagerDuty’s refusal text is scrubbed of it. A 429 is retryable.',
        'The Hub’s own on-call rota and paging are unchanged. PagerDuty is an extra place a Hub incident can page through.'
      ]
    },
    {
      type: 'ul',
      items: [
        'Outputs: `routing_key` (secret). PagerDuty shows it again on request, so it is never once-only and the Hub can re-read it. Bind it to a stack secret; an app setting is not offered for it.',
        'People are matched by email. An email PagerDuty does not know stops the change with `UNKNOWN_USERS` and the address named; nothing is guessed or invited.',
        'A create that finds a service, policy, schedule, integration (same name on the service) or an identical maintenance window the Hub did not make stops with `ALREADY_EXISTS`: adopt it instead.',
        'Needs a live check: PagerDuty’s handling of the weekly layer across a daylight-saving change (a fixed 604800-second turn), the `events_api_v2_inbound_integration` create type, and whether a policy delete is refused while a service still uses it.'
      ]
    }
  ]
}
