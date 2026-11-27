import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 3: Let's Encrypt / ACME. Facts are from the adapter code:
// api/src/services/hub/providers/acme/**. Tested against a fake CA and fake DNS APIs only; nothing
// here ran against a real ACME server yet.

export const hubProvidersAcmeDocs: DocSection = {
  id: 'hub-providers-acme',
  label: 'Provider: Let’s Encrypt (ACME)',
  content: [
    {
      type: 'h1',
      id: 'hub-providers-acme',
      text: 'Provider: Let’s Encrypt (ACME) — Hub mode only'
    },
    {
      type: 'p',
      text: 'Issues and renews TLS certificates over ACME v2 with **DNS-01** only, through the Cloudflare or AWS Route 53 connection that holds your DNS zones. The cryptography (account signing, orders, keys, CSRs) is the maintained `acme-client` package; the Hub only sequences the DNS proof around it. One connection is one ACME account key at one certificate authority.'
    },
    { type: 'h2', id: 'hub-providers-acme-connection', text: 'The connection' },
    {
      type: 'table',
      head: ['Field', 'What it is'],
      rows: [
        [
          'Certificate authority',
          '**Let’s Encrypt staging** is the default: its certificates are not trusted by browsers, and its rate limits are generous, so a first run costs nothing. A Hub administrator switches the connection to **Let’s Encrypt production** (or **Another ACME CA** with its https directory URL) once staging worked. Only Hub administrators edit connections, so only they can make that switch. The only host the connection may call is the directory’s host.'
        ],
        ['Contact email', 'Where the CA writes about expiring certificates and problems.'],
        [
          'DNS connection',
          'The id of the Hub connection (Cloudflare or AWS Route 53) the TXT proof records are made in. It is a connection setting, not something an app owner picks: a resource can only point at resources of its own connection, and which DNS account may be written to is an administrator’s decision. The Hub reads that connection (read only) and the Cloudflare or Route 53 adapter does the writes, with its own account pin.'
        ],
        [
          'Allowed domains',
          'When set, every name (wildcards included) must equal an entry or sit under one, else the plan fails with `NAME_NOT_ALLOWED`. Names are compared lower-case, without a trailing dot, non-ASCII as punycode. When it is **empty**, every certificate order (create, reissue, rotate, renew) is admin-only and the plan says why: an app owner can never order a name outside their app.'
        ],
        [
          'Seconds to wait for DNS',
          'How long to wait after the TXT record exists before asking the CA to check it (default 10, at most 120). Route 53 also waits for its own “in sync” answer.'
        ],
        [
          'ACME account key',
          'Secret, sealed, never shown again. Use **Generate account key** on the saved connection (admin only: the server makes an EC P-256 key and seals it; the key is never answered; replacing a stored key makes a new ACME account and asks twice), or paste your own PEM (EC P-256/P-384 or RSA 2048+). `POST /api/hub/connections/:id/acme/generate-account-key`. The Hub cannot re-read the key.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-providers-acme-types', text: 'Types' },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`acme.account`',
          'the account URL at the CA',
          'Shared (Hub administrators). Makes the account for the connection’s key (you must agree to the CA’s terms of service), changes its contact email, adopts an account the key already has, or deactivates it. Deactivating cannot be undone and stops every renewal made through that account: it needs a typed confirm. A create for a key that already has an account stops with `ALREADY_EXISTS`: adopt it.'
        ],
        [
          '`acme.certificate`',
          'the certificate URL at the CA',
          'An app resource. Fields: **Names** (host names, or `*.example.com`), **DNS zone** (the zone id in the DNS connection), **Key type** (EC P-256 default, EC P-384, RSA 2048, RSA 4096), the **ACME account** it orders from. All names must be inside the one zone. Outputs `fullchain` (public) and `private_key` (secret, shown once). A CA has no list of certificates, so nothing is adoptable: a certificate is made by the Hub.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-providers-acme-dns', text: 'How a certificate is proven' },
    {
      type: 'ul',
      items: [
        'The Hub generates a fresh private key and a CSR, opens an order for the names, and for every name makes a `_acme-challenge` TXT record in the zone (Cloudflare: marked with the resource, so an interrupted run’s leftover is swept at the next order; Route 53: the Hub merges its value into the TXT set and removes only its own value, so other TXT values at that name survive).',
        'After the wait it asks the CA to check each challenge, finalises the order, fetches the chain and **always** removes its TXT records, also when the order failed. A record that cannot be removed is counted in the step’s answer (`cleanup_failed`).',
        'A wildcard and its apex (`example.com` + `*.example.com`) share one TXT name: two records, both removed.',
        'A name outside the zone is refused before any order is made (`NAME_OUTSIDE_ZONE`); a name outside the connection’s allowed domains is `NAME_NOT_ALLOWED`; a private Route 53 zone is refused (`ACME_ZONE_PRIVATE`: the CA cannot see it).'
      ]
    },
    { type: 'h2', id: 'hub-providers-acme-renewal', text: 'Renewal, limits and risk' },
    {
      type: 'ul',
      items: [
        '**Renewal** is planned 30 days before expiry, by the same drift pass that checks everything else (the plan has a `renew` step, same names, a fresh key). A renewal is a normal change: no typed confirm, not a cost. The old certificate stays valid until it expires.',
        'Changing the names or the key type orders a new certificate (`reissue`). **Make a new key and certificate** (`rotate_outputs`) does the same when the sealed private key is lost: the CA never shows a key again, so it cannot be re-read, only re-made.',
        '**At most one order per certificate per hour.** An order made less than an hour after the certificate was issued waits (`ACME_ORDER_TOO_SOON`, retryable). A 429 from the CA is retryable (`ACME_RATE_LIMITED`) and says how long to wait. Let’s Encrypt production also limits certificates per exact set of names (about 5 a week): use staging to try things.',
        'A **new wildcard name** is `public_exposure` (a Hub administrator starts it): one certificate that answers for every subdomain. Renewing an approved wildcard is not flagged. Staging and production are not told apart by risk; the plan text says STAGING while the connection is on staging.',
        'Deleting a certificate only makes the Hub forget it (and its sealed key): the CA is not asked to revoke it, and what already uses it keeps working until it expires.',
        'Ids are URLs at the CA, encoded; an id from another directory host is refused (`ACME_DIRECTORY_CHANGED`: switching a connection to another CA does not silently lose its certificates). Errors are scrubbed of the account key and of the certificate’s private key before they are clipped.',
        'Both types are free (`confidence: exact`); no type has a cost class.'
      ]
    },
    { type: 'h2', id: 'hub-providers-acme-bindings', text: 'Bindings: Traefik’s file provider' },
    {
      type: 'p',
      text: 'Bind `fullchain` and `private_key` to **stack secrets** of the Traefik stack (for example `TLS_FULLCHAIN` and `TLS_PRIVATE_KEY`). The Hub agent mounts a stack’s secrets under `/run/secrets/<KEY>` (64 KB each), so Traefik’s dynamic file configuration can name them: `tls.certificates: [{certFile: /run/secrets/TLS_FULLCHAIN, keyFile: /run/secrets/TLS_PRIVATE_KEY}]`. A binding marks the stack “needs apply”; it never applies by itself. After a renewal the new values are pushed to the same bindings, and you apply the stack (a rolling restart of Traefik picks them up). `private_key` is a once-only output: if the Hub’s sealed copy is lost, use **Make a new key and certificate**.'
    },
    {
      type: 'p',
      text: 'Needs a live check: the exact answers of a real Let’s Encrypt directory (rate-limit problem types and `Retry-After`), certificate URLs surviving past expiry (the Hub treats a 404 as “gone” and plans a new order), and Route 53 propagation timing.'
    }
  ]
}
