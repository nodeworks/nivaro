import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 3 framework (Task 34): the provider cost feed and the registrar
// domain watch. Facts are from api/src/services/hub/providers/{costs,domains}.ts, migration
// 586_hub_provider_costs.ts, routes/hub-placement.ts (/costs/outside, /chargeback.csv) and
// routes/hub-security.ts (/security/certificates). No provider ships a cost feed or a registrar
// type yet; the adapters that do (AWS Cost Explorer, Azure Cost Management, Anthropic, OpenAI,
// Route 53 Domains, Cloudflare Registrar, Namecheap) come in later tasks.

export const hubProvidersCostsFeedDocs: DocSection = {
  id: 'hub-providers-costs-feed',
  label: 'Outside spend and domain expiry',
  content: [
    {
      type: 'h1',
      id: 'hub-providers-costs-feed',
      text: 'Outside spend and domain expiry — Hub mode only'
    },
    {
      type: 'warn',
      text: 'Everything on this page exists only on a Nivaro Hub (`HUB=on`). A regular install, Nivaro Cloud and a Hub shared deployment have none of it.'
    },
    {
      type: 'p',
      text: 'The Hub’s own cost figures are estimates: list prices and the chargeback rates you set. Outside spend is the other half: what the providers actually billed, read from their own cost reports. Domains registered through a registrar connection are watched for expiry beside the TLS certificates.'
    },
    { type: 'h2', id: 'hub-providers-costs-feed-feed', text: 'The cost feed' },
    {
      type: 'p',
      text: 'Once a day at 06:10 UTC (job `hub-provider-costs`, one Hub process at a time, only where scheduled jobs tick) the Hub asks every connection whose provider has a cost feed what it billed per day. The first read of a connection goes back 365 days; later reads go back 35 days, because providers revise recent days and close the previous month late. A disabled connection is skipped.'
    },
    {
      type: 'ul',
      items: [
        'Each billed row is matched to an app: first by the managed resource whose provider id the row names (a resource the Hub has since deleted still counts), then by the `nivaro-hub:app` tag the Hub puts on what it creates. A row with neither is kept as unassigned, never dropped. A managed resource of shared scope counts as shared resources.',
        'A re-read replaces the days the provider answered for, it never adds to them: reading the same day twice leaves one figure. Days the provider did not answer for this time are kept.',
        'A row with a bad date, amount or currency, or a date outside the asked range, is skipped and counted.',
        'Each row keeps its record type (usage, tax, credit, discount or refund). The price book learns the tax and discount rates it puts on estimates from these rows, over the last three billed months.',
        'One connection that fails or is slow (two minutes at most) never stops the others. Its error, with the connection’s secrets masked, shows under Outside spend and the Hub tries again the next day.',
        'Rows are kept 400 days (table `nivaro_hub_provider_costs`). They are figures, service names and record types only, never a provider’s raw answer.'
      ]
    },
    { type: 'h2', id: 'hub-providers-costs-feed-outside', text: 'Outside spend on the Costs page' },
    {
      type: 'p',
      text: 'The Costs tab (`/hub/costs`, administrators) shows Outside spend under the per-app table: per app and provider, the month to date and the last 12 calendar months (this month included), then shared resources and spend not assigned to any app, with a total per currency. Under it each cost feed says how far its bill goes ("Billed through …") and how its last read went. Export CSV ends with the same rows as an Outside spend section; amounts there are plain numbers, so a credit stays a negative number.'
    },
    {
      type: 'table',
      head: ['Route', 'Who', 'What'],
      rows: [
        [
          '`GET /api/hub/costs/outside`',
          'Admin',
          'Rows per app (or shared / unassigned), provider and currency: `month_to_date_cents`, `last_12_months_cents`, `months_cents` (12 months, oldest first), totals per currency and every feed’s `through`, `last_read_at`, `ok`, `error`.'
        ],
        [
          '`GET /api/hub/chargeback.csv`',
          'Admin',
          'The Hub’s estimate per environment, then the Outside spend section when any feed has rows.'
        ],
        [
          '`GET /api/hub/costs/live`',
          'Owner',
          '`billed` (month to date and the last billed day) now comes from this feed.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-providers-costs-feed-classes', text: 'Yearly and one-time costs' },
    {
      type: 'p',
      text: 'A resource type says how it bills: none, monthly, yearly (a domain) or one time. Any class but none adds the `cost` risk to a create or replace, so an owner’s change waits for a Hub administrator’s approval (`pending_approval`) unless the auto-approve limit covers it. An estimate’s yearly amount must also be under that limit.'
    },
    { type: 'h2', id: 'hub-providers-costs-feed-domains', text: 'Domain expiry' },
    {
      type: 'p',
      text: 'A registrar domain the Hub manages reports when its registration ends, whether it renews by itself and whether the transfer lock is on. The Security tab (`/hub/security`) lists the domains under Certificates and names, and the change calendar shows each end date. The check runs with the certificate watch: every 6 hours when the watch is on, and on Check now.'
    },
    {
      type: 'ul',
      items: [
        'App owners and Hub administrators are warned in the Hub, and the `domain.expiring` notify event goes out through notify routes, once per threshold: 45 days before, 14 days before and when it has expired. A domain that renews by itself skips the 45-day warning; a renewal that did not happen still warns at 14 days.',
        'A renewed domain (more than 45 days left again) starts the thresholds over.',
        'A registrar that does not answer, or answers no date, shows the domain as Could not read; nothing is sent.',
        'A domain the Hub stops managing leaves the list and the calendar (table `nivaro_hub_domain_checks`).'
      ]
    },
    {
      type: 'note',
      text: 'For adapter authors: a provider adds a cost feed with `costs(ctx, {from, to})` answering `CostRow[]` (date, amountCents, currency, and where known externalId, appTag, service, recordType). A registrar type sets `registrar: true`, and its `health` answers `details.expiresAt`, `autoRenew` and `locked`.'
    }
  ]
}
