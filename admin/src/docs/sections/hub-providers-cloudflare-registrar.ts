import type { DocSection } from '../types.js'

// Hub third-party providers, Task 43: Cloudflare Registrar (`cloudflare.domain`) inside the
// Cloudflare adapter. Facts are from api/src/services/hub/providers/cloudflare/domain.ts.

export const hubProvidersCloudflareRegistrarDocs: DocSection = {
  id: 'hub-providers-cloudflare-registrar',
  label: 'Provider: Cloudflare Registrar',
  content: [
    {
      type: 'h1',
      id: 'hub-providers-cloudflare-registrar',
      text: 'Cloudflare Registrar — Hub mode only'
    },
    {
      type: 'warn',
      text: 'Everything on this page exists only on a Nivaro Hub (`HUB=on`). A regular install, Nivaro Cloud and a Hub shared deployment have none of it.'
    },
    {
      type: 'p',
      text: 'Domains registered at Cloudflare Registrar in a Cloudflare connection’s account are the type `cloudflare.domain` (shared scope: Hub administrators only). Cloudflare’s API reads and changes registrations but does not register or transfer domains in: register in the Cloudflare dashboard, then adopt the domain from Unmanaged. The connection test says so every time.'
    },
    {
      type: 'table',
      head: ['Field', 'What a change means'],
      rows: [
        [
          'Renew automatically',
          'Off is a downtime change: the domain then expires on its date, and everything on it with it.'
        ],
        [
          'Transfer lock',
          'Off is destructive: it lets the domain be transferred to another registrar. The Hub offers no transfer out and never reads an auth code.'
        ],
        [
          'Hide contact details',
          'Off exposes the registrant contact publicly in WHOIS / RDAP, so a Hub administrator starts it.'
        ],
        ['Expires, registrar, registrant organization and email', 'Read only.']
      ]
    },
    {
      type: 'ul',
      items: [
        'Nameservers are not offered: a Cloudflare Registrar domain uses Cloudflare’s own.',
        'The Hub never deletes a registration; stop managing it instead.',
        'Every read is under the connection’s pinned account: a domain of another account reads as gone, and a change to it is refused `CLOUDFLARE_OUT_OF_ACCOUNT`.',
        'Health carries the expiry, auto-renew and transfer lock, so the domain watch on Security warns 45 and 14 days before a registration ends.',
        'Estimate: Cloudflare sells at cost (registry and ICANN fees). The yearly renewal comes from a dated table of common TLDs; another TLD shows No estimate. Nothing is charged while auto-renew is off.',
        'The API token needs Registrar read and write permissions on the account (the test lists what is missing when the token’s permissions can be read).'
      ]
    }
  ]
}
