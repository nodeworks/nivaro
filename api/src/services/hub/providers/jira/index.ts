import {
  type ConnectionTest,
  type HealthAnswer,
  type ProviderAdapter,
  type ProviderContext,
  ProviderError
} from '../types.js'
import {
  configProblems,
  hostsOf,
  JIRA_MODES,
  jiraCall,
  modeOf,
  projectKeysOf,
  safe,
  siteUrl
} from './client.js'
import {
  createRule,
  deleteRule,
  notifyRule,
  observeRuleOrNull,
  planRule,
  ruleHealth,
  updateRule
} from './notify.js'
import {
  applyResource,
  findExistingResource,
  listResources,
  observeResource,
  planComponent,
  planVersion,
  planWebhook
} from './resources.js'
import { COMPONENT, JIRA_TYPES, PROJECT, RULE, VERSION, WEBHOOK } from './specs.js'

/**
 * Jira (`jira`): Jira Cloud (email + API token, or an OAuth 2.0 client-credentials service
 * account) or Data Center (personal access token). Types: `jira.project` (shared, read and
 * adopt), `jira.component` (one per app), `jira.version` (named op `release` through the
 * `release` trigger), `jira.webhook` (Data Center only, secret sealed) and `jira.issue_link_rule`
 * (Hub-side: the project, issue type and component Hub events become issues in; the only
 * sender). Optional `project_keys` limits the connection to some projects on every read and write.
 */

const NEEDS: Array<{ type: string; need: string; permission: string; global?: boolean }> = [
  { type: PROJECT, need: 'Browse projects', permission: 'BROWSE_PROJECTS' },
  { type: COMPONENT, need: 'Administer projects', permission: 'ADMINISTER_PROJECTS' },
  { type: VERSION, need: 'Administer projects', permission: 'ADMINISTER_PROJECTS' },
  { type: RULE, need: 'Create issues', permission: 'CREATE_ISSUES' },
  { type: RULE, need: 'Add comments', permission: 'ADD_COMMENTS' },
  { type: RULE, need: 'Transition issues', permission: 'TRANSITION_ISSUES' },
  { type: WEBHOOK, need: 'Jira administrator (webhooks)', permission: 'ADMINISTER', global: true }
]

function failedTest(ctx: ProviderContext, message: string): ConnectionTest {
  const needs = needList(ctx)
  return {
    ok: false,
    identity: null,
    permissions: needs.map((n) => ({ type: n.type, need: n.need, has: false })),
    missing: needs.map((n) => n.need),
    message: safe(ctx, message)
  }
}

function needList(ctx: ProviderContext) {
  return NEEDS.filter((n) => n.type !== WEBHOOK || modeOf(ctx.config) === 'datacenter_pat')
}

export const jiraAdapter: ProviderAdapter = {
  key: 'jira',
  label: 'Jira',
  connection: {
    fields: [
      {
        key: 'mode',
        label: 'Sign-in',
        kind: 'enum',
        required: true,
        default: 'cloud_token',
        options: JIRA_MODES.map((m) => ({
          value: m,
          label:
            m === 'cloud_token'
              ? 'Jira Cloud: email + API token'
              : m === 'cloud_oauth'
                ? 'Jira Cloud: OAuth service account'
                : 'Jira Data Center: personal access token'
        }))
      },
      {
        key: 'base_url',
        label: 'Jira address',
        kind: 'string',
        placeholder: 'https://acme.atlassian.net',
        help: 'Cloud: your https://<site>.atlassian.net address. Data Center: your https base address (a private address needs SSRF_ALLOW_HOSTS on the Hub).'
      },
      {
        key: 'email',
        label: 'Account email',
        kind: 'string',
        help: 'Cloud with an API token only.'
      },
      {
        key: 'api_token',
        label: 'API token',
        kind: 'string',
        secret: true,
        help: 'Jira Cloud: id.atlassian.com → Security → API tokens.'
      },
      {
        key: 'cloud_id',
        label: 'Cloud id',
        kind: 'string',
        help: 'OAuth service account only: the site’s cloud id (a UUID).'
      },
      { key: 'client_id', label: 'Client id', kind: 'string', help: 'OAuth service account only.' },
      {
        key: 'client_secret',
        label: 'Client secret',
        kind: 'string',
        secret: true,
        help: 'OAuth service account only.'
      },
      {
        key: 'pat',
        label: 'Personal access token',
        kind: 'string',
        secret: true,
        help: 'Data Center only (a Bearer token).'
      },
      {
        key: 'project_keys',
        label: 'Only these projects',
        kind: 'list',
        help: 'Optional. When set, the Hub reads and changes only these project keys.'
      }
    ],
    hosts: (config) => hostsOf(config),
    describe(config) {
      const mode = modeOf(config)
      const where =
        mode === 'cloud_oauth'
          ? `Cloud ${String(config.cloud_id ?? '').slice(0, 8)}…`
          : (siteUrl(config) ?? 'unknown address')
      const keys = projectKeysOf(config)
      return `Jira ${where}${keys.length ? ` · ${keys.join(', ')}` : ''}`
    },
    validate: (config, secrets) => configProblems(config, secrets)
  },
  types: JIRA_TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    let who: any
    try {
      who = (await jiraCall(ctx, 'GET', '/myself')).body
    } catch (err) {
      if (err instanceof ProviderError) return failedTest(ctx, err.message)
      throw err
    }
    const identity = String(who?.displayName ?? who?.name ?? who?.emailAddress ?? 'signed in')
    const have = new Map<string, boolean>()
    let message: string | undefined
    try {
      const keys = projectKeysOf(ctx.config)
      let project = keys[0] ?? null
      if (!project) {
        const list = await listResources(ctx, PROJECT, null)
        project = list.items[0]?.externalId ?? null
      }
      const ask = async (permissions: string[], projectKey: string | null) => {
        const r = await jiraCall(ctx, 'GET', '/mypermissions', {
          query: { permissions: permissions.join(','), ...(projectKey ? { projectKey } : {}) }
        })
        const got = (r.body?.permissions ?? {}) as Record<string, { havePermission?: boolean }>
        for (const p of permissions) have.set(p, got[p]?.havePermission === true)
      }
      const projectPerms = [...new Set(NEEDS.filter((n) => !n.global).map((n) => n.permission))]
      if (project) await ask(projectPerms, project)
      else
        message = 'Jira shows this account no project, so project permissions could not be checked.'
      if (modeOf(ctx.config) === 'datacenter_pat') await ask(['ADMINISTER'], null)
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err
      message = safe(ctx, `Permissions could not be read: ${err.message}`)
    }
    const needs = needList(ctx)
    const permissions = needs.map((n) => ({
      type: n.type,
      need: n.need,
      has: have.get(n.permission) === true
    }))
    return {
      ok: true,
      identity,
      permissions,
      missing: permissions.filter((p) => !p.has).map((p) => p.need),
      ...(message ? { message } : {})
    }
  },

  async observe(ctx, type, externalId) {
    if (type === RULE) return observeRuleOrNull(ctx, externalId)
    return observeResource(ctx, type, externalId)
  },

  async list(ctx, type, cursor) {
    if (type === RULE) return { items: [], cursor: null }
    return listResources(ctx, type, cursor ?? null)
  },

  async findExisting(ctx, type, desired) {
    return findExistingResource(ctx, type, desired)
  },

  plan(ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    if (type === PROJECT) return []
    if (type === COMPONENT) return planComponent(desired, observed)
    if (type === VERSION) return planVersion(desired, observed)
    if (type === WEBHOOK) return planWebhook(ctx, desired, observed)
    if (type === RULE) return planRule(desired, observed)
    throw new ProviderError('UNKNOWN_TYPE', `Jira has no ${String(type)}.`)
  },

  async apply(ctx, op, desired) {
    if (op.type === PROJECT)
      throw new ProviderError('CAPABILITY_MISSING', 'A Jira project can be adopted, not changed.')
    if (op.type === RULE) {
      if (op.kind === 'noop') return { ok: true, externalId: op.externalId, observed: null }
      if (op.kind === 'delete') return deleteRule(op.externalId)
      if (!desired) throw new ProviderError('INVALID_FIELDS', 'This change has no desired state.')
      if (op.kind === 'create') return createRule(ctx, desired)
      if (!op.externalId) throw new ProviderError('BAD_ID', 'An update needs a rule id.')
      return updateRule(ctx, op.externalId, desired)
    }
    return applyResource(ctx, op, desired)
  },

  async notify(ctx, resource, msg) {
    if (resource.type !== RULE)
      return {
        ok: false,
        externalId: resource.external_id,
        observed: null,
        error: {
          code: 'NOT_A_SENDER',
          message: 'Only a Jira issue rule opens issues.',
          retryable: false
        }
      }
    return notifyRule(ctx, resource, msg)
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    if (type === RULE) return ruleHealth(ctx, externalId)
    const seen = await observeResource(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone at Jira.', checkedAt }
    if (seen.status === 'archived') return { status: 'warn', message: 'It is archived.', checkedAt }
    return { status: 'ok', checkedAt }
  }
}
