import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 2, Task 15 (Cloudflare). Facts are from the merged code:
// api/src/services/hub/providers/cloudflare/**. Nothing here ran against a live Cloudflare
// account yet (see the last list).

export const hubProvidersCloudflareDocs: DocSection = {
  id: 'hub-providers-cloudflare',
  label: 'Provider: Cloudflare',
  content: [
    { type: 'h1', id: 'hub-providers-cloudflare', text: 'Provider: Cloudflare — Hub mode only' },
    {
      type: 'p',
      text: 'Connection fields: `accountId` (the 32-character account id; the connection is pinned to it) and secret `apiToken` (an account or user API token). The only host is `api.cloudflare.com`. Account-level calls carry the pinned account in the path; zone-level calls first read the zone and refuse it (`CLOUDFLARE_OUT_OF_ACCOUNT`) when it belongs to another account, so a token that can see more than one account never leads the Hub into the others. Test verifies the token, names the account, probes a read for each resource type and, when Cloudflare lets the token list its own permission groups, checks the write group each type needs (DNS Write, Cloudflare Tunnel Write, Access: Apps and Policies Write, Workers R2 Storage Write, Workers Routes Write, Workers Scripts Write, Zone WAF Write). When it cannot list them, only read access is checked and the message says so.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`cloudflare.zone`',
          'zone id',
          'Shared. A zone of the pinned account, read and adopt only: the Hub never creates, edits or deletes a zone. DNS records, WAF rules and Worker routes point at it.'
        ],
        [
          '`cloudflare.dns_record`',
          '`<zone id>:<record id>`',
          'A, AAAA, CNAME, TXT, MX or NS record. Names may be relative or `@`. The Hub writes its resource id at the end of the record’s comment (`nivaro-hub:resource=41`) so a resumed run recognises its own record. Delete is `destructive`; moving an A, AAAA, CNAME, MX or NS record is `downtime`; turning "proxied" off is `public_exposure` (the origin address becomes visible).'
        ],
        [
          '`cloudflare.tunnel`',
          'tunnel id',
          'A remotely managed Cloudflare Tunnel. Outputs `tunnel_token` (secret; bind it to a stack secret for the cloudflared container), `tunnel_id` and `cname_target` (`<id>.cfargotunnel.com`, what a proxied CNAME points at). The token can be read again, so it is not once-only. Delete is `destructive` + `downtime`, and is refused (`TUNNEL_IN_USE`) while the tunnel is connected.'
        ],
        [
          '`cloudflare.tunnel_route`',
          '`<tunnel id>:<hostname>`',
          'One public hostname → service rule in the tunnel’s ingress list. The Hub reads the whole list, changes its own rule and writes it back with the catch-all last; other rules and settings are kept. A raw `tcp://`, `ssh://` or `rdp://` service is `public_exposure`; changing or removing a rule is `downtime`. It does not make DNS: the hostname’s CNAME is a `cloudflare.dns_record`. A locally managed tunnel is refused (`TUNNEL_LOCAL`).'
        ],
        [
          '`cloudflare.access_application`',
          'application id',
          'A self-hosted Zero Trust application (hostname, session duration). Output `aud`, the audience tag a service checks. Delete, or moving it to another hostname, takes the protection off the old hostname: `public_exposure`.'
        ],
        [
          '`cloudflare.access_policy`',
          '`<application id>:<policy id>`',
          'A policy of one application: decision (allow, deny, non_identity, bypass) and include / exclude / require rules (everyone, email, email domain, IP range, group, service token, any service token). A policy that lets everyone in — an allow or bypass whose include has "everyone" and no require rule narrows it — is `public_exposure` (a Hub admin approves). Rules the Hub does not model are kept as they are.'
        ],
        [
          '`cloudflare.r2_bucket`',
          'bucket name',
          'An R2 bucket (default jurisdiction) with an optional location hint. Name and location never change. Delete is `destructive` + `data_loss` and is refused (`BUCKET_NOT_EMPTY`) while the bucket holds objects: Cloudflare’s REST API cannot delete objects, so empty it with the dashboard or an S3 tool first. S3 API keys cannot be made by this token: create them in the dashboard and paste the access key id and the secret once into the resource’s sealed fields; the Hub passes them on as once-only outputs (`access_key_id`, `secret_access_key`) for a binding. Other outputs: `endpoint`, `bucket`.'
        ],
        [
          '`cloudflare.worker_route`',
          '`<zone id>:<route id>`',
          'A route pattern on a zone that sends requests to a Worker script (or none: Workers off for the pattern). Changing or removing a live route is `downtime`; a route over every hostname (`*/…`) is `downtime` on create. The script itself is not in scope: scripts come from the app’s own CI.'
        ],
        [
          '`cloudflare.worker_secret`',
          '`<script>:<name>`',
          'One secret of an existing Worker script. The value is write-only: it is sent once and never read back, so a change is a new value pasted into the sealed field. Delete is `destructive`.'
        ],
        [
          '`cloudflare.waf_custom_rule`',
          '`<zone id>:<rule id>`',
          'One rule of the zone’s custom-rules ruleset (block, challenge, JS challenge, managed challenge or log). The description is its name. A rule that blocks or challenges every request (an always-true expression, switched on) is `downtime`; the check is a pattern test on common always-true expressions, so it errs towards asking.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'A create that finds a record, tunnel, Access application or policy, bucket, route, secret or rule the Hub did not make stops with `ALREADY_EXISTS`; adopt it instead. Nothing is patched silently.',
        'Estimates are list prices from a dated table in the adapter (Cloudflare has no price API): a zone costs its plan (Free, Pro, Business; Enterprise is "No estimate"), DNS records, tunnels, WAF rules and Worker secrets are included, Zero Trust is free up to 50 users and then per user for the whole account, and an R2 bucket is usage-priced (storage past 10 GB, operations; data out is free).',
        'Later providers reuse this one: the ACME adapter creates its `_acme-challenge` TXT records through the same DNS helpers, and the registrar adapter reuses the zone helpers.',
        'Needs a live check: the Zero Trust policy endpoints, the R2 not-empty error code, and the tunnel configuration read-and-write were written from the Cloudflare API documentation and recorded answers, not run against an account. Run create → read → change → delete once per type on a throwaway account.'
      ]
    }
  ]
}
