import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 2, Task 27 (Stripe). Facts are from the merged code:
// api/src/services/hub/providers/stripe/**. Nothing here ran against a live Stripe account yet
// (see the last list).

export const hubProvidersStripeDocs: DocSection = {
  id: 'hub-providers-stripe',
  label: 'Provider: Stripe',
  content: [
    { type: 'h1', id: 'hub-providers-stripe', text: 'Provider: Stripe — Hub mode only' },
    {
      type: 'p',
      text: 'Connection field: secret `apiKey`, a restricted key (`rk_…`, preferred) or a secret key (`sk_…`). Test or live mode is read from the key’s prefix; the key is the account, so the connection is the pin, and an object whose mode disagrees with the key reads as gone. The only host is `api.stripe.com`. Test reads each area (products, prices, webhook endpoints, billing portal configurations, tax rates), names the account and the mode, and lists the areas the key cannot read. A restricted key shows its write permissions only in the Stripe dashboard, so write access is checked when a change is applied. Give a restricted key write access to Products, Prices, Webhook endpoints, Customer portal and Tax rates, and nothing else.'
    },
    {
      type: 'warn',
      text: 'The Hub never moves money. It configures Stripe and nothing more: no charges, refunds, transfers, payouts, customers, invoices or subscription changes. The adapter refuses every Stripe path outside products, prices, webhook endpoints, billing portal configurations and tax rates before any request is made.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`stripe.product`',
          '`prod_…`',
          'Name, description, active. Delete archives it (active off): Stripe keeps products it has billed, and it can be restored in the dashboard.'
        ],
        [
          '`stripe.price`',
          '`price_…`',
          'Product (an adopted or managed `stripe.product`), currency, amount in the smallest unit, billing interval, nickname, lookup key, tax behavior, active. Prices are immutable: changing the product, currency, amount, interval or tax behavior is a replace. A new price is made first (taking over the lookup key), then the old one is archived, so there is no gap. Its Stripe id changes. A replace always checks the lookup key first: it takes the key over only from the price being replaced or one tagged with this resource, and stops with `ALREADY_EXISTS` when any other price (unmanaged, or another app’s) holds it. Nickname, lookup key and active change in place. Never deleted, only archived.'
        ],
        [
          '`stripe.webhook_endpoint`',
          '`we_…`',
          'An https URL, the event types it receives, a description, enabled or disabled. Output `signing_secret` (secret, once only): Stripe shows it when the endpoint is made. Bind it to a stack secret to carry it to the app. If the sealed copy is lost it cannot be read again: set "Make a new signing secret now" (`rotate_outputs`), which makes a new endpoint with the same settings, removes the old one and hands over the new secret. The old secret stops working at once. This is the one Stripe object that is really deleted.'
        ],
        [
          '`stripe.billing_portal_config`',
          '`bpc_…`',
          'Headline, privacy policy, terms and return URLs (https), and which things customers may do for themselves in the portal: see invoice history, update payment methods, update details (and which), cancel their subscription (now or at period end). Only these features are sent; other settings of the configuration are left alone. Delete archives it.'
        ],
        [
          '`stripe.tax_rate`',
          '`txr_…`',
          'Name, percentage, inclusive or exclusive, jurisdiction, country, state, tax type, active. Percentage and inclusive are immutable, so changing them is a replace (new rate, old one archived). Delete archives it.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-providers-stripe-gates', text: 'Who may change what' },
    {
      type: 'ul',
      items: [
        'Test mode (`…_test_…` key): owners of the app may plan and apply changes through connections on the app’s allowed list.',
        'Live mode (`…_live_…` key): every change needs a Hub administrator, whatever the change. The plan shows "a Hub administrator must start this change". A key whose mode the Hub cannot read is treated as live.',
        'Archiving a product, price, tax rate or portal configuration, replacing a price or tax rate, rotating a signing secret, deleting an endpoint and disabling an endpoint are `downtime`: a typed confirm in a production environment.',
        'Stripe has no cost class here: Stripe charges per transaction, not for these objects, so there is no estimate.'
      ]
    },
    { type: 'h2', id: 'hub-providers-stripe-safety', text: 'Safety rules the adapter keeps' },
    {
      type: 'ul',
      items: [
        'Creating over a product, tax rate, endpoint or lookup key the Hub did not make stops with `ALREADY_EXISTS` ("adopt it instead"); the Hub never edits something it did not create. A resumed run finds its own object by the `nivaro-hub:resource` metadata tag.',
        'Creates carry an idempotency key, so a retry after a network failure cannot make a second object.',
        'The Hub’s tags (`nivaro-hub:app`, `nivaro-hub:env`, `nivaro-hub:resource`) are kept in the object’s metadata.',
        'Stripe error text is scrubbed of the key and of anything shaped like a Stripe secret before it is shortened, so a key can never survive in a cut message.',
        'A step whose Stripe id differs from the resource it runs on is refused (`TARGET_MISMATCH`).'
      ]
    },
    {
      type: 'h2',
      id: 'hub-providers-stripe-not-verified',
      text: 'Not verified against live Stripe'
    },
    {
      type: 'ul',
      items: [
        'All behavior is tested against recorded answers with fake ids and keys; no live or test-mode Stripe account was called.',
        'The Hub has no resource type that creates keys (Stripe has no API call for restricted keys, and a ruling keeps it that way): the restricted key stays the connection credential. A person makes it in the dashboard and adds it to the connection.',
        'Adopting an existing endpoint cannot recover its signing secret: rotate it, or paste the secret into the stack secret by hand.',
        'The Stripe API version is pinned to `2024-06-20`; a newer one is not tried.'
      ]
    }
  ]
}
