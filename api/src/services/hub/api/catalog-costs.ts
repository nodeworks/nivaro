import type { HubField, HubRoute } from './catalog.js'

/**
 * Catalog entries for live costs and estimates (Task 44a): the estimate reads in
 * routes/hub-providers.ts and routes/hub-placement.ts, the live figures, budgets and the Hub-wide
 * auto-approve limit. Kept beside catalog.ts so its list stays one spread line.
 */

const s = (description: string, extra: Partial<HubField> = {}): HubField => ({
  type: 'string',
  description,
  ...extra
})
const n = (description: string, extra: Partial<HubField> = {}): HubField => ({
  type: 'integer',
  description,
  ...extra
})
const o = (description: string): HubField => ({ type: 'object', description })
const b = (description: string): HubField => ({ type: 'boolean', description })
const list = (items: HubField['items'], description: string): HubField => ({
  type: 'array',
  items,
  description
})

const r = (
  method: HubRoute['method'],
  path: string,
  auth: HubRoute['auth'],
  access: HubRoute['access'],
  summary: string,
  extra: Partial<HubRoute> = {}
): HubRoute => ({ method, path, group: 'Costs', auth, access, summary, ...extra })

const ESTIMATE_NOTE =
  'A read: no plan is saved and no audit row is written; works during maintenance. Amounts are in cents, list prices, with basis, confidence, lines and the price date. An unknown price answers confidence unknown ("No estimate"), never an error.'

export const COST_ROUTES: HubRoute[] = [
  r('POST', '/providers/estimate', 'owner', 'plan', 'Estimate one provider resource', {
    notes: `${ESTIMATE_NOTE} Judged like a plan (the app's allowed connections, shared scope admins only). Tax and discount are separate lines.`,
    body: {
      connection_id: n('The connection', { required: true }),
      type: s('The resource type key (required without resource_id)'),
      desired: o('The form’s field values (secrets are never needed)'),
      resource_id: n('An existing managed resource (answers before → after)'),
      app_id: n('The app (scope app)'),
      environment_id: n('The environment of the app'),
      egress_gb_month: n('Expected data out, GB a month (absent = what the Hub measured)'),
      delete: b('Estimate deleting resource_id (the saving)')
    }
  }),
  r(
    'POST',
    '/environments/:envId/stack/estimate',
    'owner',
    'plan',
    'Estimate an environment’s Docker stack at the chargeback rates',
    {
      notes: `${ESTIMATE_NOTE} Answers {before, after, deltaMonthlyCents}.`,
      body: {
        size: s('small, medium or large', { enum: ['small', 'medium', 'large'] }),
        replicas: o('{role: count} laid over the size template'),
        settings: o('The stack settings form (does not change the figure today)')
      }
    }
  ),
  r('POST', '/apps/create/estimate', 'admin', 'plan', 'Estimate a new app before creating it', {
    notes: `${ESTIMATE_NOTE} Takes the Create app body; answers per environment its stack and provider parts.`,
    body: {
      target: o('As for /apps/create'),
      environments: list('object', 'As for /apps/create')
    }
  }),
  r('GET', '/costs/live', 'owner', 'read', 'Run-rate now, month to date, forecast and billed', {
    notes:
      'Owners see their own apps only. Billed comes from provider cost feeds through the last date a provider reported; the gap is the billed amount against the estimate over the same days.',
    query: {
      app_id: s('Only this app'),
      environment_id: s('Only this environment')
    }
  }),
  r('GET', '/apps/:id/cost-budget', 'owner', 'read', 'An app’s monthly budget'),
  r('PUT', '/apps/:id/cost-budget', 'admin', 'write', 'Set an app’s monthly budget', {
    notes:
      'The forecast alerts at 80 % and 100 % once per threshold per month. auto_approve_under_cents overrides the Hub-wide limit for this app (null = the Hub-wide one).',
    body: {
      monthly_cents: n('Monthly budget in cents (0 = none)', { required: true }),
      auto_approve_under_cents: n('Owner changes under this skip approval (null = Hub-wide)')
    }
  }),
  r('GET', '/costs/settings', 'owner', 'read', 'The Hub-wide auto-approve limit'),
  r('PUT', '/costs/settings', 'admin', 'write', 'Set the Hub-wide auto-approve limit', {
    notes:
      'An owner’s costed change whose monthly increase and one-time total are both under it runs without approval; 0 = every costed change waits. An unknown estimate never auto-approves.',
    body: { cost_auto_approve_under_cents: n('Cents (0 = never auto-approve)') }
  })
]
