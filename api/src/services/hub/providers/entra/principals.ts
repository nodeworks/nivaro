import {
  graph,
  graphAll,
  graphErrorCode,
  graphGuid,
  graphPage,
  odataString
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
import { assertNotSelf, getApplication } from './application.js'
import {
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
import { ASSIGN, DEFAULT_ACCESS_ROLE, ENTRA_TYPES, GROUP, SP } from './specs.js'

/**
 * Entra principals: the enterprise application (service principal) of an app registration, the
 * groups the Hub may read and adopt (never create or change), and the group-to-role assignments
 * on an enterprise application.
 */

const SP_SELECT = 'id,appId,displayName,accountEnabled,appRoleAssignmentRequired,tags'
const GROUP_SELECT =
  'id,displayName,description,securityEnabled,mailEnabled,groupTypes,membershipRule'
const PAGE = 50
const ASSIGN_SP_PAGE = 20

const label = (key: string) => ENTRA_TYPES.find((t) => t.key === key)?.label ?? key
const fieldsOf = (key: string) => ENTRA_TYPES.find((t) => t.key === key)?.fields

function okResult(observed: Observed | null, externalId: string | null, status: number): OpResult {
  return { ok: true, externalId, observed, answer: { status } }
}

// ── Enterprise application (service principal) ──

type RawSp = Obj

async function getSp(ctx: ProviderContext, id: string): Promise<RawSp | null> {
  const res = await graph(
    ctx,
    'GET',
    `/servicePrincipals/${graphGuid(id, 'service principal id')}`,
    {
      query: { $select: SP_SELECT },
      allow: [404]
    }
  )
  return res.status === 404 ? null : asObj(res.body)
}

/** The application object id behind an application (client) id, or null when this connection cannot see it. */
export async function appObjectIdOf(ctx: ProviderContext, appId: string): Promise<string | null> {
  const res = await graph(ctx, 'GET', '/applications', {
    query: {
      $select: 'id',
      $filter: `appId eq ${odataString(graphGuid(appId, 'application id'))}`
    },
    allow: [403]
  })
  const rows = Array.isArray(asObj(res.body).value) ? (asObj(res.body).value as unknown[]) : []
  return str(asObj(rows[0]).id)
}

export async function observedSp(ctx: ProviderContext, raw: unknown): Promise<Observed> {
  const o = asObj(raw)
  const id = str(o.id) ?? ''
  const appId = str(o.appId) ?? ''
  const fields: Obj = {
    name: str(o.displayName),
    assignment_required: o.appRoleAssignmentRequired === true,
    enabled: o.accountEnabled !== false,
    app_id: appId
  }
  const appObject = appId ? await appObjectIdOf(ctx, appId).catch(() => null) : null
  if (appObject) fields.application = appObject
  return {
    type: SP,
    externalId: id,
    name: str(o.displayName),
    fields,
    tags: tagsFromList(o.tags),
    url: id
      ? `https://entra.microsoft.com/#view/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/Overview/objectId/${encodeURIComponent(id)}/appId/${encodeURIComponent(appId)}`
      : null
  }
}

const SP_WRITABLE = ['assignment_required', 'enabled']

export function planSp(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const spec = fieldsOf(SP)
  if (!desired) {
    if (!observed) return []
    return [
      mkOp(
        SP,
        null,
        'delete',
        observed.externalId,
        `Delete ${typedName(label(SP), observed.name ?? observed.externalId)}: people can no longer sign in to the app.`,
        { preconditions: { app_id: observed.fields.app_id } }
      )
    ]
  }
  const name = typedName(label(SP), String(observed?.name ?? desired.fields.app_id ?? ''))
  if (!observed)
    return [
      mkOp(
        SP,
        desired,
        'create',
        null,
        `Create ${name} for the app registration (one that already exists and was not made by the Hub is refused: adopt it instead).`,
        {
          changes: SP_WRITABLE.filter((k) => desired.fields[k] !== undefined).map((k) => ({
            field: k,
            to: desired.fields[k]
          }))
        }
      )
    ]
  const changes: FieldChange[] = diffFields(SP_WRITABLE, desired, observed)
  const wantTags = Object.entries(desired.tags ?? {}).filter(([k]) => k.startsWith('nivaro-hub:'))
  if (wantTags.some(([k, v]) => observed.tags[k] !== v))
    changes.push({ field: 'tags', from: observed.tags, to: desired.tags })
  if (!changes.length)
    return [mkOp(SP, desired, 'noop', observed.externalId, `${name} is up to date.`)]
  return [
    mkOp(
      SP,
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

async function spForAppId(ctx: ProviderContext, appId: string): Promise<RawSp | null> {
  const res = await graph(ctx, 'GET', '/servicePrincipals', {
    query: {
      $select: SP_SELECT,
      $filter: `appId eq ${odataString(graphGuid(appId, 'application id'))}`
    }
  })
  const rows = Array.isArray(asObj(res.body).value) ? (asObj(res.body).value as unknown[]) : []
  return rows.length ? asObj(rows[0]) : null
}

function spBody(fields: Obj, changed: string[] | null): Obj {
  const has = (k: string) => changed === null || changed.includes(k)
  const body: Obj = {}
  if (has('assignment_required') && fields.assignment_required !== undefined)
    body.appRoleAssignmentRequired = fields.assignment_required === true
  if (has('enabled') && fields.enabled !== undefined) body.accountEnabled = fields.enabled !== false
  return body
}

export async function createSp(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  const ref = desired.refs.application
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
  const appId = String(app.appId)
  const existing = await spForAppId(ctx, appId)
  if (existing) {
    if (desired.externalId) return updateSp(ctx, String(existing.id), desired)
    const resource = desired.tags?.['nivaro-hub:resource']
    if (resource && tagsFromList(existing.tags)['nivaro-hub:resource'] === resource) {
      // Made by an earlier, interrupted run of this resource: nothing is changed.
      const o = await observedSp(ctx, existing)
      return okResult(o, o.externalId, 200)
    }
    throw new ProviderError(
      'ALREADY_EXISTS',
      'An enterprise application already exists for this app registration and was not created by the Hub. Adopt it instead of creating it.',
      { status: 409 }
    )
  }
  try {
    const res = await graph(ctx, 'POST', '/servicePrincipals', {
      body: {
        appId,
        ...spBody(desired.fields, null),
        tags: mergeTags([], desired.tags ?? {})
      }
    })
    const o = await observedSp(ctx, res.body)
    return okResult(o, o.externalId, res.status)
  } catch (err) {
    // A just-made app registration may not be replicated yet.
    if (
      err instanceof ProviderError &&
      (err.status === 404 || /valid application object/i.test(err.message))
    )
      throw new ProviderError(
        'REPLICATION_PENDING',
        'The app registration is not visible to the enterprise application yet. Retry in a moment.',
        { status: err.status, retryable: true }
      )
    throw err
  }
}

export async function updateSp(
  ctx: ProviderContext,
  id: string,
  desired: DesiredResource
): Promise<OpResult> {
  const raw = await getSp(ctx, id)
  if (!raw)
    throw new ProviderError('NOT_FOUND', 'The enterprise application no longer exists.', {
      status: 404
    })
  assertNotSelf(ctx, raw.appId)
  const observed = await observedSp(ctx, raw)
  const changes = diffFields(SP_WRITABLE, desired, observed)
  const wantTags = Object.entries(desired.tags ?? {}).filter(([k]) => k.startsWith('nivaro-hub:'))
  const tagsChanged = wantTags.some(([k, v]) => observed.tags[k] !== v)
  if (!changes.length && !tagsChanged) return okResult(observed, id, 200)
  const body = spBody(
    desired.fields,
    changes.map((c) => c.field)
  )
  if (tagsChanged) body.tags = mergeTags(raw.tags, desired.tags ?? {})
  await graph(ctx, 'PATCH', `/servicePrincipals/${graphGuid(id, 'service principal id')}`, { body })
  const after = await getSp(ctx, id)
  return okResult(after ? await observedSp(ctx, after) : observed, id, 204)
}

export async function deleteSp(ctx: ProviderContext, id: string): Promise<OpResult> {
  const raw = await getSp(ctx, id)
  if (!raw) return okResult(null, id, 204)
  assertNotSelf(ctx, raw.appId)
  await graph(ctx, 'DELETE', `/servicePrincipals/${graphGuid(id, 'service principal id')}`, {
    allow: [404]
  })
  return okResult(null, id, 204)
}

export async function observeSpById(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const raw = await getSp(ctx, id)
  return raw ? observedSp(ctx, raw) : null
}

export async function listSps(ctx: ProviderContext, cursor?: string | null): Promise<ListPage> {
  const page = await graphPage(ctx, '/servicePrincipals', {
    query: { $select: SP_SELECT, $top: PAGE },
    from: cursor ?? null
  })
  const items: Observed[] = []
  for (const r of page.items) items.push(await observedSp(ctx, r))
  return { items, cursor: page.next }
}

export async function findSp(
  ctx: ProviderContext,
  desired: DesiredResource
): Promise<Observed | null> {
  const ref = desired.refs.application
  if (typeof ref !== 'string' || desired.externalId) return null
  const app = await getApplication(ctx, ref)
  if (!app) return null
  const existing = await spForAppId(ctx, String(app.appId))
  return existing ? observedSp(ctx, existing) : null
}

// ── Groups (read and adopt only) ──

function observedGroup(raw: unknown): Observed {
  const o = asObj(raw)
  const id = str(o.id) ?? ''
  const types = strs(o.groupTypes)
  return {
    type: GROUP,
    externalId: id,
    name: str(o.displayName),
    fields: {
      name: str(o.displayName),
      description: str(o.description),
      security_enabled: o.securityEnabled === true,
      mail_enabled: o.mailEnabled === true,
      membership:
        types.includes('DynamicMembership') || str(o.membershipRule) ? 'dynamic' : 'assigned'
    },
    tags: {},
    url: id
      ? `https://entra.microsoft.com/#view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Overview/groupId/${encodeURIComponent(id)}`
      : null
  }
}

export async function observeGroup(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const res = await graph(ctx, 'GET', `/groups/${graphGuid(id, 'group id')}`, {
    query: { $select: GROUP_SELECT },
    allow: [404]
  })
  return res.status === 404 ? null : observedGroup(res.body)
}

export async function listGroups(ctx: ProviderContext, cursor?: string | null): Promise<ListPage> {
  const page = await graphPage(ctx, '/groups', {
    query: { $select: GROUP_SELECT, $top: PAGE },
    from: cursor ?? null
  })
  return { items: page.items.map(observedGroup), cursor: page.next }
}

export function planGroup(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  // Groups are read and adopted, never created, changed or deleted by the Hub.
  if (desired && observed)
    return [
      mkOp(
        GROUP,
        desired,
        'noop',
        observed.externalId,
        `${typedName(label(GROUP), observed.name)} is read-only for the Hub.`
      )
    ]
  return []
}

// ── Group role assignments ──

type RawAssignment = Obj

async function assignmentsOf(ctx: ProviderContext, spId: string): Promise<RawAssignment[]> {
  return graphAll(
    ctx,
    `/servicePrincipals/${graphGuid(spId, 'service principal id')}/appRoleAssignedTo`,
    {
      query: { $top: 999 }
    }
  )
}

function isGroupAssignment(a: Obj): boolean {
  return a.principalType === 'Group'
}

/** `<appObjectId>:<roleId>` of the app role an assignment names; null for default access. */
async function roleRefOf(
  ctx: ProviderContext,
  spId: string,
  roleId: string,
  cache: Map<string, string | null>
): Promise<string | null> {
  if (!roleId || roleId === DEFAULT_ACCESS_ROLE) return null
  let appObject = cache.get(spId)
  if (appObject === undefined) {
    const sp = await getSp(ctx, spId)
    appObject =
      sp && str(sp.appId) ? await appObjectIdOf(ctx, String(sp.appId)).catch(() => null) : null
    cache.set(spId, appObject)
  }
  return appObject ? joinId(appObject, roleId) : null
}

async function observedAssignment(
  ctx: ProviderContext,
  spId: string,
  a: Obj,
  cache: Map<string, string | null>
): Promise<Observed> {
  const id = str(a.id) ?? ''
  const role = await roleRefOf(ctx, spId, String(a.appRoleId ?? ''), cache)
  const fields: Obj = { service_principal: spId, group: str(a.principalId), app_role: role }
  return {
    type: ASSIGN,
    externalId: joinId(spId, id),
    name: str(a.principalDisplayName) ?? str(a.principalId),
    fields,
    tags: {}
  }
}

export async function observeAssignment(
  ctx: ProviderContext,
  externalId: string
): Promise<Observed | null> {
  const ids = splitId(externalId)
  if (!ids) return null
  const sp = await getSp(ctx, ids.parent)
  if (!sp) return null
  const hit = (await assignmentsOf(ctx, ids.parent)).find(
    (a) => a.id === ids.child && isGroupAssignment(a)
  )
  return hit ? observedAssignment(ctx, ids.parent, hit, new Map()) : null
}

export async function listAssignments(
  ctx: ProviderContext,
  cursor?: string | null
): Promise<ListPage> {
  // Assignments hang off enterprise applications: walk them one page of 20 at a time.
  const page = await graphPage(ctx, '/servicePrincipals', {
    query: { $select: 'id,appId', $top: ASSIGN_SP_PAGE },
    from: cursor ?? null
  })
  const items: Observed[] = []
  const cache = new Map<string, string | null>()
  for (const s of page.items) {
    const spId = str(s.id)
    if (!spId) continue
    for (const a of await assignmentsOf(ctx, spId))
      if (isGroupAssignment(a)) items.push(await observedAssignment(ctx, spId, a, cache))
  }
  return { items, cursor: page.next }
}

export function planAssignment(
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      mkOp(
        ASSIGN,
        null,
        'delete',
        observed.externalId,
        `Remove ${typedName(label(ASSIGN), observed.name)}: the group’s members lose that access.`,
        { preconditions: { group: observed.fields.group, app_role: observed.fields.app_role } }
      )
    ]
  }
  const name = typedName(label(ASSIGN), observed?.name)
  if (!observed)
    return [
      mkOp(
        ASSIGN,
        desired,
        'create',
        null,
        `Create ${typedName(label(ASSIGN), null)}: give the group access (an assignment the Hub did not make is refused: adopt it instead).`,
        {
          changes: [
            { field: 'service_principal', to: desired.refs.service_principal ?? null },
            { field: 'group', to: desired.refs.group ?? null },
            { field: 'app_role', to: desired.refs.app_role ?? null }
          ]
        }
      )
    ]
  const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null)
  const sameSp =
    typeof desired.refs.service_principal !== 'string' ||
    desired.refs.service_principal === observed.fields.service_principal
  const sameGroup =
    typeof desired.refs.group !== 'string' || desired.refs.group === observed.fields.group
  const sameRole =
    observed.fields.app_role === undefined ||
    same(
      typeof desired.refs.app_role === 'string' ? desired.refs.app_role : null,
      observed.fields.app_role
    )
  if (sameSp && sameGroup && sameRole)
    return [mkOp(ASSIGN, desired, 'noop', observed.externalId, `${name} is up to date.`)]
  return [
    mkOp(
      ASSIGN,
      desired,
      'replace',
      observed.externalId,
      `Replace ${name}: an assignment is made or removed, not edited.`,
      {
        changes: [
          { field: 'group', from: observed.fields.group, to: desired.refs.group ?? null },
          { field: 'app_role', from: observed.fields.app_role, to: desired.refs.app_role ?? null }
        ],
        preconditions: { group: observed.fields.group, app_role: observed.fields.app_role }
      }
    )
  ]
}

function wanted(desired: DesiredResource): { spId: string; groupId: string; roleId: string } {
  const spId = desired.refs.service_principal
  const groupId = desired.refs.group
  if (typeof spId !== 'string' || typeof groupId !== 'string')
    throw new ProviderError(
      'REF_UNRESOLVED',
      'The enterprise application or the group this belongs to is not known yet.'
    )
  const role = desired.refs.app_role
  const ids = typeof role === 'string' ? splitId(role) : null
  return {
    spId: graphGuid(spId, 'service principal id'),
    groupId: graphGuid(groupId, 'group id'),
    roleId: ids ? graphGuid(ids.child, 'app role id') : DEFAULT_ACCESS_ROLE
  }
}

export async function createAssignment(
  ctx: ProviderContext,
  desired: DesiredResource
): Promise<OpResult> {
  const { spId, groupId, roleId } = wanted(desired)
  const sp = await getSp(ctx, spId)
  if (!sp)
    throw new ProviderError('NOT_FOUND', 'The enterprise application no longer exists.', {
      status: 404
    })
  assertNotSelf(ctx, sp.appId)
  const existing = (await assignmentsOf(ctx, spId)).find(
    (a) => a.principalId === groupId && a.appRoleId === roleId && isGroupAssignment(a)
  )
  if (existing) {
    if (desired.externalId === joinId(spId, String(existing.id)))
      return okResult(
        await observedAssignment(ctx, spId, existing, new Map()),
        desired.externalId,
        200
      )
    throw new ProviderError(
      'ALREADY_EXISTS',
      'That group already has this role on the enterprise application and the Hub did not assign it. Adopt it instead of creating it.',
      { status: 409 }
    )
  }
  const res = await graph(ctx, 'POST', `/servicePrincipals/${spId}/appRoleAssignedTo`, {
    body: { principalId: groupId, resourceId: spId, appRoleId: roleId }
  })
  const made = asObj(res.body)
  const o = await observedAssignment(
    ctx,
    spId,
    { ...made, principalId: made.principalId ?? groupId, appRoleId: made.appRoleId ?? roleId },
    new Map()
  )
  return okResult(o, o.externalId, res.status)
}

export async function deleteAssignment(
  ctx: ProviderContext,
  externalId: string
): Promise<OpResult> {
  const ids = splitId(externalId)
  if (!ids) throw new ProviderError('INVALID', 'That is not an assignment id.')
  const sp = await getSp(ctx, ids.parent)
  if (!sp) return okResult(null, externalId, 204)
  assertNotSelf(ctx, sp.appId)
  const hit = (await assignmentsOf(ctx, ids.parent)).find(
    (a) => a.id === ids.child && isGroupAssignment(a)
  )
  if (!hit) return okResult(null, externalId, 204)
  try {
    await graph(
      ctx,
      'DELETE',
      `/servicePrincipals/${graphGuid(ids.parent, 'service principal id')}/appRoleAssignedTo/${graphGuid(ids.child, 'assignment id')}`,
      { allow: [404] }
    )
  } catch (err) {
    if (graphErrorCode(err) !== 'Request_ResourceNotFound') throw err
  }
  return okResult(null, externalId, 204)
}

export async function findAssignment(
  ctx: ProviderContext,
  desired: DesiredResource
): Promise<Observed | null> {
  if (desired.externalId) return null
  const r = desired.refs
  if (typeof r.service_principal !== 'string' || typeof r.group !== 'string') return null
  const { spId, groupId, roleId } = wanted(desired)
  const hit = (await assignmentsOf(ctx, spId)).find(
    (a) => a.principalId === groupId && a.appRoleId === roleId && isGroupAssignment(a)
  )
  return hit ? observedAssignment(ctx, spId, hit, new Map()) : null
}
