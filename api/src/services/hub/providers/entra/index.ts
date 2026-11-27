import {
  GRAPH_CONNECTION_FIELDS,
  GRAPH_HOSTS,
  graph,
  graphConnectionProblems,
  graphToken,
  mintGraphToken,
  tenantOf,
  tenantProblem,
  tokenClaims,
  tokenRoles
} from '../microsoft/graph.js'
import type {
  ConnectionTest,
  DesiredResource,
  HealthAnswer,
  Observed,
  OpResult,
  ProviderAdapter,
  ProviderContext
} from '../types.js'
import { ProviderError } from '../types.js'
import {
  consentUrl,
  createApp,
  createPerm,
  createRole,
  deleteApp,
  deletePerm,
  deleteRole,
  findPerm,
  findRole,
  getApplication,
  listApps,
  listPerms,
  listRoles,
  observedApp,
  observePerm,
  observeRole,
  planApp,
  planPerm,
  planRole,
  readAppOutputs,
  updateApp,
  updatePerm,
  updateRole
} from './application.js'
import {
  createAssignment,
  createSp,
  deleteAssignment,
  deleteSp,
  findAssignment,
  findSp,
  listAssignments,
  listGroups,
  listSps,
  observeAssignment,
  observeGroup,
  observeSpById,
  planAssignment,
  planGroup,
  planSp,
  updateSp
} from './principals.js'
import {
  applySecret,
  findSecret,
  listSecrets,
  observeSecret,
  planSecret,
  secretHealth
} from './secret.js'
import { arr, asObj, str } from './shared.js'
import { APP, ASSIGN, ENTRA_TYPES, GROUP, PERM, ROLE, SECRET, SP } from './specs.js'

/**
 * Microsoft Entra ID provider (Hub third-party providers, Task 14). Microsoft Graph with the
 * client-credentials grant (tenant, client id, sealed secret or certificate key). Types:
 * entra.app_registration, entra.client_secret (shown once: the `client_secret` output),
 * entra.service_principal, entra.app_role, entra.group_role_assignment, entra.api_permission, and
 * entra.group (shared, read and adopt only). Nothing here reads credentials back: an app
 * registration is read with an explicit `$select`, a secret is only its id, name and dates.
 * The connection's own app registration is never written (`SELF_APP`).
 */

const ALL_PERMS = 'Application.ReadWrite.All'
const OWNED_PERM = 'Application.ReadWrite.OwnedBy'
const ASSIGN_PERM = 'AppRoleAssignment.ReadWrite.All'
const GROUP_PERM = 'Group.Read.All'

/** What each type needs; `any` = either permission is enough (All is the broader one). */
const NEEDS: Array<{ type: string; any: string[] }> = [
  { type: APP, any: [OWNED_PERM, ALL_PERMS] },
  { type: SECRET, any: [OWNED_PERM, ALL_PERMS] },
  { type: SP, any: [OWNED_PERM, ALL_PERMS] },
  { type: ROLE, any: [OWNED_PERM, ALL_PERMS] },
  { type: PERM, any: [OWNED_PERM, ALL_PERMS] },
  { type: ASSIGN, any: [ASSIGN_PERM] },
  { type: GROUP, any: [GROUP_PERM] }
]

function unknownType(type: string): ProviderError {
  return new ProviderError('UNKNOWN_TYPE', `Entra has no resource type ${type}.`)
}

function bad(message: string): ProviderError {
  return new ProviderError('INVALID', message)
}

async function applyApp(
  ctx: ProviderContext,
  op: { kind: string; externalId: string | null },
  desired: DesiredResource | null
): Promise<OpResult> {
  switch (op.kind) {
    case 'noop': {
      const raw = op.externalId ? await getApplication(ctx, op.externalId) : null
      return {
        ok: true,
        externalId: op.externalId,
        observed: raw ? observedApp(raw) : null,
        answer: { status: 200 }
      }
    }
    case 'create':
      if (!desired) throw bad('A create needs the wanted values.')
      return createApp(ctx, desired)
    case 'update':
      if (!desired || !op.externalId) throw bad('An update needs a resource.')
      return updateApp(ctx, op.externalId, desired)
    case 'delete':
      if (!op.externalId) throw bad('A delete needs a resource id.')
      return deleteApp(ctx, op.externalId)
    default:
      throw bad(`Unknown operation ${String(op.kind)}.`)
  }
}

type Maker = (ctx: ProviderContext, desired: DesiredResource) => Promise<OpResult>
type Editor = (
  ctx: ProviderContext,
  externalId: string,
  desired: DesiredResource
) => Promise<OpResult>
type Remover = (ctx: ProviderContext, externalId: string) => Promise<OpResult>
type Reader = (ctx: ProviderContext, externalId: string) => Promise<Observed | null>

/** Create / update / delete of a type, with replace = delete then create. */
async function applyGeneric(
  ctx: ProviderContext,
  op: { kind: string; externalId: string | null },
  desired: DesiredResource | null,
  fns: { create: Maker; update?: Editor; remove: Remover; read: Reader }
): Promise<OpResult> {
  switch (op.kind) {
    case 'noop': {
      const seen = op.externalId ? await fns.read(ctx, op.externalId) : null
      return { ok: true, externalId: op.externalId, observed: seen, answer: { status: 200 } }
    }
    case 'create':
      if (!desired) throw bad('A create needs the wanted values.')
      return fns.create(ctx, desired)
    case 'update':
      if (!desired || !op.externalId) throw bad('An update needs a resource.')
      if (!fns.update) throw bad('This resource is made or removed, not edited.')
      return fns.update(ctx, op.externalId, desired)
    case 'delete':
      if (!op.externalId) throw bad('A delete needs a resource id.')
      return fns.remove(ctx, op.externalId)
    case 'replace':
      if (!desired || !op.externalId) throw bad('A replace needs a resource.')
      await fns.remove(ctx, op.externalId)
      return fns.create(ctx, { ...desired, externalId: null })
    default:
      throw bad(`Unknown operation ${String(op.kind)}.`)
  }
}

async function permissionsHealth(ctx: ProviderContext, externalId: string): Promise<HealthAnswer> {
  const checkedAt = ctx.now().toISOString()
  const seen = await observePerm(ctx, externalId)
  if (!seen)
    return { status: 'down', message: 'The permission request is gone in Entra.', checkedAt }
  const appObject = String(seen.fields.application ?? '')
  const resource = String(seen.fields.resource_app_id ?? '')
  const wanted = (Array.isArray(seen.fields.permissions) ? seen.fields.permissions : []).map((p) =>
    asObj(p)
  )
  const app = await getApplication(ctx, appObject)
  const appId = str(app?.appId)
  const url = appId ? consentUrl(ctx, appId) : null
  const needed = `Consent needed${url ? `: an administrator opens ${url}` : ''}.`
  if (!appId || !wanted.length) return { status: 'ok', checkedAt }
  // The app's own enterprise application and the API's: consent lives between the two.
  const own = await graph(ctx, 'GET', '/servicePrincipals', {
    query: { $select: 'id', $filter: `appId eq '${appId}'` }
  })
  const ownId = str(arr(asObj(own.body).value)[0]?.id)
  if (!ownId) return { status: 'warn', message: needed, checkedAt, details: { consent: 'needed' } }
  const api = await graph(ctx, 'GET', '/servicePrincipals', {
    query: {
      $select: 'id,appRoles,oauth2PermissionScopes',
      $filter: `appId eq '${resource.replace(/'/g, "''")}'`
    }
  })
  const apiSp = asObj(arr(asObj(api.body).value)[0])
  const apiId = str(apiSp.id)
  if (!apiId) return { status: 'warn', message: needed, checkedAt, details: { consent: 'needed' } }
  const granted = new Set<string>()
  const roleRows = await graph(ctx, 'GET', `/servicePrincipals/${ownId}/appRoleAssignments`, {
    query: { $top: 999 }
  })
  for (const a of arr(asObj(roleRows.body).value))
    if (a.resourceId === apiId) granted.add(`Role:${String(a.appRoleId ?? '').toLowerCase()}`)
  const grants = await graph(ctx, 'GET', '/oauth2PermissionGrants', {
    query: { $filter: `clientId eq '${ownId}' and resourceId eq '${apiId}'` }
  })
  const scopeNames = new Set(
    arr(asObj(grants.body).value).flatMap((g) =>
      String(g.scope ?? '')
        .split(/\s+/)
        .filter(Boolean)
    )
  )
  for (const s of arr(apiSp.oauth2PermissionScopes))
    if (scopeNames.has(String(s.value ?? '')))
      granted.add(`Scope:${String(s.id ?? '').toLowerCase()}`)
  const missing = wanted.filter(
    (p) => !granted.has(`${p.type}:${String(p.id ?? '').toLowerCase()}`)
  )
  if (missing.length)
    return {
      status: 'warn',
      message: needed,
      checkedAt,
      details: { consent: 'needed', waiting: missing.length }
    }
  return { status: 'ok', checkedAt, details: { consent: 'granted' } }
}

export const entraAdapter: ProviderAdapter = {
  key: 'entra',
  label: 'Microsoft Entra ID',
  connection: {
    fields: GRAPH_CONNECTION_FIELDS,
    hosts(config) {
      return tenantProblem(config.tenant_id) ? [] : [...GRAPH_HOSTS]
    },
    describe(config) {
      return `Entra tenant ${tenantOf(config)} · app ${String(config.client_id ?? '')}`
    },
    validate: graphConnectionProblems
  },
  types: ENTRA_TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    let token: string
    try {
      token = await mintGraphToken(ctx)
    } catch (err) {
      const message = err instanceof ProviderError ? err.message : 'Could not reach Microsoft.'
      return { ok: false, identity: null, permissions: [], missing: [], message }
    }
    const roles = new Set(tokenRoles(token))
    const readable = roles.size > 0
    const permissions = NEEDS.flatMap((n) =>
      n.any.slice(0, 1).map((need) => ({
        type: n.type,
        need,
        has: n.any.some((p) => roles.has(p))
      }))
    )
    const missing = [...new Set(permissions.filter((p) => !p.has).map((p) => p.need))]
    const claims = tokenClaims(token)
    const identity = `Application ${String(ctx.config.client_id ?? '')} in tenant ${String(claims.tid ?? tenantOf(ctx.config))}`
    const broad = roles.has(ALL_PERMS) && !roles.has(OWNED_PERM)
    const message = !readable
      ? 'Microsoft returned no application permissions for this token. Grant the Graph application permissions below and give admin consent.'
      : missing.length
        ? `Grant ${missing.join(', ')} as Microsoft Graph application permissions and give admin consent.`
        : broad
          ? `${ALL_PERMS} lets the Hub change every app registration in the tenant. ${OWNED_PERM} is safer: the Hub then changes only apps it owns.`
          : undefined
    return { ok: true, identity, permissions, missing, message }
  },

  async observe(ctx, type, externalId) {
    await graphToken(ctx)
    switch (type) {
      case APP: {
        const raw = await getApplication(ctx, externalId)
        return raw ? observedApp(raw) : null
      }
      case SECRET:
        return observeSecret(ctx, externalId)
      case SP:
        return observeSpById(ctx, externalId)
      case ROLE:
        return observeRole(ctx, externalId)
      case ASSIGN:
        return observeAssignment(ctx, externalId)
      case PERM:
        return observePerm(ctx, externalId)
      case GROUP:
        return observeGroup(ctx, externalId)
      default:
        throw unknownType(type)
    }
  },

  async list(ctx, type, cursor) {
    switch (type) {
      case APP:
        return listApps(ctx, cursor)
      case SECRET:
        return listSecrets(ctx, cursor)
      case SP:
        return listSps(ctx, cursor)
      case ROLE:
        return listRoles(ctx, cursor)
      case ASSIGN:
        return listAssignments(ctx, cursor)
      case PERM:
        return listPerms(ctx, cursor)
      case GROUP:
        return listGroups(ctx, cursor)
      default:
        throw unknownType(type)
    }
  },

  /** Plan time: what a create would collide with. Reads only; apply refuses a collision itself. */
  async findExisting(ctx, type, desired) {
    if (desired.externalId && type !== SECRET) return null
    await graphToken(ctx)
    switch (type) {
      case APP:
        // Applications are not name-unique: only the Hub's own tag identifies one (a resumed create).
        return null
      case SECRET:
        return findSecret(ctx, desired)
      case SP:
        return findSp(ctx, desired)
      case ROLE:
        return findRole(ctx, desired)
      case ASSIGN:
        return findAssignment(ctx, desired)
      case PERM:
        return findPerm(ctx, desired)
      default:
        return null
    }
  },

  plan(_ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    switch (type) {
      case APP:
        return planApp(desired, observed)
      case SECRET:
        return planSecret(desired, observed)
      case SP:
        return planSp(desired, observed)
      case ROLE:
        return planRole(desired, observed)
      case ASSIGN:
        return planAssignment(desired, observed)
      case PERM:
        return planPerm(desired, observed)
      case GROUP:
        return planGroup(desired, observed)
      default:
        return []
    }
  },

  async apply(ctx, op, desired) {
    switch (op.type) {
      case APP:
        return applyApp(ctx, op, desired)
      case SECRET:
        return applySecret(ctx, op, desired)
      case SP:
        return applyGeneric(ctx, op, desired, {
          create: createSp,
          update: updateSp,
          remove: deleteSp,
          read: observeSpById
        })
      case ROLE:
        return applyGeneric(ctx, op, desired, {
          create: createRole,
          update: updateRole,
          remove: deleteRole,
          read: observeRole
        })
      case ASSIGN:
        return applyGeneric(ctx, op, desired, {
          create: createAssignment,
          remove: deleteAssignment,
          read: observeAssignment
        })
      case PERM:
        return applyGeneric(ctx, op, desired, {
          create: createPerm,
          update: updatePerm,
          remove: deletePerm,
          read: observePerm
        })
      case GROUP:
        throw new ProviderError(
          'UNSUPPORTED',
          'The Hub only reads and adopts Entra groups; it never creates, changes or deletes them.'
        )
      default:
        throw unknownType(op.type)
    }
  },

  /** Non-secret outputs only: the app registration's ids. A client secret is shown once and never re-read. */
  async readOutputs(ctx, type, externalId) {
    if (type !== APP) return {}
    await graphToken(ctx)
    return readAppOutputs(ctx, externalId)
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    await graphToken(ctx)
    const checkedAt = ctx.now().toISOString()
    if (type === SECRET) return secretHealth(ctx, externalId)
    if (type === PERM) return permissionsHealth(ctx, externalId)
    const seen = await this.observe(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone in Entra.', checkedAt }
    if (type === SP && seen.fields.enabled === false)
      return { status: 'warn', message: 'Sign-in is switched off for this application.', checkedAt }
    if (type === ROLE && seen.fields.enabled === false)
      return { status: 'warn', message: 'This role is switched off.', checkedAt }
    return { status: 'ok', checkedAt }
  }
}
