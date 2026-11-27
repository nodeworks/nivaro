import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 2: SendGrid. Facts are from the adapter code:
// api/src/services/hub/providers/sendgrid/**. Nothing here ran against a live SendGrid account yet.

export const hubProvidersSendgridDocs: DocSection = {
  id: 'hub-providers-sendgrid',
  label: 'Provider: SendGrid',
  content: [
    { type: 'h1', id: 'hub-providers-sendgrid', text: 'Provider: SendGrid — Hub mode only' },
    {
      type: 'p',
      text: 'One secret connection field, `apiKey` (a SendGrid API key with full access; the Hub makes narrower keys for each app). The only host is `api.sendgrid.com`. SendGrid has no account id to pin: the key is the account, so every call goes through that one key. Test reads the key’s permissions and probes the domain, sender and IP-access lists, and says which of those the key lacks.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`sendgrid.api_key`',
          '`<api key id>`',
          'A key limited to `mail.send`. SendGrid shows the value once, so it is the output `api_key` (secret, once-only). `smtp_host` (`smtp.sendgrid.net`), `smtp_port` (`587`) and `smtp_user` (`apikey`) come out beside it, so bindings can fill the app’s SMTP settings (`smtp_host`, `smtp_port`, `smtp_user`, `smtp_pass`) without anyone copying anything. **Make a new key** (`rotate_outputs`) creates a NEW key and hands out its value; the old key stays valid until it is deleted, so a running app keeps sending until the new value is applied. Delete is `destructive`, and the key the connection itself uses is never deleted from here (`CONNECTION_KEY`). Adopting a key gives no value: rotate it to get one.'
        ],
        [
          '`sendgrid.sender`',
          '`<sender id>`',
          'A verified single sender: nickname, From address (a new address is a replace), names, reply-to (blank means the From address) and the postal address SendGrid requires. SendGrid emails a link to the From address; the sender cannot send until someone clicks it (**Send the verification email again** is a one-shot op). Output `smtp_from`. Delete and replace are `destructive`. This is the type that **sends Hub events**: a notify route may name it.'
        ],
        [
          '`sendgrid.domain_authentication`',
          '`<domain id>`',
          'Shared (Hub administrators). Domain, link subdomain (default `em`) and automated security are set at create; a change is a replace. **Default** is the only field changed in place. SendGrid’s CNAME records come out as the output `dns_records` (a JSON list of `{key, type, host, data}`), re-readable at any time. Optional ref lists `cloudflare_records` and `route53_records` point at the DNS records the plan makes beside it. **Validate DNS now** asks SendGrid to check them; DNS that is not visible yet fails the step as retryable (`NOT_VALID_YET`) naming the failing records. Delete and replace are `destructive` + `downtime`.'
        ],
        [
          '`sendgrid.ip_access`',
          '`<rule id>`',
          'Shared, read only: the IP access list, for adoption and drift. Every write is refused (`READ_ONLY`).'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Notify: a notify route sends through a verified sender. Each address on the sender’s **Hub messages go to** list gets its own copy (recipients do not see each other), From the verified address, with `[Critical]` or `[Warning]` in the subject. A sender that is not verified yet, has no recipients or is gone at SendGrid fails the send with a plain reason; a 429 is retryable. The recipient list is kept in the Hub, not at SendGrid, and is checked (emails only, at most 50) when a plan is made.',
        'A create that finds a key with the same name, a sender for the same address or a domain authentication for the same domain and subdomain the Hub did not make stops with `ALREADY_EXISTS`: adopt it instead. A resumed run reuses what it made; a key whose value was already shown is never re-read.',
        'Errors that echo any part of the API key are masked. Ids that reach a URL path are checked first (`BAD_ID`).',
        'No type is priced per resource (SendGrid bills the account’s plan), so none has an estimate.',
        'Needs a live check: the verified-sender and domain-authentication payloads against a real account, the permission names Test reports, and that a sender change of only the recipient list needs another change in the same plan to be saved (the list is not read back from SendGrid).'
      ]
    }
  ]
}
