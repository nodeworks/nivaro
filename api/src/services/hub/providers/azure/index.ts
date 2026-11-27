import {
  graphConnectionProblems,
  isGuid,
  tenantOf,
  tenantProblem,
  tokenClaims
} from '../microsoft/graph.js'
import type { ConnectionTest, CostRow, ProviderAdapter, ProviderContext } from '../types.js'
import { ProviderError } from '../types.js'
import {
  API,
  AZURE_CONNECTION_FIELDS,
  AZURE_HOSTS,
  armCall,
  armToken,
  armVersion,
  subscriptionsOf
} from './client.js'
import { azureCosts } from './costs.js'
import { AZURE_BUNDLED, azurePriceApi } from './pricing.js'
import {
  applyAzure,
  findExistingAzure,
  healthAzure,
  listAzure,
  observeAzure,
  planAzure,
  readOutputsAzure,
  snapshotDatabase
} from './resources.js'
import { AZURE_SPECS } from './specs.js'

/**
 * Azure (`azure`, Hub third-party providers Task 39): Azure SQL and Cost Management through Azure
 * Resource Manager, signed in as an Entra app registration (client credentials, scope
 * `https://management.azure.com/.default`; `microsoft/graph.ts` helpers for the tenant and token
 * claims) with a per-connection list of allowed subscriptions. Types: azure.resource_group,
 * azure.sql_server (the `connection_string` and `server_fqdn` outputs), azure.sql_firewall_rule,
 * azure.sql_database (list-price estimate from the Azure Retail Prices API), azure.sql_private_endpoint
 * (read and adopt) and azure.budget (an alert crossing its threshold sends `cost.over_budget`).
 * `costs()` answers Cost Management rows grouped by resource id and the `nivaro-hub-app` tag for
 * Task 34's cost feed. More Azure services land in this adapter later.
 */

const PERMISSIONS = [
  { type: 'azure.resource_group', need: 'Reader on the subscription (Contributor to create)' },
  { type: 'azure.sql_server', need: 'SQL Server Contributor (Microsoft.Sql/servers/*)' },
  { type: 'azure.sql_database', need: 'SQL DB Contributor (Microsoft.Sql/servers/databases/*)' },
  { type: 'azure.budget', need: 'Cost Management Contributor (budgets)' },
  { type: '*', need: 'Cost Management Reader (cost feed)' }
]

/** The costs() method Task 34 adds to the adapter contract; typed here so this adapter builds either way. */
export type AzureAdapter = ProviderAdapter & {
  costs(ctx: ProviderContext, range: { from: string; to: string }): Promise<CostRow[]>
}

export const azureAdapter: AzureAdapter = {
  key: 'azure',
  label: 'Azure',
  connection: {
    fields: AZURE_CONNECTION_FIELDS,
    hosts: () => AZURE_HOSTS,
    describe(config) {
      const subs = subscriptionsOf(config)
      return `Azure ${tenantOf(config) || 'tenant'} · ${subs.length} subscription${subs.length === 1 ? '' : 's'}`
    },
    validate(config, secrets) {
      const problems = graphConnectionProblems(
        config,
        secrets.client_secret === undefined ? {} : { client_secret: secrets.client_secret }
      ).filter((p) => !/certificate/i.test(p))
      const t = tenantProblem(config.tenant_id)
      if (t && !problems.includes(t)) problems.push(t)
      const subs = subscriptionsOf(config)
      if (!subs.length) problems.push('List at least one subscription id.')
      if (subs.some((s) => !isGuid(s))) problems.push('Every subscription id must be a GUID.')
      return [...new Set(problems)]
    }
  },
  types: AZURE_SPECS,
  bundledPrices: AZURE_BUNDLED,
  priceApi: azurePriceApi,

  async testConnection(ctx): Promise<ConnectionTest> {
    const subs = subscriptionsOf(ctx.config)
    const fail = (message: string): ConnectionTest => ({
      ok: false,
      identity: null,
      permissions: PERMISSIONS.map((p) => ({ ...p, has: false })),
      missing: PERMISSIONS.map((p) => p.need),
      message
    })
    let token: string
    try {
      token = await armToken(ctx)
    } catch (err) {
      if (err instanceof ProviderError) return fail(ctx.scrub(err.message))
      throw err
    }
    const names: string[] = []
    let readable = 0
    for (const sub of subs) {
      const r = await armCall(ctx, 'GET', `/subscriptions/${sub}`, {
        query: armVersion(API.subscription),
        allow: [401, 403, 404]
      })
      if (r.status === 200) {
        readable++
        names.push(String(r.body?.displayName ?? sub))
      }
    }
    // Cost Management: a one-line month-to-date query on the first readable subscription.
    let cost = false
    if (subs[0]) {
      const r = await armCall(
        ctx,
        'POST',
        `/subscriptions/${subs[0]}/providers/Microsoft.CostManagement/query`,
        {
          query: armVersion(API.cost),
          body: {
            type: 'ActualCost',
            timeframe: 'MonthToDate',
            dataset: {
              granularity: 'None',
              aggregation: { totalCost: { name: 'Cost', function: 'Sum' } }
            }
          },
          allow: [401, 403, 404, 429]
        }
      )
      cost = r.status === 200 || r.status === 429
    }
    const read = readable === subs.length && subs.length > 0
    const claims = tokenClaims(token)
    const permissions = PERMISSIONS.map((p) => ({
      ...p,
      has: p.type === '*' ? cost : read
    }))
    return {
      ok: readable > 0,
      identity: `app ${String(claims.appid ?? ctx.config.client_id ?? '')} in tenant ${String(claims.tid ?? ctx.config.tenant_id ?? '')}${names.length ? ` · ${names.join(', ')}` : ''}`,
      permissions,
      missing: permissions.filter((p) => !p.has).map((p) => p.need),
      message: read
        ? 'Reading works; write roles are assumed until a change runs.'
        : `Only ${readable} of ${subs.length} subscriptions could be read.`
    }
  },

  observe: (ctx, type, externalId) => observeAzure(ctx, type, externalId),
  list: (ctx, type) => listAzure(ctx, type),
  plan: (_ctx, desired, observed) => planAzure(desired, observed),
  apply: (ctx, op, desired) => applyAzure(ctx, op, desired),
  snapshot: (ctx, type, externalId) => snapshotDatabase(ctx, type, externalId),
  health: (ctx, type, externalId) => healthAzure(ctx, type, externalId),
  findExisting: (ctx, type, desired) => findExistingAzure(ctx, type, desired),
  readOutputs: (ctx, type, externalId) => readOutputsAzure(ctx, type, externalId),
  costs: (ctx, range) => azureCosts(ctx, range)
}
