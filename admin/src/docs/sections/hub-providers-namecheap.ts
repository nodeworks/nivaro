import type { DocSection } from '../types.js'

// Hub third-party providers, Task 43: the Namecheap adapter. Facts are from
// api/src/services/hub/providers/namecheap/{client,domain,dns,pricing,index}.ts.

export const hubProvidersNamecheapDocs: DocSection = {
  id: 'hub-providers-namecheap',
  label: 'Provider: Namecheap',
  content: [
    { type: 'h1', id: 'hub-providers-namecheap', text: 'Namecheap — Hub mode only' },
    {
      type: 'warn',
      text: 'Everything on this page exists only on a Nivaro Hub (`HUB=on`). A regular install, Nivaro Cloud and a Hub shared deployment have none of it.'
    },
    {
      type: 'p',
      text: 'A Namecheap connection lets the Hub watch and manage domain registrations in one Namecheap account, and the host records of domains that use Namecheap’s own DNS. Registering or renewing a domain charges the account, so both are Hub administrator changes with their own typed confirmation.'
    },
    { type: 'h2', id: 'hub-providers-namecheap-connection', text: 'The connection' },
    {
      type: 'table',
      head: ['Field', 'What it is'],
      rows: [
        ['API user', 'The Namecheap user the API key belongs to.'],
        [
          'Account user name',
          'The account the calls act on. Empty = the API user (the usual case).'
        ],
        [
          'Hub address (IPv4)',
          'The public IPv4 address the Hub calls Namecheap from. Namecheap refuses every call from an address that is not on the account’s list (Profile → Tools → API access → Whitelisted IPs).'
        ],
        [
          'Sandbox',
          'Use `api.sandbox.namecheap.com`: a separate sandbox account where nothing is real or billed.'
        ],
        [
          'API key',
          'Sealed. Sent in the request body, never in an address, so it never lands in a proxy or access log.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Test shows who the key acts for. When Namecheap refuses the address, Test shows Namecheap’s own error (`Invalid request IP`, error 1011150) and the address Namecheap saw, so you can add exactly that one to the allow-list (it often differs from what the Hub thinks its address is behind a NAT or proxy). A wrong key or API access turned off answers `AUTH_FAILED` with where to turn it on. Namecheap limits calls (about 20 a minute); a refusal for too many requests is retried.'
    },
    { type: 'h2', id: 'hub-providers-namecheap-domain', text: 'Domains (`namecheap.domain`)' },
    {
      type: 'ul',
      items: [
        'Shared scope: only Hub administrators act on a domain. Adopt the domains the account already holds from Unmanaged.',
        'Registering: give the name, years (1–10), WHOIS privacy and one contact (used for the registrant, technical, admin and billing contact). The plan shows the price (registration now, renewal each year, from the account’s own price list when Namecheap answers it). The Hub checks availability first and never registers a name that is taken, reserved or premium-priced, nor one this account already holds (`ALREADY_EXISTS`: adopt it). A Hub administrator confirms by typing `register <domain>`.',
        '`Renew one year now` is a one-shot switch: one more year, charged now, typed confirm `renew <domain>`. A renewal that already moved the expiry date is not charged again.',
        'Transfer lock: turning it off is destructive (it lets the domain be transferred away). The Hub offers no transfer out and never reads an auth code.',
        'Nameservers: 2 to 12 host names, or empty for Namecheap’s own DNS. Changing them is a downtime change.',
        'Auto-renew is shown but read only: Namecheap’s API cannot change it. Set it in the Namecheap dashboard.',
        'The Hub never deletes a registration; stop managing it instead.',
        'Expiry, auto-renew and the transfer lock feed the domain watch on Security (warned 45 and 14 days ahead).'
      ]
    },
    {
      type: 'h2',
      id: 'hub-providers-namecheap-dns',
      text: 'Host records (`namecheap.dns_record`)'
    },
    {
      type: 'p',
      text: 'An app’s A, AAAA, CNAME, TXT or CAA record on a domain that uses Namecheap’s DNS (a domain on other nameservers is refused with `NOT_NAMECHEAP_DNS`). Namecheap replaces a domain’s whole host list on every write, so the Hub reads the list, changes the one record and writes the list back, keeping every other record and the domain’s mail setting. A record is known by host, type and value: changing the value gives it a new provider id. A record the Hub did not make with the same host, type and value is `ALREADY_EXISTS` (adopt it). MX records are not offered: they need the mail setting switched to custom MX, which stops Namecheap’s mail forwarding.'
    },
    {
      type: 'note',
      text: 'Someone editing the same domain’s records in the Namecheap dashboard at the same moment as a Hub write can lose their edit: Namecheap has no compare-and-set. Make record changes in one place.'
    },
    {
      type: 'note',
      text: 'Needs a live check (only recorded answers and the sandbox shape are tested): the exact wording of the IP refusal, `users.getPricing` field names, and `getList` paging totals.'
    }
  ]
}
