import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 3: Mailgun. Facts are from the adapter code:
// api/src/services/hub/providers/mailgun/**. Nothing here ran against a live Mailgun account yet.

export const hubProvidersMailgunDocs: DocSection = {
  id: 'hub-providers-mailgun',
  label: 'Provider: Mailgun',
  content: [
    { type: 'h1', id: 'hub-providers-mailgun', text: 'Provider: Mailgun — Hub mode only' },
    {
      type: 'p',
      text: 'Two connection fields: `region` (US or EU) and the secret `apiKey` (a Mailgun account key; the Hub makes narrower domain-scoped sending keys for each app). The only host is `api.mailgun.net` for US or `api.eu.mailgun.net` for EU: a US key does not work on the EU host and the other way round, so pick the region the account lives in. Mailgun has no account id to pin: the key is the account. Test reads the domain list and probes the sending-key API, and says which of those the key lacks.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`mailgun.domain`',
          '`<domain name>`',
          'Shared (Hub administrators). A sending domain, usually a subdomain such as `mg.example.com`. The domain name and DKIM key size are set at create; a different name is a replace. Tracking-link scheme, spam handling and subdomain acceptance change in place. Mailgun’s DNS records come out as the output `dns_records` (a JSON list of `{type, name, value, valid}`), re-readable at any time, never part of the plan. Optional ref lists `cloudflare_records` and `route53_records` point at the DNS records the plan makes beside it. **Verify DNS now** (`verify`) asks Mailgun to check them; DNS that is not visible yet fails the step as retryable (`NOT_VALID_YET`) naming the failing records. Delete and replace are `destructive` + `downtime`: its SMTP logins, webhooks and sending keys go with it. This is the type that **sends Hub events**.'
        ],
        [
          '`mailgun.smtp_credential`',
          '`<domain>:<login>`',
          'An SMTP login on a domain. The Hub makes a random password; Mailgun never shows it again, so it is the output `smtp_pass` (secret, once-only). `smtp_host` (`smtp.mailgun.org`, or `smtp.eu.mailgun.org` for an EU connection), `smtp_port` (`587`) and `smtp_user` (`<login>@<domain>`) come out beside it, so bindings fill the app’s SMTP settings (`smtp_host`, `smtp_port`, `smtp_user`, `smtp_pass`; the password is a credential setting) without anyone copying anything. **Make a new password** (`rotate_outputs`) resets the password at Mailgun: the old password stops working at once, so it is flagged `downtime` and the app cannot send until the new value is applied. Delete is `destructive`. Adopting a login gives no password: rotate it to get one.'
        ],
        [
          '`mailgun.webhook`',
          '`<domain>:<event>`',
          'One https address for one event (`accepted`, `delivered`, `opened`, `clicked`, `complained`, `unsubscribed`, `temporary_fail`, `permanent_fail`) on a domain. Event data names recipients, so creating one or changing where it goes is flagged `public_exposure` (Hub administrators only). The Hub manages one address per event: when Mailgun holds other addresses for the event, a change or delete is refused (`HAS_OTHER_URLS`) rather than replacing them.'
        ],
        [
          '`mailgun.sending_key`',
          '`<key id>`',
          'A key that can only send through one domain. Mailgun shows the value once, so it is the output `api_key` (secret, once-only). **Make a new key** creates a NEW key for the same domain the existing key is scoped to and hands out its value; the old key stays valid until it is deleted. A key cannot be renamed: a new description is a replace. Delete is `destructive`. Making sending keys needs a primary account key.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Notify: a notify route sends through a verified domain. Each address on the domain’s **Hub messages go to** list gets its own copy (Mailgun’s recipient variables stop recipients seeing each other), From `<Hub messages come from>@<domain>` (default `nivaro-hub`), with `[Critical]` or `[Warning]` in the subject. A domain that is not active yet, has no recipients or is gone fails the send with a plain reason; a 429 is retryable. The recipient list is kept in the Hub, not at Mailgun, and is checked (emails only, at most 50) when a plan is made. Changing who gets Hub mail is a Hub-administrator step; it saves in the Hub and writes nothing to Mailgun.',
        'A create that finds a domain, SMTP login, webhook event or sending key with the same identity the Hub did not make stops with `ALREADY_EXISTS`: adopt it instead. A resumed run reuses what it made; a password or key that was already shown is never re-read.',
        'Errors that echo the API key, its basic-auth form or a password the Hub generated are masked before they are clipped. Names and ids that reach a URL path are checked first (`BAD_ID`).',
        'Nothing is priced per resource (Mailgun bills the account’s plan), so no type has an estimate.',
        'Needs a live check: the sending-key list filters (`kind`, `domain_name`), the credential path using the login’s local part, the batch send with recipient variables, and the EU SMTP host name.'
      ]
    }
  ]
}
