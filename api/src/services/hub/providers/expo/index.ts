import { scrubValues } from '../context.js'
import { fieldWords, typedName } from '../plan-words.js'
import type {
  ConnectionTest,
  DesiredResource,
  FieldChange,
  FieldSpec,
  ListPage,
  Observed,
  OpResult,
  PlannedOp,
  ProviderAdapter,
  ProviderContext,
  SecretValue
} from '../types.js'
import { ProviderError } from '../types.js'
import { composeId, gql, isGone, pageAll, splitId } from './client.js'
import * as Q from './queries.js'
import { EXPO_TYPE_KEYS, EXPO_TYPES } from './specs.js'

/**
 * Expo / EAS adapter. Robot access token (sealed) against https://api.expo.dev/graphql, one
 * pinned account. Provider ids: the project is its app id; branch, channel, env var and build ids
 * are composed `<appId>:<id>` so `observe` knows which app to ask (see client.ts).
 */

const SITE = 'https://expo.dev'

// ── Small helpers ──

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
const account = (ctx: ProviderContext): string => String(ctx.config.account ?? '')

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = strList(a)
      .map((s) => s.toLowerCase())
      .sort()
    const y = strList(b)
      .map((s) => s.toLowerCase())
      .sort()
    return x.length === y.length && x.every((s, i) => s === y[i])
  }
  return (a ?? null) === (b ?? null)
}

/**
 * A create that meets a resource the Hub did not make is never bound silently: unless this
 * resource row already records that very id (a resumed run), the person must adopt it.
 */
function refuseUnlessResumed(d: DesiredResource, existingId: string, what: string): void {
  if (d.externalId && d.externalId === existingId) return
  throw new ProviderError(
    'ALREADY_EXISTS',
    `${what} already exists in Expo and was not created by the Hub. Adopt it instead of creating it.`
  )
}

function appIdOf(desired: DesiredResource): string {
  const id = desired.refs.project
  if (typeof id !== 'string' || !id)
    throw new ProviderError('EXPO_REF_UNRESOLVED', 'The project has not been created yet.')
  return id
}

function branchIdOf(ref: string | string[] | null | undefined): string | null {
  return typeof ref === 'string' && ref ? splitId(ref).id : null
}

function mapping(branchId: string): string {
  return JSON.stringify({ version: 0, data: [{ branchId, branchMappingLogic: 'true' }] })
}

/** The branch id a channel's branchMapping points at (the first rule), or null. */
function pointedBranch(raw: unknown): string | null {
  try {
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw
    const rules = (m as { data?: Array<{ branchId?: string; branchMappingLogic?: unknown }> })?.data
    const rule = rules?.find((r) => r.branchMappingLogic === 'true') ?? rules?.[0]
    return rule?.branchId ?? null
  } catch {
    return null
  }
}

// ── Mapping provider rows to Observed ──

function mapProject(row: any): Observed {
  return {
    type: 'expo.project',
    externalId: String(row.id),
    name: row.slug ?? row.name ?? null,
    fields: {
      name: row.slug ?? row.name ?? null,
      privacy: row.privacy ? String(row.privacy).toLowerCase() : null,
      account:
        String(row.fullName ?? '')
          .split('/')[0]
          ?.replace(/^@/, '') || null
    },
    tags: {},
    url: row.fullName ? `${SITE}/${row.fullName}` : null
  }
}

function mapBranch(appId: string, row: any): Observed {
  return {
    type: 'expo.branch',
    externalId: composeId(appId, String(row.id)),
    name: row.name ?? null,
    fields: { project: appId, name: row.name ?? null },
    tags: {}
  }
}

function mapChannel(appId: string, row: any): Observed {
  const branch = pointedBranch(row.branchMapping)
  return {
    type: 'expo.channel',
    externalId: composeId(appId, String(row.id)),
    name: row.name ?? null,
    fields: {
      project: appId,
      name: row.name ?? null,
      branch: branch ? composeId(appId, branch) : null
    },
    tags: {}
  }
}

function mapEnvVar(appId: string, row: any): Observed {
  return {
    type: 'expo.env_var',
    externalId: composeId(appId, String(row.id)),
    name: row.name ?? null,
    // The value is never read back (write-only).
    fields: {
      project: appId,
      name: row.name ?? null,
      visibility: row.visibility ? String(row.visibility).toLowerCase() : null,
      environments: strList(row.environments).map((e) => e.toLowerCase())
    },
    tags: {}
  }
}

function mapBuild(appId: string, row: any): Observed {
  return {
    type: 'expo.build',
    externalId: composeId(appId, String(row.id)),
    name: row.buildProfile ?? null,
    fields: {
      project: appId,
      platform: row.platform ? String(row.platform).toLowerCase() : null,
      profile: row.buildProfile ?? null,
      gitRef: row.gitCommitHash ?? null
    },
    tags: {},
    status: row.status ? String(row.status).toLowerCase() : null
  }
}

// ── Reads ──

async function readProject(ctx: ProviderContext, appId: string): Promise<Observed | null> {
  try {
    const d = await gql(ctx, Q.Q_APP_BY_ID, { id: appId })
    if (!d.app?.byId) return null
    const o = mapProject(d.app.byId)
    // The connection is pinned to one account: an app of another account is out of reach.
    if (String(o.fields.account ?? '').toLowerCase() !== account(ctx).toLowerCase())
      throw new ProviderError(
        'EXPO_OUT_OF_ACCOUNT',
        `That project is not in account ${account(ctx)}.`
      )
    return o
  } catch (err) {
    if (isGone(err)) return null
    throw err
  }
}

async function projectByName(ctx: ProviderContext, slug: string): Promise<Observed | null> {
  try {
    const d = await gql(ctx, Q.Q_APP_BY_FULL_NAME, { fullName: `@${account(ctx)}/${slug}` })
    return d.app?.byFullName ? mapProject(d.app.byFullName) : null
  } catch (err) {
    if (isGone(err)) return null
    throw err
  }
}

/** true = the app exists in the pinned account; false = gone; throws EXPO_OUT_OF_ACCOUNT. */
async function guardApp(ctx: ProviderContext, appId: string): Promise<boolean> {
  return (await readProject(ctx, appId)) !== null
}

async function requireApp(ctx: ProviderContext, appId: string): Promise<void> {
  if (!(await guardApp(ctx, appId)))
    throw new ProviderError('EXPO_NOT_FOUND', 'The project is gone.')
}

async function branchRows(ctx: ProviderContext, appId: string): Promise<any[]> {
  return pageAll(async (offset, limit) => {
    const d = await gql(ctx, Q.Q_BRANCHES, { appId, offset, limit })
    return d.app?.byId?.updateBranches ?? []
  })
}

async function channelRows(ctx: ProviderContext, appId: string): Promise<any[]> {
  return pageAll(async (offset, limit) => {
    const d = await gql(ctx, Q.Q_CHANNELS, { appId, offset, limit })
    return d.app?.byId?.updateChannels ?? []
  })
}

async function envVarRows(ctx: ProviderContext, appId: string): Promise<any[]> {
  const d = await gql(ctx, Q.Q_ENV_VARS, { appId })
  return d.app?.byId?.environmentVariables ?? []
}

async function buildRows(ctx: ProviderContext, appId: string): Promise<any[]> {
  return pageAll(
    async (offset, limit) => {
      const d = await gql(ctx, Q.Q_BUILDS, { appId, offset, limit })
      return d.app?.byId?.builds ?? []
    },
    50,
    4
  )
}

async function observeType(
  ctx: ProviderContext,
  type: string,
  externalId: string
): Promise<Observed | null> {
  if (type === 'expo.project') return readProject(ctx, externalId)
  const { appId, id } = splitId(externalId)
  if (!(await guardApp(ctx, appId))) return null
  try {
    if (type === 'expo.branch') {
      const row = (await branchRows(ctx, appId)).find((r) => String(r.id) === id)
      return row ? mapBranch(appId, row) : null
    }
    if (type === 'expo.channel') {
      const row = (await channelRows(ctx, appId)).find((r) => String(r.id) === id)
      return row ? mapChannel(appId, row) : null
    }
    if (type === 'expo.env_var') {
      const row = (await envVarRows(ctx, appId)).find((r) => String(r.id) === id)
      return row ? mapEnvVar(appId, row) : null
    }
    if (type === 'expo.build') {
      const d = await gql(ctx, Q.Q_BUILD, { id })
      const row = d.builds?.byId
      if (!row) return null
      if (row.app?.id && String(row.app.id) !== appId)
        throw new ProviderError('EXPO_OUT_OF_ACCOUNT', 'That build belongs to another project.')
      return mapBuild(appId, row)
    }
  } catch (err) {
    if (isGone(err)) return null
    throw err
  }
  throw new ProviderError('EXPO_UNKNOWN_TYPE', `Expo has no resource type ${type}.`)
}

// ── Plan ──

function normalizeSecret(v: unknown): SecretValue | null {
  return v && typeof v === 'object' && 'fingerprint' in (v as object) ? (v as SecretValue) : null
}

function changesFor(
  type: string,
  desired: DesiredResource,
  observed: Observed
): { changes: FieldChange[]; preconditions: Record<string, unknown> } {
  const spec = EXPO_TYPES.find((t) => t.key === type)
  const changes: FieldChange[] = []
  const preconditions: Record<string, unknown> = {}
  for (const f of spec?.fields ?? ([] as FieldSpec[])) {
    if (f.readOnly || (f.createOnly && !f.replaceOnChange)) continue
    if (f.kind === 'secret') {
      if (normalizeSecret(desired.fields[f.key])?.changed)
        changes.push({ field: f.key, secret: true })
      continue
    }
    const wanted = f.key in desired.fields ? desired.fields[f.key] : undefined
    if (wanted === undefined || wanted === null) continue
    const to = f.kind === 'ref' ? (desired.refs[f.key] ?? null) : wanted
    const from = observed.fields[f.key] ?? null
    if (!sameValue(from, to)) {
      changes.push({ field: f.key, from, to })
      preconditions[f.key] = from
    }
  }
  return { changes, preconditions }
}

const expoSpec = (type: string) => EXPO_TYPES.find((t) => t.key === type)
const expoLabel = (type: string) => expoSpec(type)?.label ?? type

function planOps(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired && !observed) return []
  if (!desired && observed) {
    return [
      {
        kind: 'delete',
        type: observed.type,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Delete ${typedName(expoLabel(observed.type), observed.name ?? observed.externalId)}.`,
        changes: [],
        preconditions: { name: observed.name },
        risk: []
      }
    ]
  }
  const d = desired as DesiredResource
  if (!observed) {
    return [
      {
        kind: 'create',
        type: d.type,
        resourceId: d.resourceId,
        externalId: null,
        reason:
          d.type === 'expo.build'
            ? 'Start a build.'
            : `Create ${typedName(expoLabel(d.type), String(d.fields.name ?? ''))}. If one with this name already exists in Expo the change stops with ALREADY_EXISTS: adopt it instead.`,
        changes: EXPO_TYPES.find((t) => t.key === d.type)!.fields.flatMap((f): FieldChange[] => {
          if (f.readOnly) return []
          if (f.kind === 'secret')
            return normalizeSecret(d.fields[f.key]) ? [{ field: f.key, secret: true }] : []
          const to = f.kind === 'ref' ? (d.refs[f.key] ?? null) : d.fields[f.key]
          return to === undefined || to === null ? [] : [{ field: f.key, to }]
        }),
        preconditions: {},
        risk: [],
        ...(d.type === 'expo.build'
          ? {
              action: 'build',
              data: {
                platform: d.fields.platform,
                profile: d.fields.profile,
                gitRef: d.fields.gitRef ?? null
              }
            }
          : {})
      }
    ]
  }
  // A build is read-only once it exists.
  if (d.type === 'expo.build') return [{ ...noop(d, observed) }]
  const spec = EXPO_TYPES.find((t) => t.key === d.type)!
  const { changes, preconditions } = changesFor(d.type, d, observed)
  if (changes.length === 0) return [noop(d, observed)]
  const replaces = changes.some((c) => spec.fields.find((f) => f.key === c.field)?.replaceOnChange)
  if (replaces)
    return [
      {
        kind: 'replace',
        type: d.type,
        resourceId: d.resourceId,
        externalId: observed.externalId,
        reason: `Replace ${typedName(expoLabel(d.type), observed.name ?? observed.externalId)}: ${fieldWords(spec.fields, changes)} cannot change in place.`,
        changes,
        preconditions,
        risk: []
      }
    ]
  const onlyBranch = d.type === 'expo.channel' && changes.every((c) => c.field === 'branch')
  return [
    {
      kind: 'update',
      type: d.type,
      resourceId: d.resourceId,
      externalId: observed.externalId,
      reason: onlyBranch
        ? `Point ${typedName(expoLabel(d.type), observed.name)} at another branch.`
        : `Change ${fieldWords(spec.fields, changes)} on ${typedName(expoLabel(d.type), observed.name ?? observed.externalId)}.`,
      changes,
      preconditions,
      risk: [],
      ...(onlyBranch ? { action: 'point' } : {})
    }
  ]
}

function noop(d: DesiredResource, observed: Observed): PlannedOp {
  return {
    kind: 'noop',
    type: d.type,
    resourceId: d.resourceId,
    externalId: observed.externalId,
    reason: `${typedName(expoLabel(d.type), observed.name ?? observed.externalId)} is up to date.`,
    changes: [],
    preconditions: {},
    risk: []
  }
}

// ── Apply ──

const done = (externalId: string | null, observed: Observed | null, answer?: object): OpResult => ({
  ok: true,
  externalId,
  observed,
  ...(answer ? { answer: answer as Record<string, unknown> } : {})
})

async function createProject(ctx: ProviderContext, d: DesiredResource): Promise<OpResult> {
  const slug = String(d.fields.name ?? '')
  const existing = await projectByName(ctx, slug)
  if (existing) {
    refuseUnlessResumed(d, existing.externalId, `Project ${slug}`)
    return done(existing.externalId, existing, { existed: true })
  }
  const acc = await gql(ctx, Q.Q_ACCOUNT, { name: account(ctx) })
  const accountId = acc.account?.byName?.id
  if (!accountId)
    throw new ProviderError('EXPO_ACCOUNT_NOT_FOUND', `Account ${account(ctx)} is not reachable.`)
  const out = await gql(ctx, Q.M_CREATE_APP, {
    input: { accountId, projectName: slug, privacy: String(d.fields.privacy ?? 'unlisted') }
  })
  const row = out.app?.createApp
  if (!row?.id) throw new ProviderError('EXPO_BAD_ANSWER', 'Expo did not return the new project.')
  return done(String(row.id), mapProject(row))
}

async function createBranch(ctx: ProviderContext, d: DesiredResource): Promise<OpResult> {
  const appId = appIdOf(d)
  await requireApp(ctx, appId)
  const name = String(d.fields.name ?? '')
  const existing = (await branchRows(ctx, appId)).find((r) => r.name === name)
  if (existing) {
    const o = mapBranch(appId, existing)
    refuseUnlessResumed(d, o.externalId, `Branch ${name}`)
    return done(o.externalId, o, { existed: true })
  }
  const out = await gql(ctx, Q.M_CREATE_BRANCH, { appId, name })
  const row = out.updateBranch?.createUpdateBranchForApp
  if (!row?.id) throw new ProviderError('EXPO_BAD_ANSWER', 'Expo did not return the new branch.')
  const o = mapBranch(appId, row)
  return done(o.externalId, o)
}

async function createChannel(ctx: ProviderContext, d: DesiredResource): Promise<OpResult> {
  const appId = appIdOf(d)
  await requireApp(ctx, appId)
  const name = String(d.fields.name ?? '')
  const branchId = branchIdOf(d.refs.branch)
  const existing = (await channelRows(ctx, appId)).find((r) => r.name === name)
  let row = existing
  let created = false
  if (!row) {
    const out = await gql(ctx, Q.M_CREATE_CHANNEL, {
      appId,
      name,
      branchMapping: branchId ? mapping(branchId) : null
    })
    row = out.updateChannel?.createUpdateChannelForApp
    created = true
  }
  if (!row?.id) throw new ProviderError('EXPO_BAD_ANSWER', 'Expo did not return the new channel.')
  if (!created) refuseUnlessResumed(d, composeId(appId, String(row.id)), `Channel ${name}`)
  if (!created && branchId && pointedBranch(row.branchMapping) !== branchId) {
    const out = await gql(ctx, Q.M_POINT_CHANNEL, { id: row.id, branchMapping: mapping(branchId) })
    row = out.updateChannel?.editUpdateChannel ?? row
  }
  const o = mapChannel(appId, row)
  return done(o.externalId, o, created ? undefined : { existed: true })
}

/** Runs a call that carries a plain secret; masks that value in any error Expo echoes back. */
async function scrubbing<T>(secret: SecretValue | null, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof ProviderError && secret?.plain)
      err.message = scrubValues(err.message, [secret.plain])
    throw err
  }
}

function envInput(d: DesiredResource): Record<string, unknown> {
  const secret = normalizeSecret(d.fields.value)
  return {
    name: String(d.fields.name ?? ''),
    visibility: String(d.fields.visibility ?? 'secret').toUpperCase(),
    environments: strList(d.fields.environments).map((e) => e.toUpperCase()),
    ...(secret?.plain !== undefined ? { value: secret.plain } : {})
  }
}

async function upsertEnvVar(
  ctx: ProviderContext,
  d: DesiredResource,
  knownId?: string
): Promise<OpResult> {
  const appId = appIdOf(d)
  await requireApp(ctx, appId)
  const name = String(d.fields.name ?? '')
  const rows = await envVarRows(ctx, appId)
  const existing = knownId
    ? rows.find((r) => String(r.id) === knownId)
    : rows.find((r) => r.name === name)
  // Create-time match: never update (or downgrade a secret to plain) a variable the Hub did not make.
  if (existing && !knownId)
    refuseUnlessResumed(d, composeId(appId, String(existing.id)), `Variable ${name}`)
  const input = envInput(d)
  const secret = normalizeSecret(d.fields.value)
  if (!existing) {
    if (!('value' in input))
      throw new ProviderError('EXPO_VALUE_REQUIRED', 'A new variable needs a value.')
    const out = await scrubbing(secret, () => gql(ctx, Q.M_CREATE_ENV_VAR, { appId, input }))
    const row = out.environmentVariable?.createEnvironmentVariableForApp
    if (!row?.id) throw new ProviderError('EXPO_BAD_ANSWER', 'Expo did not return the variable.')
    const o = mapEnvVar(appId, row)
    return done(o.externalId, o)
  }
  const current = mapEnvVar(appId, existing)
  const sameShape =
    sameValue(current.fields.visibility, String(d.fields.visibility ?? 'secret').toLowerCase()) &&
    sameValue(current.fields.environments, d.fields.environments)
  if (sameShape && !('value' in input)) return done(current.externalId, current, { existed: true })
  const { name: _name, ...rest } = input
  const out = await scrubbing(secret, () =>
    gql(ctx, Q.M_UPDATE_ENV_VAR, { input: { id: existing.id, ...rest } })
  )
  const row = out.environmentVariable?.updateEnvironmentVariable ?? existing
  const o = mapEnvVar(appId, { ...existing, ...row })
  return done(o.externalId, o)
}

async function triggerBuild(
  ctx: ProviderContext,
  op: PlannedOp,
  d: DesiredResource
): Promise<OpResult> {
  // Read-before-write: a build this resource already started is never started twice.
  if (d.externalId) {
    if (d.refs.project && splitId(d.externalId).appId !== d.refs.project)
      throw new ProviderError('TARGET_MISMATCH', 'The build belongs to another project.')
    const o = await observeType(ctx, 'expo.build', d.externalId)
    if (o) return done(o.externalId, o, { existed: true })
  }
  const appId = appIdOf(d)
  await requireApp(ctx, appId)
  const data = (op.data ?? {}) as Record<string, unknown>
  if (
    (data.platform ?? null) !== (d.fields.platform ?? null) ||
    (data.profile ?? null) !== (d.fields.profile ?? null) ||
    (data.gitRef ?? null) !== (d.fields.gitRef ?? null)
  )
    throw new ProviderError('TARGET_MISMATCH', 'The build request does not match the planned one.')
  const out = await gql(ctx, Q.M_TRIGGER_BUILD, {
    appId,
    platform: String(d.fields.platform ?? '').toUpperCase(),
    profile: String(d.fields.profile ?? ''),
    gitRef: str(d.fields.gitRef)
  })
  const row = out.build?.triggerBuildFromGit
  if (!row?.id) throw new ProviderError('EXPO_BAD_ANSWER', 'Expo did not return the build.')
  const o = mapBuild(appId, row)
  return done(o.externalId, o)
}

async function pointChannel(
  ctx: ProviderContext,
  op: PlannedOp,
  d: DesiredResource
): Promise<OpResult> {
  const { appId, id } = splitId(String(op.externalId))
  const project = typeof d.refs.project === 'string' ? d.refs.project : null
  const branchRef = typeof d.refs.branch === 'string' ? d.refs.branch : null
  if (
    d.type !== 'expo.channel' ||
    project !== appId ||
    (d.externalId && d.externalId !== op.externalId) ||
    (branchRef && splitId(branchRef).appId !== appId)
  )
    throw new ProviderError(
      'TARGET_MISMATCH',
      'The channel or branch is not in the project this change is for.'
    )
  await requireApp(ctx, appId)
  const row = (await channelRows(ctx, appId)).find((r) => String(r.id) === id)
  if (!row) throw new ProviderError('EXPO_NOT_FOUND', 'The channel is gone.')
  const target = branchIdOf(d.refs.branch)
  if (!target)
    throw new ProviderError('EXPO_REF_UNRESOLVED', 'The branch has not been created yet.')
  if (pointedBranch(row.branchMapping) === target) {
    const o = mapChannel(appId, row)
    return done(o.externalId, o, { existed: true })
  }
  const out = await gql(ctx, Q.M_POINT_CHANNEL, { id, branchMapping: mapping(target) })
  const o = mapChannel(appId, out.updateChannel?.editUpdateChannel ?? row)
  return done(o.externalId, o)
}

async function remove(ctx: ProviderContext, type: string, externalId: string): Promise<OpResult> {
  if (type === 'expo.project') {
    if (await readProject(ctx, externalId)) await gql(ctx, Q.M_DELETE_APP, { id: externalId })
    return done(externalId, null)
  }
  const { id } = splitId(externalId)
  if (!(await observeType(ctx, type, externalId))) return done(externalId, null)
  if (type === 'expo.branch') await gql(ctx, Q.M_DELETE_BRANCH, { id })
  else if (type === 'expo.channel') await gql(ctx, Q.M_DELETE_CHANNEL, { id })
  else if (type === 'expo.env_var') await gql(ctx, Q.M_DELETE_ENV_VAR, { id })
  else throw new ProviderError('EXPO_READ_ONLY', 'Builds cannot be deleted here.')
  return done(externalId, null)
}

function createFor(ctx: ProviderContext, op: PlannedOp, d: DesiredResource): Promise<OpResult> {
  switch (d.type) {
    case 'expo.project':
      return createProject(ctx, d)
    case 'expo.branch':
      return createBranch(ctx, d)
    case 'expo.channel':
      return createChannel(ctx, d)
    case 'expo.env_var':
      return upsertEnvVar(ctx, d)
    case 'expo.build':
      return triggerBuild(ctx, op, d)
    default:
      throw new ProviderError('EXPO_UNKNOWN_TYPE', `Expo has no resource type ${d.type}.`)
  }
}

// ── List ──

const PROJECT_PAGE = 10

async function listProjects(ctx: ProviderContext, offset: number, limit: number): Promise<any[]> {
  const d = await gql(ctx, Q.Q_ACCOUNT_APPS, { name: account(ctx), offset, limit })
  return d.account?.byName?.apps ?? []
}

async function listType(
  ctx: ProviderContext,
  type: string,
  cursor?: string | null
): Promise<ListPage> {
  const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0
  const apps = await listProjects(ctx, offset, PROJECT_PAGE)
  const next = apps.length === PROJECT_PAGE ? String(offset + PROJECT_PAGE) : null
  if (type === 'expo.project') return { items: apps.map(mapProject), cursor: next }
  const items: Observed[] = []
  for (const app of apps) {
    const appId = String(app.id)
    if (type === 'expo.branch')
      items.push(...(await branchRows(ctx, appId)).map((r) => mapBranch(appId, r)))
    else if (type === 'expo.channel')
      items.push(...(await channelRows(ctx, appId)).map((r) => mapChannel(appId, r)))
    else if (type === 'expo.env_var')
      items.push(...(await envVarRows(ctx, appId)).map((r) => mapEnvVar(appId, r)))
    else if (type === 'expo.build')
      items.push(...(await buildRows(ctx, appId)).map((r) => mapBuild(appId, r)))
    else throw new ProviderError('EXPO_UNKNOWN_TYPE', `Expo has no resource type ${type}.`)
  }
  return { items, cursor: next }
}

// ── The adapter ──

export const expoAdapter: ProviderAdapter = {
  key: 'expo',
  label: 'Expo (EAS)',
  connection: {
    fields: [
      {
        key: 'account',
        label: 'Expo account',
        kind: 'string',
        required: true,
        help: 'The account name every project, channel and variable is pinned to.'
      },
      {
        key: 'token',
        label: 'Robot access token',
        kind: 'string',
        secret: true,
        required: true,
        help: 'Create a robot in the Expo account settings and give it the Developer role.'
      }
    ],
    hosts: () => ['api.expo.dev'],
    describe: (c) => `Expo ${String(c.account ?? '')}`,
    validate: (config, secrets) => {
      const problems: string[] = []
      if (!str(config.account)) problems.push('Name the Expo account.')
      else if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(String(config.account)))
        problems.push('The account name has characters Expo does not allow.')
      if (!str(secrets.token)) problems.push('The robot access token is required.')
      return problems
    }
  },
  types: EXPO_TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    let who: any
    try {
      who = (await gql(ctx, Q.Q_WHOAMI)).meActor
    } catch (err) {
      if (
        err instanceof ProviderError &&
        ['AUTH_FAILED', 'EXPO_AUTH', 'EXPO_GRAPHQL'].includes(err.code)
      )
        return {
          ok: false,
          identity: null,
          permissions: [],
          missing: ['A working access token'],
          message: err.message
        }
      throw err
    }
    const names: string[] = (who?.accounts ?? []).map((a: any) => String(a.name))
    const reaches = names.some((n) => n.toLowerCase() === account(ctx).toLowerCase())
    const need = `Access to account ${account(ctx)}`
    const permissions = [
      { type: '*', need, has: reaches },
      ...EXPO_TYPE_KEYS.map((type) => ({
        type,
        need:
          type === 'expo.build'
            ? `Build access on ${account(ctx)}`
            : `Developer role on ${account(ctx)}`,
        has: reaches
      }))
    ]
    return {
      ok: reaches,
      identity: `${who?.__typename === 'Robot' ? 'robot' : 'user'} ${names.join(', ') || String(who?.id ?? '')}`,
      permissions,
      missing: permissions.filter((p) => !p.has).map((p) => p.need),
      ...(reaches ? {} : { message: `The token cannot reach account ${account(ctx)}.` })
    }
  },

  observe: observeType,
  list: listType,
  plan: (_ctx, desired, observed) => planOps(desired, observed),

  /** Plan time: what a create would collide with, by project slug / branch, channel or variable name. */
  async findExisting(ctx, type, desired): Promise<Observed | null> {
    try {
      if (type === 'expo.project')
        return await projectByName(ctx, String(desired.fields.name ?? ''))
      if (type !== 'expo.branch' && type !== 'expo.channel' && type !== 'expo.env_var') return null
      const appId = appIdOf(desired)
      await requireApp(ctx, appId)
      const name = String(desired.fields.name ?? '')
      if (type === 'expo.branch') {
        const row = (await branchRows(ctx, appId)).find((r) => r.name === name)
        return row ? mapBranch(appId, row) : null
      }
      if (type === 'expo.channel') {
        const row = (await channelRows(ctx, appId)).find((r) => r.name === name)
        return row ? mapChannel(appId, row) : null
      }
      const row = (await envVarRows(ctx, appId)).find((r) => r.name === name)
      return row ? mapEnvVar(appId, row) : null
    } catch (err) {
      // A parent made in the same change has no id yet, so nothing can collide yet.
      if (
        err instanceof ProviderError &&
        ['EXPO_REF_UNRESOLVED', 'EXPO_NOT_FOUND'].includes(err.code)
      )
        return null
      throw err
    }
  },

  async apply(ctx, op, desired): Promise<OpResult> {
    try {
      if (op.kind === 'noop') return done(op.externalId, null)
      if (op.kind === 'delete') return await remove(ctx, op.type, String(op.externalId))
      if (!desired) throw new ProviderError('EXPO_NO_DESIRED', 'The change has no wanted state.')
      if (op.kind === 'create') return await createFor(ctx, op, desired)
      if (op.kind === 'replace') {
        await remove(ctx, op.type, String(op.externalId))
        return await createFor(ctx, { ...op, kind: 'create' }, { ...desired, externalId: null })
      }
      // update
      if (op.action === 'point') return await pointChannel(ctx, op, desired)
      if (desired.type === 'expo.env_var')
        return await upsertEnvVar(ctx, desired, splitId(String(op.externalId)).id)
      if (desired.type === 'expo.channel') return await pointChannel(ctx, op, desired)
      if (desired.type === 'expo.project') {
        // Privacy is not editable through the API surface this adapter uses.
        const o = await readProject(ctx, String(op.externalId))
        return done(op.externalId, o, { unchanged: true })
      }
      throw new ProviderError('EXPO_READ_ONLY', `${desired.type} cannot be updated.`)
    } catch (err) {
      if (err instanceof ProviderError) {
        err.message = ctx.scrub(err.message)
        throw err
      }
      throw new ProviderError('EXPO_ERROR', ctx.scrub(String((err as Error)?.message ?? err)))
    }
  }
}
