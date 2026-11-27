import { randomUUID } from 'node:crypto'
import {
  clientIdOf,
  graph,
  graphAll,
  graphGuid,
  graphPage,
  guidFrom,
  odataString,
  tenantOf
} from '../microsoft/graph.js'
import { fieldWords, typedName } from '../plan-words.js'
import type {
  DesiredResource,
  FieldChange,
  ListPage,
  Observed,
  OpResult,
  PlannedOp,
  ProviderContext
} from '../types.js'
import { ProviderError } from '../types.js'
import {
  arr,
  asObj,
  diffFields,
  joinId,
  mergeTags,
  mkOp,
  type Obj,
  preconditionsOf,
  splitId,
  str,
  strs,
  tagsFromList
} from './shared.js'
import { APP, ENTRA_TYPES, PERM, ROLE } from './specs.js'

/**
 * The three Entra types that live on an application object: the app registration itself, its
 * app roles (`appRoles`) and its requested API permissions (`requiredResourceAccess`). One read
 * (never with credentials), whitelisted into `Observed`; every write is read-before-write.
 */

const APP_SELECT =
  'id,appId,displayName,signInAudience,web,spa,tags,appRoles,requiredResourceAccess'
const PAGE = 50

const label = (key: string) => ENTRA_TYPES.find((t) => t.key === key)?.label ?? key
const fieldsOf = (key: string) => ENTRA_TYPES.find((t) => t.key === key)?.fields

export type RawApp = Obj

export async function getApplication(
  ctx: ProviderContext,
  objectId: string
): Promise<RawApp | null> {
  const res = await graph(ctx, 'GET', `/applications/${graphGuid(objectId, 'application id')}`, {
    query: { $select: APP_SELECT },
    allow: [404]
  })
  return res.status === 404 ? null : asObj(res.body)
}

/** A write to the connection's own app registration is refused: the Hub must not edit its own sign-in. */
export function assertNotSelf(ctx: ProviderContext, appId: unknown): void {
  if (typeof appId === 'string' && appId.toLowerCase() === clientIdOf(ctx.config))
    throw new ProviderError(
      'SELF_APP',
      'That is the app registration this connection signs in as. The Hub never changes its own sign-in.'
    )
}

export async function patchApplication(
  ctx: ProviderContext,
  objectId: string,
  body: Obj
): Promise<void> {
  await graph(ctx, 'PATCH', `/applications/${graphGuid(objectId, 'application id')}`, { body })
}

/** The application an op needs (a ref resolved by the engine), read; REF_UNRESOLVED / NOT_FOUND otherwise. */
export async function requireApplication(
  ctx: ProviderContext,
  desired: DesiredResource | null
): Promise<RawApp> {
  const ref = desired?.refs.application
  if (typeof ref !== 'string')
    throw new ProviderError(
      'REF_UNRESOLVED',
      'The app registration this belongs to has not been created yet.'
    )
  const app = await getApplication(ctx, ref)
  if (!app)
    throw new ProviderError('NOT_FOUND', 'The app registration no longer exists in Entra.', {
      status: 404
    })
  assertNotSelf(ctx, app.appId)
  return app
}

const consoleUrl = (appId: string) =>
  `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Overview/appId/${encodeURIComponent(appId)}`

// ── App registration ──

export function observedApp(raw: unknown): Observed {
  const o = asObj(raw)
  // Credentials (`passwordCredentials`, `keyCredentials`) are never selected, so never copied.
  const id = str(o.id) ?? ''
  const web = asObj(o.web)
  const appId = str(o.appId) ?? ''
  return {
    type: APP,
    externalId: id,
    name: str(o.displayName),
    fields: {
      name: str(o.displayName),
      sign_in_audience: str(o.signInAudience),
      web_redirect_uris: strs(web.redirectUris),
      spa_redirect_uris: strs(asObj(o.spa).redirectUris),
      logout_url: str(web.logoutUrl),
      app_id: appId
    },
    tags: tagsFromList(o.tags),
    url: appId ? consoleUrl(appId) : null
  }
}

const APP_WRITABLE = [
  'name',
  'sign_in_audience',
  'web_redirect_uris',
  'spa_redirect_uris',
  'logout_url'
]

function appBody(fields: Obj, changed: string[] | null, tags: string[] | null): Obj {
  const has = (k: string) => changed === null || changed.includes(k)
  const body: Obj = {}
  if (has('name') && str(fields.name)) body.displayName = fields.name
  if (has('sign_in_audience') && str(fields.sign_in_audience))
    body.signInAudience = fields.sign_in_audience
  const web: Obj = {}
  if (has('web_redirect_uris') && Array.isArray(fields.web_redirect_uris))
    web.redirectUris = strs(fields.web_redirect_uris)
  if (has('logout_url') && fields.logout_url !== undefined) web.logoutUrl = str(fields.logout_url)
  if (Object.keys(web).length) body.web = web
  if (has('spa_redirect_uris') && Array.isArray(fields.spa_redirect_uris))
    body.spa = { redirectUris: strs(fields.spa_redirect_uris) }
  if (tags) body.tags = tags
  return body
}

export function planApp(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const spec = fieldsOf(APP)
  if (!desired) {
    if (!observed) return []
    return [
      mkOp(
        APP,
        null,
        'delete',
        observed.externalId,
        `Delete ${typedName(label(APP), observed.name ?? observed.externalId)}: sign-in through it stops.`,
        { preconditions: { name: observed.name } }
      )
    ]
  }
  const name = typedName(label(APP), String(desired.fields.name ?? observed?.name ?? ''))
  if (!observed)
    return [
      mkOp(
        APP,
        desired,
        'create',
        null,
        `Create ${name} (an app registration the Hub did not make is never changed: adopt it instead).`,
        {
          changes: APP_WRITABLE.filter((k) => desired.fields[k] !== undefined).map((k) => ({
            field: k,
            to: desired.fields[k]
          }))
        }
      )
    ]
  const changes: FieldChange[] = diffFields(APP_WRITABLE, desired, observed)
  const wantTags = Object.entries(desired.tags ?? {}).filter(([k]) => k.startsWith('nivaro-hub:'))
  if (wantTags.some(([k, v]) => observed.tags[k] !== v))
    changes.push({ field: 'tags', from: observed.tags, to: desired.tags })
  if (!changes.length)
    return [mkOp(APP, desired, 'noop', observed.externalId, `${name} is up to date.`)]
  return [
    mkOp(
      APP,
      desired,
      'update',
      observed.externalId,
      `Change ${fieldWords(spec, changes)} on ${name}.`,
      {
        changes,
        preconditions: preconditionsOf(changes, { ...observed.fields, tags: observed.tags })
      }
    )
  ]
}

function okResult(observed: Observed | null, externalId: string | null, status: number): OpResult {
  return { ok: true, externalId, observed, answer: { status } }
}

function appOutputs(ctx: ProviderContext, o: Observed): Record<string, string> {
  const out: Record<string, string> = {}
  const clientId = o.fields.app_id
  if (typeof clientId === 'string' && clientId) out.client_id = clientId
  const tenant = tenantOf(ctx.config)
  if (tenant) out.tenant_id = tenant
  return out
}

/** The app registration the Hub's resource tag names (an interrupted create already made it). */
export async function findAppByTag(
  ctx: ProviderContext,
  desired: DesiredResource
): Promise<RawApp | null> {
  const resource = desired.tags?.['nivaro-hub:resource']
  if (!resource) return null
  const tag = `nivaro-hub:resource=${resource}`
  const rows = await graphAll(ctx, '/applications', {
    query: { $select: APP_SELECT, $filter: `tags/any(t:t eq ${odataString(tag)})`, $top: 10 },
    advanced: true
  })
  return rows.find((r) => strs(r.tags).includes(tag)) ?? null
}

export async function createApp(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  if (desired.externalId) {
    const own = await getApplication(ctx, desired.externalId)
    if (own) return updateApp(ctx, desired.externalId, desired)
  }
  const tagged = await findAppByTag(ctx, desired)
  if (tagged) {
    // Made by an earlier, interrupted run of this resource: nothing is changed.
    const o = observedApp(tagged)
    return { ...okResult(o, o.externalId, 200), outputs: appOutputs(ctx, o) }
  }
  const body = appBody(desired.fields, null, null)
  if (!body.displayName) throw new ProviderError('INVALID', 'The app registration needs a name.')
  if (!body.signInAudience) body.signInAudience = 'AzureADMyOrg'
  body.tags = mergeTags([], desired.tags ?? {})
  const res = await graph(ctx, 'POST', '/applications', { body })
  const o = observedApp(res.body)
  return { ...okResult(o, o.externalId, res.status), outputs: appOutputs(ctx, o) }
}

export async function updateApp(
  ctx: ProviderContext,
  id: string,
  desired: DesiredResource
): Promise<OpResult> {
  const raw = await getApplication(ctx, id)
  if (!raw)
    throw new ProviderError('NOT_FOUND', 'The app registration no longer exists in Entra.', {
      status: 404
    })
  assertNotSelf(ctx, raw.appId)
  const observed = observedApp(raw)
  const changes = diffFields(APP_WRITABLE, desired, observed)
  const wantTags = Object.entries(desired.tags ?? {}).filter(([k]) => k.startsWith('nivaro-hub:'))
  const tagsChanged = wantTags.some(([k, v]) => observed.tags[k] !== v)
  if (!changes.length && !tagsChanged) return okResult(observed, observed.externalId, 200)
  const body = appBody(
    desired.fields,
    changes.map((c) => c.field),
    tagsChanged ? mergeTags(raw.tags, desired.tags ?? {}) : null
  )
  await patchApplication(ctx, id, body)
  const after = await getApplication(ctx, id)
  return okResult(after ? observedApp(after) : observed, id, 204)
}

export async function deleteApp(ctx: ProviderContext, id: string): Promise<OpResult> {
  const raw = await getApplication(ctx, id)
  if (!raw) return okResult(null, id, 204)
  assertNotSelf(ctx, raw.appId)
  await graph(ctx, 'DELETE', `/applications/${graphGuid(id, 'application id')}`, { allow: [404] })
  return okResult(null, id, 204)
}

export async function listApps(ctx: ProviderContext, cursor?: string | null): Promise<ListPage> {
  const page = await graphPage(ctx, '/applications', {
    query: { $select: APP_SELECT, $top: PAGE },
    from: cursor ?? null
  })
  return { items: page.items.map(observedApp), cursor: page.next }
}

export async function readAppOutputs(
  ctx: ProviderContext,
  externalId: string
): Promise<Record<string, string>> {
  const raw = await getApplication(ctx, externalId)
  return raw ? appOutputs(ctx, observedApp(raw)) : {}
}

// ── App roles ──

function observedRole(appObjectId: string, role: Obj): Observed {
  const id = str(role.id) ?? ''
  return {
    type: ROLE,
    externalId: joinId(appObjectId, id),
    name: str(role.value) ?? str(role.displayName),
    fields: {
      application: appObjectId,
      value: str(role.value),
      display_name: str(role.displayName),
      description: str(role.description),
      allowed_member_types: strs(role.allowedMemberTypes),
      enabled: role.isEnabled !== false
    },
    tags: {}
  }
}

const ROLE_WRITABLE = ['value', 'display_name', 'description', 'allowed_member_types', 'enabled']

export async function observeRole(
  ctx: ProviderContext,
  externalId: string
): Promise<Observed | null> {
  const ids = splitId(externalId)
  if (!ids) return null
  const app = await getApplication(ctx, ids.parent)
  if (!app) return null
  const role = arr(app.appRoles).find((r) => r.id === ids.child)
  return role ? observedRole(ids.parent, role) : null
}

export async function listRoles(ctx: ProviderContext, cursor?: string | null): Promise<ListPage> {
  const page = await graphPage(ctx, '/applications', {
    query: { $select: 'id,appRoles', $top: PAGE },
    from: cursor ?? null
  })
  const items: Observed[] = []
  for (const a of page.items)
    for (const r of arr(a.appRoles)) items.push(observedRole(String(a.id ?? ''), r))
  return { items, cursor: page.next }
}

export function planRole(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const spec = fieldsOf(ROLE)
  if (!desired) {
    if (!observed) return []
    return [
      mkOp(
        ROLE,
        null,
        'delete',
        observed.externalId,
        `Delete ${typedName(label(ROLE), observed.name)}: it is switched off first, then removed.`,
        { preconditions: { value: observed.fields.value } }
      )
    ]
  }
  const name = typedName(label(ROLE), String(desired.fields.value ?? observed?.name ?? ''))
  if (!observed)
    return [
      mkOp(
        ROLE,
        desired,
        'create',
        null,
        `Create ${name} (a role with the same value is refused: adopt it instead).`,
        {
          changes: ROLE_WRITABLE.filter((k) => desired.fields[k] !== undefined).map((k) => ({
            field: k,
            to: desired.fields[k]
          }))
        }
      )
    ]
  const changes = diffFields(ROLE_WRITABLE, desired, observed)
  if (!changes.length)
    return [mkOp(ROLE, desired, 'noop', observed.externalId, `${name} is up to date.`)]
  return [
    mkOp(
      ROLE,
      desired,
      'update',
      observed.externalId,
      `Change ${fieldWords(spec, changes)} on ${name}.`,
      {
        changes,
        preconditions: preconditionsOf(changes, observed.fields)
      }
    )
  ]
}

function roleEntry(id: string, f: Obj, previous: Obj | null): Obj {
  const members = Array.isArray(f.allowed_member_types) ? strs(f.allowed_member_types) : null
  return {
    ...(previous ?? {}),
    id,
    value: f.value !== undefined ? f.value : previous?.value,
    displayName: f.display_name !== undefined ? f.display_name : previous?.displayName,
    description: f.description !== undefined ? f.description : previous?.description,
    allowedMemberTypes: members?.length ? members : (previous?.allowedMemberTypes ?? ['User']),
    isEnabled: f.enabled !== undefined ? f.enabled !== false : (previous?.isEnabled ?? true),
    origin: previous?.origin ?? 'Application'
  }
}

/** A role id that is the same for the same Hub resource, so a resumed create finds its own role. */
function roleIdFor(desired: DesiredResource, appObjectId: string): string {
  return desired.resourceId != null
    ? guidFrom(`nivaro-hub:entra-role:${desired.resourceId}:${appObjectId}`)
    : randomUUID()
}

export async function createRole(
  ctx: ProviderContext,
  desired: DesiredResource
): Promise<OpResult> {
  const app = await requireApplication(ctx, desired)
  const appId = String(app.id)
  const roles = arr(app.appRoles)
  const wantId = roleIdFor(desired, appId)
  const value = str(desired.fields.value)
  if (!value || !str(desired.fields.display_name) || !str(desired.fields.description))
    throw new ProviderError(
      'INVALID',
      'An app role needs a value, a display name and a description.'
    )
  const own = roles.find((r) => r.id === wantId)
  if (own) {
    // Made by an earlier, interrupted run of this resource: bring it to the wanted values.
    return updateRole(ctx, joinId(appId, wantId), desired)
  }
  if (roles.some((r) => str(r.value)?.toLowerCase() === value.toLowerCase()))
    throw new ProviderError(
      'ALREADY_EXISTS',
      `A role with the value ${value} already exists on this app registration and was not created by the Hub. Adopt it instead of creating it.`,
      { status: 409 }
    )
  const entry = roleEntry(wantId, desired.fields, null)
  await patchApplication(ctx, appId, { appRoles: [...roles, entry] })
  return okResult(observedRole(appId, entry), joinId(appId, wantId), 204)
}

export async function updateRole(
  ctx: ProviderContext,
  externalId: string,
  desired: DesiredResource
): Promise<OpResult> {
  const ids = splitId(externalId)
  if (!ids) throw new ProviderError('INVALID', 'That is not an app role id.')
  const app = await getApplication(ctx, ids.parent)
  if (!app)
    throw new ProviderError('NOT_FOUND', 'The app registration no longer exists in Entra.', {
      status: 404
    })
  assertNotSelf(ctx, app.appId)
  const roles = arr(app.appRoles)
  const current = roles.find((r) => r.id === ids.child)
  if (!current)
    throw new ProviderError('NOT_FOUND', 'The app role no longer exists in Entra.', { status: 404 })
  const observed = observedRole(ids.parent, current)
  const changes = diffFields(ROLE_WRITABLE, desired, observed)
  if (!changes.length) return okResult(observed, externalId, 200)
  const next = roleEntry(ids.child, desired.fields, current)
  const others = (value: string) =>
    roles.some((r) => r.id !== ids.child && str(r.value)?.toLowerCase() === value.toLowerCase())
  if (typeof next.value === 'string' && others(next.value))
    throw new ProviderError(
      'ALREADY_EXISTS',
      `Another role on this app registration already has the value ${next.value}.`,
      {
        status: 409
      }
    )
  await patchApplication(ctx, ids.parent, {
    appRoles: roles.map((r) => (r.id === ids.child ? next : r))
  })
  return okResult(observedRole(ids.parent, next), externalId, 204)
}

export async function deleteRole(ctx: ProviderContext, externalId: string): Promise<OpResult> {
  const ids = splitId(externalId)
  if (!ids) throw new ProviderError('INVALID', 'That is not an app role id.')
  const app = await getApplication(ctx, ids.parent)
  if (!app) return okResult(null, externalId, 204)
  assertNotSelf(ctx, app.appId)
  const roles = arr(app.appRoles)
  const current = roles.find((r) => r.id === ids.child)
  if (!current) return okResult(null, externalId, 204)
  // Entra refuses to remove an enabled role: switch it off first, then take it out.
  let rest = roles
  if (current.isEnabled !== false) {
    rest = roles.map((r) => (r.id === ids.child ? { ...r, isEnabled: false } : r))
    await patchApplication(ctx, ids.parent, { appRoles: rest })
  }
  await patchApplication(ctx, ids.parent, { appRoles: rest.filter((r) => r.id !== ids.child) })
  return okResult(null, externalId, 204)
}

export async function findRole(
  ctx: ProviderContext,
  desired: DesiredResource
): Promise<Observed | null> {
  const ref = desired.refs.application
  const value = str(desired.fields.value)
  if (typeof ref !== 'string' || !value) return null
  const app = await getApplication(ctx, ref)
  if (!app) return null
  const wantId = roleIdFor(desired, ref)
  const role = arr(app.appRoles).find(
    (r) => r.id !== wantId && str(r.value)?.toLowerCase() === value.toLowerCase()
  )
  return role ? observedRole(ref, role) : null
}

// ── Requested API permissions ──

interface Perm {
  id: string
  type: string
}

const permList = (v: unknown): Perm[] =>
  arr(v)
    .map((p) => ({ id: String(p.id ?? '').toLowerCase(), type: String(p.type ?? '') }))
    .filter((p) => p.id && p.type)

function observedPerm(appObjectId: string, entry: Obj): Observed {
  const resource = String(entry.resourceAppId ?? '').toLowerCase()
  return {
    type: PERM,
    externalId: joinId(appObjectId, resource),
    name: `Permissions for ${resource}`,
    fields: {
      application: appObjectId,
      resource_app_id: resource,
      permissions: arr(entry.resourceAccess).map((r) => ({
        id: String(r.id ?? '').toLowerCase(),
        type: String(r.type ?? '')
      }))
    },
    tags: {}
  }
}

export async function observePerm(
  ctx: ProviderContext,
  externalId: string
): Promise<Observed | null> {
  const ids = splitId(externalId)
  if (!ids) return null
  const app = await getApplication(ctx, ids.parent)
  if (!app) return null
  const entry = arr(app.requiredResourceAccess).find(
    (e) => String(e.resourceAppId ?? '').toLowerCase() === ids.child.toLowerCase()
  )
  return entry ? observedPerm(ids.parent, entry) : null
}

export async function listPerms(ctx: ProviderContext, cursor?: string | null): Promise<ListPage> {
  const page = await graphPage(ctx, '/applications', {
    query: { $select: 'id,requiredResourceAccess', $top: PAGE },
    from: cursor ?? null
  })
  const items: Observed[] = []
  for (const a of page.items)
    for (const e of arr(a.requiredResourceAccess)) items.push(observedPerm(String(a.id ?? ''), e))
  return { items, cursor: page.next }
}

export function planPerm(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const spec = fieldsOf(PERM)
  if (!desired) {
    if (!observed) return []
    return [
      mkOp(
        PERM,
        null,
        'delete',
        observed.externalId,
        `Remove the permission request ${String(observed.fields.resource_app_id ?? '')} from the app registration.`,
        {
          preconditions: { permissions: observed.fields.permissions }
        }
      )
    ]
  }
  const resource = String(desired.fields.resource_app_id ?? observed?.fields.resource_app_id ?? '')
  const name = typedName(label(PERM), resource)
  if (!observed)
    return [
      mkOp(
        PERM,
        desired,
        'create',
        null,
        `Create ${name} (a request for that API already on the app registration is refused: adopt it instead).`,
        {
          changes: [{ field: 'permissions', to: desired.fields.permissions }]
        }
      )
    ]
  const changes = diffFields(['permissions'], desired, observed)
  if (!changes.length)
    return [mkOp(PERM, desired, 'noop', observed.externalId, `${name} is up to date.`)]
  return [
    mkOp(
      PERM,
      desired,
      'update',
      observed.externalId,
      `Change ${fieldWords(spec, changes)} on ${name}.`,
      {
        changes,
        preconditions: preconditionsOf(changes, observed.fields)
      }
    )
  ]
}

const sameResource = (e: Obj, resource: string) =>
  String(e.resourceAppId ?? '').toLowerCase() === resource.toLowerCase()

function accessEntry(resource: string, permissions: unknown): Obj {
  return {
    resourceAppId: resource,
    resourceAccess: permList(permissions).map((p) => ({ id: p.id, type: p.type }))
  }
}

export async function createPerm(
  ctx: ProviderContext,
  desired: DesiredResource
): Promise<OpResult> {
  const app = await requireApplication(ctx, desired)
  const appId = String(app.id)
  const resource = graphGuid(
    str(desired.fields.resource_app_id) ?? '00000003-0000-0000-c000-000000000000',
    'API application id'
  )
  const entries = arr(app.requiredResourceAccess)
  if (entries.some((e) => sameResource(e, resource))) {
    if (desired.externalId) return updatePerm(ctx, joinId(appId, resource), desired)
    throw new ProviderError(
      'ALREADY_EXISTS',
      'The app registration already requests permissions for that API and the Hub did not make that request. Adopt it instead of creating it.',
      { status: 409 }
    )
  }
  const entry = accessEntry(resource, desired.fields.permissions)
  await patchApplication(ctx, appId, { requiredResourceAccess: [...entries, entry] })
  return okResult(observedPerm(appId, entry), joinId(appId, resource), 204)
}

export async function updatePerm(
  ctx: ProviderContext,
  externalId: string,
  desired: DesiredResource
): Promise<OpResult> {
  const ids = splitId(externalId)
  if (!ids) throw new ProviderError('INVALID', 'That is not a permission request id.')
  const app = await getApplication(ctx, ids.parent)
  if (!app)
    throw new ProviderError('NOT_FOUND', 'The app registration no longer exists in Entra.', {
      status: 404
    })
  assertNotSelf(ctx, app.appId)
  const entries = arr(app.requiredResourceAccess)
  const current = entries.find((e) => sameResource(e, ids.child))
  if (!current)
    throw new ProviderError('NOT_FOUND', 'That permission request no longer exists.', {
      status: 404
    })
  const observed = observedPerm(ids.parent, current)
  if (!diffFields(['permissions'], desired, observed).length)
    return okResult(observed, externalId, 200)
  const next = accessEntry(ids.child, desired.fields.permissions)
  await patchApplication(ctx, ids.parent, {
    requiredResourceAccess: entries.map((e) => (sameResource(e, ids.child) ? next : e))
  })
  return okResult(observedPerm(ids.parent, next), externalId, 204)
}

export async function deletePerm(ctx: ProviderContext, externalId: string): Promise<OpResult> {
  const ids = splitId(externalId)
  if (!ids) throw new ProviderError('INVALID', 'That is not a permission request id.')
  const app = await getApplication(ctx, ids.parent)
  if (!app) return okResult(null, externalId, 204)
  assertNotSelf(ctx, app.appId)
  const entries = arr(app.requiredResourceAccess)
  if (!entries.some((e) => sameResource(e, ids.child))) return okResult(null, externalId, 204)
  await patchApplication(ctx, ids.parent, {
    requiredResourceAccess: entries.filter((e) => !sameResource(e, ids.child))
  })
  return okResult(null, externalId, 204)
}

export async function findPerm(
  ctx: ProviderContext,
  desired: DesiredResource
): Promise<Observed | null> {
  const ref = desired.refs.application
  if (typeof ref !== 'string') return null
  const resource = String(desired.fields.resource_app_id ?? '00000003-0000-0000-c000-000000000000')
  const app = await getApplication(ctx, ref)
  const entry = app ? arr(app.requiredResourceAccess).find((e) => sameResource(e, resource)) : null
  return entry ? observedPerm(ref, entry) : null
}

/** The consent link a person opens to grant an app's requested permissions. */
export function consentUrl(ctx: ProviderContext, appId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantOf(ctx.config))}/adminconsent?client_id=${encodeURIComponent(appId)}`
}
