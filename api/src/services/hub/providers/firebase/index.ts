import { fieldWords, typedName } from '../plan-words.js'
import {
  type ConnectionTest,
  type DesiredResource,
  type FieldChange,
  type FieldSpec,
  type HealthAnswer,
  type ListPage,
  type Observed,
  type OpResult,
  type PlannedOp,
  type ProviderAdapter,
  type ProviderContext,
  ProviderError,
  type ResourceTypeSpec,
  type RiskFlag,
  ROTATE_OUTPUTS_FIELD
} from '../types.js'
import {
  appSeg,
  emailSeg,
  FCM_ORIGIN,
  FIREBASE_ORIGIN,
  googleCall,
  IAM_ORIGIN,
  keyIdSeg,
  PROJECT_RE,
  parseServiceAccount,
  pinnedProject,
  projectSeg,
  SA_EMAIL_RE
} from './client.js'

/**
 * Firebase (`firebase`): a Google service-account key (JSON, sealed) pinned to ONE Google Cloud
 * project (`projectId`). The key is exchanged for an OAuth token by an RS256 JWT; hosts are
 * `firebase.googleapis.com`, `oauth2.googleapis.com`, `iam.googleapis.com`, `fcm.googleapis.com`.
 * Every project path is built from the pin, and any other project is refused
 * (`FIREBASE_OUT_OF_PROJECT`).
 *
 * Types:
 *  - `firebase.project` (shared): add Firebase to the pinned Google Cloud project, or adopt it
 *    when it already has Firebase. Firebase cannot be removed from a project here (no delete).
 *  - `firebase.android_app` / `firebase.ios_app` / `firebase.web_app` (app): the app's config file
 *    comes out as the `config_file` output (not secret) with its `config_filename`.
 *  - `firebase.fcm_service_account` (app): a NEW key for an existing service account that already
 *    holds a Firebase Cloud Messaging send role. The key JSON is shown once (`service_account_json`,
 *    once-only); a lost value is rotated, never re-read. The Hub grants no roles.
 *
 * Nothing here is priced (Firebase's free tier covers these), so no type has a `costClass`.
 * Push for the phone app: services/phone-push.ts sends through the Expo service; the FCM key is
 * handed out so it can be uploaded to Expo's push credentials. The framework's bindings reach
 * stack settings, stack secrets and the app-setting allow-list only; there is no Expo target yet.
 */

const T_PROJECT = 'firebase.project'
const T_ANDROID = 'firebase.android_app'
const T_IOS = 'firebase.ios_app'
const T_WEB = 'firebase.web_app'
const T_FCM = 'firebase.fcm_service_account'

const PAGE = 100
const MAX_ACCOUNTS = 25
const OP_TRIES = 8
const OP_WAIT_MS = 1500

// ── Small helpers ──

function norm(v: unknown): unknown {
  return v === '' || v === undefined ? null : v
}

function diffFields(
  keys: string[],
  want: Record<string, unknown>,
  have: Record<string, unknown>
): FieldChange[] {
  const out: FieldChange[] = []
  for (const k of keys) {
    if (want[k] === undefined) continue
    if (norm(want[k]) !== norm(have[k]))
      out.push({ field: k, from: norm(have[k]), to: norm(want[k]) })
  }
  return out
}

const ok = (
  externalId: string | null,
  observed: Observed | null,
  answer?: Record<string, unknown>,
  outputs?: Record<string, string>
): OpResult => ({
  ok: true,
  externalId,
  observed,
  ...(answer ? { answer } : {}),
  ...(outputs && Object.keys(outputs).length ? { outputs } : {})
})

const invalid = (msg: string) => new ProviderError('INVALID_FIELDS', msg)

function alreadyExists(what: string): ProviderError {
  return new ProviderError(
    'ALREADY_EXISTS',
    `${what} already exists in Firebase. Adopt it instead of creating it.`,
    { retryable: false }
  )
}

function unknownType(type: unknown): ProviderError {
  return new ProviderError('UNKNOWN_TYPE', `Firebase has no ${String(type)}.`)
}

function outOfProject(what: string): ProviderError {
  return new ProviderError(
    'FIREBASE_OUT_OF_PROJECT',
    `${what} is not in the Google Cloud project this connection is pinned to.`
  )
}

function mismatch(op: PlannedOp, desired: DesiredResource | null): void {
  if (desired?.externalId && op.externalId && desired.externalId !== op.externalId)
    throw new ProviderError(
      'TARGET_MISMATCH',
      'This step is for a different Firebase resource than the one it was planned for.'
    )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Waits (bounded) for a long-running operation; not done in time = a retryable error. */
async function waitOp(ctx: ProviderContext, first: any): Promise<any> {
  let op = first
  for (let i = 0; i < OP_TRIES; i++) {
    if (op?.done === true) {
      if (op.error)
        throw new ProviderError(
          'PROVIDER_REJECTED',
          ctx.scrub(`Firebase refused it: ${String(op.error.message ?? 'unknown')}`.slice(0, 300))
        )
      return op.response ?? {}
    }
    const name = String(op?.name ?? '')
    if (!/^(projects\/[a-z0-9-]{5,30}\/)?operations\/[A-Za-z0-9._-]{1,200}$/.test(name))
      throw new ProviderError(
        'PROVIDER_REJECTED',
        'Firebase did not return an operation to follow.'
      )
    await sleep(OP_WAIT_MS)
    op = (await googleCall(ctx, FIREBASE_ORIGIN, 'GET', `/v1beta1/${name}`)).body
  }
  throw new ProviderError(
    'OPERATION_PENDING',
    'Firebase is still working on it. Run it again in a minute; it will pick up where it left off.',
    { retryable: true }
  )
}

// ═══ Project ═══

const PROJECT_LABEL = 'Firebase project'

function projectObserved(p: any): Observed {
  const id = String(p.projectId)
  return {
    type: T_PROJECT,
    externalId: id,
    name: p.displayName ?? id,
    fields: {
      project_id: id,
      display_name: p.displayName ?? null,
      project_number: p.projectNumber ?? null
    },
    tags: {},
    version: null,
    status: p.state ?? null,
    url: `https://console.firebase.google.com/project/${id}`
  }
}

async function readProject(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const pin = pinnedProject(ctx)
  if (projectSeg(id) !== pin) return null
  // Only 404 means "not there"; a 403 is a permission problem and must be told, not read as gone.
  const r = await googleCall(ctx, FIREBASE_ORIGIN, 'GET', `/v1beta1/projects/${pin}`, {
    allow: [404]
  })
  if (r.status === 404 || !r.body?.projectId) return null
  if (String(r.body.projectId) !== pin || r.body.state === 'DELETED') return null
  return projectObserved(r.body)
}

const PROJECT_FIELDS: FieldSpec[] = [
  {
    key: 'project_id',
    label: 'Google Cloud project',
    kind: 'string',
    required: true,
    createOnly: true,
    replaceOnChange: true,
    pattern: PROJECT_RE.source,
    help: 'Must be the project the connection is pinned to. The Hub adds Firebase to it, or adopts it when Firebase is already there.'
  },
  { key: 'display_name', label: 'Display name', kind: 'string' },
  { key: 'project_number', label: 'Project number', kind: 'string', readOnly: true }
]
const projectWords = (c: Array<{ field: string }>) => fieldWords(PROJECT_FIELDS, c)

function planProject(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    throw new ProviderError(
      'NOT_SUPPORTED',
      'Firebase cannot be removed from a Google Cloud project from here. Stop managing it in the Hub instead.'
    )
  }
  if (String(desired.fields.project_id ?? '') !== pinnedProject(ctx))
    throw outOfProject(`The project ${String(desired.fields.project_id ?? '')}`)
  if (!observed)
    return [
      {
        kind: 'create',
        type: T_PROJECT,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Add Firebase to the Google Cloud project ${String(desired.fields.project_id)}. It cannot be taken off again from here.`,
        changes: [{ field: 'project_id', to: desired.fields.project_id }],
        preconditions: {},
        risk: []
      }
    ]
  const changes = diffFields(['display_name'], desired.fields, observed.fields)
  if (!changes.length) return []
  return [
    {
      kind: 'update',
      type: T_PROJECT,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${projectWords(changes)} on ${typedName(PROJECT_LABEL, observed.name)}.`,
      changes,
      preconditions: { display_name: observed.fields.display_name },
      risk: []
    }
  ]
}

async function applyProject(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const pin = pinnedProject(ctx)
  if (op.kind === 'delete' || op.kind === 'replace')
    throw new ProviderError('NOT_SUPPORTED', 'Firebase cannot be removed from a project from here.')
  if (!desired) throw invalid('Nothing to write.')
  if (String(desired.fields.project_id ?? '') !== pin)
    throw outOfProject(`The project ${String(desired.fields.project_id ?? '')}`)
  if (op.kind === 'create') {
    const have = await readProject(ctx, pin)
    if (have) {
      // Resumed create (the Hub recorded it) → fine; otherwise it was never ours to bind.
      if (desired.externalId === pin) return ok(pin, have, { already: 'exists' })
      throw alreadyExists(`Firebase in the project ${pin}`)
    }
    const r = await googleCall(
      ctx,
      FIREBASE_ORIGIN,
      'POST',
      `/v1beta1/projects/${pin}:addFirebase`,
      {
        body: {}
      }
    )
    await waitOp(ctx, r.body)
    const after = await readProject(ctx, pin)
    return ok(pin, after, { created: true })
  }
  mismatch(op, desired)
  const have = await readProject(ctx, op.externalId as string)
  if (!have)
    throw new ProviderError('NOT_FOUND', 'The Firebase project no longer exists.', { status: 404 })
  const diff = diffFields(['display_name'], desired.fields, have.fields)
  if (!diff.length) return ok(pin, have, { already: 'matches' })
  const name = String(diff[0].to ?? '').trim()
  if (!name) throw invalid('The display name cannot be empty.')
  await googleCall(ctx, FIREBASE_ORIGIN, 'PATCH', `/v1beta1/projects/${pin}`, {
    query: { updateMask: 'displayName' },
    body: { displayName: name }
  })
  return ok(pin, await readProject(ctx, pin), { changed: ['display_name'] })
}

// ═══ Apps (Android, iOS, Web) ═══

interface AppCfg {
  type: string
  label: string
  collection: string
  /** The identity field (package name / bundle id); null for web (identified by name). */
  idField: 'package_name' | 'bundle_id' | null
  apiIdField: 'packageName' | 'bundleId' | null
  extraField: 'app_store_id' | null
  fileName: string
  fields: FieldSpec[]
}

const commonOut = (label: string): FieldSpec[] => [
  { key: 'display_name', label: 'Display name', kind: 'string', required: true },
  { key: 'app_id', label: 'App id', kind: 'string', readOnly: true },
  { key: 'state', label: 'State', kind: 'string', readOnly: true }
]

const APPS: Record<string, AppCfg> = {
  [T_ANDROID]: {
    type: T_ANDROID,
    label: 'Firebase Android app',
    collection: 'androidApps',
    idField: 'package_name',
    apiIdField: 'packageName',
    extraField: null,
    fileName: 'google-services.json',
    fields: [
      {
        key: 'package_name',
        label: 'Package name',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        pattern: '^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$'
      },
      ...commonOut('Android')
    ]
  },
  [T_IOS]: {
    type: T_IOS,
    label: 'Firebase iOS app',
    collection: 'iosApps',
    idField: 'bundle_id',
    apiIdField: 'bundleId',
    extraField: 'app_store_id',
    fileName: 'GoogleService-Info.plist',
    fields: [
      {
        key: 'bundle_id',
        label: 'Bundle id',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        pattern: '^[A-Za-z0-9.-]{1,155}$'
      },
      { key: 'app_store_id', label: 'App Store id', kind: 'string', pattern: '^\\d{0,20}$' },
      ...commonOut('iOS')
    ]
  },
  [T_WEB]: {
    type: T_WEB,
    label: 'Firebase web app',
    collection: 'webApps',
    idField: null,
    apiIdField: null,
    extraField: null,
    fileName: 'firebase-config.json',
    fields: commonOut('web')
  }
}

function appObserved(cfg: AppCfg, a: any): Observed {
  const id = String(a.appId)
  const fields: Record<string, unknown> = {
    display_name: a.displayName ?? null,
    app_id: id,
    state: a.state ?? null
  }
  if (cfg.idField && cfg.apiIdField) fields[cfg.idField] = a[cfg.apiIdField] ?? null
  if (cfg.extraField) fields[cfg.extraField] = norm(a.appStoreId)
  return {
    type: cfg.type,
    externalId: id,
    name: a.displayName ?? (cfg.apiIdField ? a[cfg.apiIdField] : null) ?? id,
    fields,
    tags: {},
    version: null,
    status: a.state ?? null,
    url: `https://console.firebase.google.com/project/${pinnedProjectOf(a)}/settings/general`
  }
}

function pinnedProjectOf(a: any): string {
  const p = String(a?.projectId ?? '')
  return PROJECT_RE.test(p) ? p : ''
}

function appPath(ctx: ProviderContext, cfg: AppCfg, id?: string): string {
  const base = `/v1beta1/projects/${pinnedProject(ctx)}/${cfg.collection}`
  return id ? `${base}/${appSeg(id)}` : base
}

/** An app is only ever read under the pinned project; the answer's project is checked too. */
async function readApp(ctx: ProviderContext, cfg: AppCfg, id: string): Promise<Observed | null> {
  const r = await googleCall(ctx, FIREBASE_ORIGIN, 'GET', appPath(ctx, cfg, id), { allow: [404] })
  if (r.status === 404 || !r.body?.appId) return null
  if (String(r.body.projectId ?? pinnedProject(ctx)) !== pinnedProject(ctx)) return null
  if (r.body.state === 'DELETED') return null
  return appObserved(cfg, r.body)
}

async function listApps(
  ctx: ProviderContext,
  cfg: AppCfg,
  cursor: string | null
): Promise<{ rows: any[]; next: string | null }> {
  const r = await googleCall(ctx, FIREBASE_ORIGIN, 'GET', appPath(ctx, cfg), {
    query: { pageSize: PAGE, pageToken: cursor ?? undefined, showDeleted: 'false' }
  })
  const rows: any[] = Array.isArray(r.body?.apps) ? r.body.apps : []
  return {
    rows: rows.filter((a) => a?.appId && a.state !== 'DELETED'),
    next:
      typeof r.body?.nextPageToken === 'string' && r.body.nextPageToken
        ? r.body.nextPageToken
        : null
  }
}

async function findApp(
  ctx: ProviderContext,
  cfg: AppCfg,
  desired: DesiredResource
): Promise<Observed | null> {
  let cursor: string | null = null
  for (let i = 0; i < 20; i++) {
    const page = await listApps(ctx, cfg, cursor)
    for (const a of page.rows) {
      const hit = cfg.apiIdField
        ? String(a[cfg.apiIdField] ?? '') === String(desired.fields[cfg.idField as string] ?? '')
        : String(a.displayName ?? '') === String(desired.fields.display_name ?? '')
      if (hit) return appObserved(cfg, a)
    }
    if (!page.next) break
    cursor = page.next
  }
  return null
}

/** The app's config file: not a secret. Read through its own call, never kept in observed. */
async function appConfig(
  ctx: ProviderContext,
  cfg: AppCfg,
  id: string
): Promise<Record<string, string>> {
  const r = await googleCall(ctx, FIREBASE_ORIGIN, 'GET', `${appPath(ctx, cfg, id)}/config`, {
    allow: [404]
  })
  if (r.status === 404 || !r.body || typeof r.body !== 'object') return {}
  if (typeof r.body.configFileContents === 'string')
    return {
      config_file: Buffer.from(r.body.configFileContents, 'base64').toString('utf8'),
      config_filename: String(r.body.configFilename ?? cfg.fileName)
    }
  // The web app config is the JSON object itself.
  return { config_file: JSON.stringify(r.body), config_filename: cfg.fileName }
}

function appWords(cfg: AppCfg, c: Array<{ field: string }>): string {
  return fieldWords(cfg.fields, c)
}

function planApp(
  cfg: AppCfg,
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: cfg.type,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Remove ${typedName(cfg.label, observed.name)}. Firebase keeps a removed app for 30 days; the app stops getting Firebase services at once.`,
        changes: [],
        preconditions: { app_id: observed.fields.app_id },
        risk: []
      }
    ]
  }
  const name = String(desired.fields.display_name ?? '').trim()
  if (!name) throw invalid('The app needs a display name.')
  if (cfg.idField && !String(desired.fields[cfg.idField] ?? '').trim())
    throw invalid(
      `The app needs a ${cfg.idField === 'package_name' ? 'package name' : 'bundle id'}.`
    )
  if (!observed)
    return [
      {
        kind: 'create',
        type: cfg.type,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Register ${typedName(cfg.label, name)}. Its config file (${cfg.fileName}) comes out as the config_file output.`,
        changes: [
          { field: 'display_name', to: name },
          ...(cfg.idField ? [{ field: cfg.idField, to: desired.fields[cfg.idField] }] : [])
        ],
        preconditions: {},
        risk: []
      }
    ]
  if (cfg.idField) {
    const replace = diffFields([cfg.idField], desired.fields, observed.fields)
    if (replace.length)
      return [
        {
          kind: 'replace',
          type: cfg.type,
          resourceId: desired.resourceId,
          externalId: observed.externalId,
          reason: `Replace ${typedName(cfg.label, observed.name)}: ${appWords(cfg, replace)} cannot change in place, so the old app is removed and a new one is registered.`,
          changes: replace,
          preconditions: { app_id: observed.fields.app_id },
          risk: []
        }
      ]
  }
  const keys = ['display_name', ...(cfg.extraField ? [cfg.extraField] : [])]
  const changes = diffFields(keys, { ...desired.fields, display_name: name }, observed.fields)
  if (!changes.length) return []
  const pre: Record<string, unknown> = {}
  for (const c of changes) pre[c.field] = c.from ?? null
  return [
    {
      kind: 'update',
      type: cfg.type,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${appWords(cfg, changes)} on ${typedName(cfg.label, observed.name)}.`,
      changes,
      preconditions: pre,
      risk: []
    }
  ]
}

async function createApp(
  ctx: ProviderContext,
  cfg: AppCfg,
  desired: DesiredResource
): Promise<OpResult> {
  const name = String(desired.fields.display_name ?? '').trim()
  if (!name) throw invalid('The app needs a display name.')
  if (desired.externalId) {
    const have = await readApp(ctx, cfg, desired.externalId)
    if (have)
      return ok(
        have.externalId,
        have,
        { already: 'exists' },
        await appConfig(ctx, cfg, have.externalId)
      )
  }
  const hit = await findApp(ctx, cfg, desired)
  if (hit) throw alreadyExists(`${cfg.label} ${hit.name ?? ''}`.trim())
  const body: Record<string, unknown> = { displayName: name }
  if (cfg.apiIdField && cfg.idField)
    body[cfg.apiIdField] = String(desired.fields[cfg.idField]).trim()
  if (cfg.extraField && norm(desired.fields[cfg.extraField]) !== null)
    body.appStoreId = String(desired.fields[cfg.extraField])
  const r = await googleCall(ctx, FIREBASE_ORIGIN, 'POST', appPath(ctx, cfg), { body })
  const resp = await waitOp(ctx, r.body)
  const id = String(resp?.appId ?? '')
  if (!id) throw new ProviderError('PROVIDER_REJECTED', 'Firebase did not return the new app.')
  const have = await readApp(ctx, cfg, id)
  return ok(id, have, { created: true }, await appConfig(ctx, cfg, id))
}

async function removeApp(ctx: ProviderContext, cfg: AppCfg, id: string): Promise<void> {
  await googleCall(ctx, FIREBASE_ORIGIN, 'POST', `${appPath(ctx, cfg, id)}:remove`, {
    body: { allowMissing: true }
  })
}

async function applyApp(
  ctx: ProviderContext,
  cfg: AppCfg,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'create') {
    if (!desired) throw invalid('Nothing to create.')
    return createApp(ctx, cfg, desired)
  }
  const id = op.externalId as string
  if (op.kind === 'delete') {
    await removeApp(ctx, cfg, id)
    return ok(id, null)
  }
  if (!desired) throw invalid('Nothing to write.')
  if (op.kind === 'replace') {
    await removeApp(ctx, cfg, id)
    return createApp(ctx, cfg, { ...desired, externalId: null })
  }
  mismatch(op, desired)
  const have = await readApp(ctx, cfg, id)
  if (!have) throw new ProviderError('NOT_FOUND', 'The app no longer exists.', { status: 404 })
  const name = String(desired.fields.display_name ?? '').trim()
  const keys = ['display_name', ...(cfg.extraField ? [cfg.extraField] : [])]
  const diff = diffFields(keys, { ...desired.fields, display_name: name }, have.fields)
  if (!diff.length) return ok(id, have, { already: 'matches' })
  const mask: string[] = []
  const body: Record<string, unknown> = {}
  for (const c of diff) {
    if (c.field === 'display_name') {
      if (!name) throw invalid('The app needs a display name.')
      mask.push('displayName')
      body.displayName = name
    } else {
      mask.push('appStoreId')
      body.appStoreId = String(c.to ?? '')
    }
  }
  await googleCall(ctx, FIREBASE_ORIGIN, 'PATCH', appPath(ctx, cfg, id), {
    query: { updateMask: mask.join(',') },
    body
  })
  return ok(id, await readApp(ctx, cfg, id), { changed: diff.map((c) => c.field) })
}

// ═══ FCM service account keys ═══

const FCM_LABEL = 'FCM service-account key'
const FCM_NOTE =
  ' The service account must already hold a Firebase Cloud Messaging send role; the Hub grants no roles.'

function saProjectOk(ctx: ProviderContext, email: string): boolean {
  return emailSeg(email).endsWith(`@${pinnedProject(ctx)}.iam.gserviceaccount.com`)
}

function fcmId(email: string, keyId: string): string {
  return `${email}/${keyId}`
}

function parseFcmId(ctx: ProviderContext, id: string): { email: string; keyId: string } {
  const at = id.lastIndexOf('/')
  if (at < 1) throw new ProviderError('BAD_ID', 'That key id cannot be used.')
  const email = emailSeg(id.slice(0, at))
  if (!saProjectOk(ctx, email)) throw outOfProject(`The service account ${email}`)
  return { email, keyId: keyIdSeg(id.slice(at + 1)) }
}

function ownKeyId(ctx: ProviderContext): string | null {
  return parseServiceAccount(ctx.secrets.serviceAccountJson)?.private_key_id || null
}

function keyObserved(email: string, k: any): Observed | null {
  const keyId = String(k?.name ?? '').split('/keys/')[1] ?? ''
  if (!/^[a-f0-9]{16,64}$/.test(keyId)) return null
  return {
    type: T_FCM,
    externalId: fcmId(email, keyId),
    name: `${email} (${keyId.slice(0, 8)})`,
    fields: {
      service_account: email,
      key_id: keyId,
      valid_after: k.validAfterTime ?? null,
      valid_before: k.validBeforeTime ?? null
    },
    tags: {},
    version: null,
    status: null,
    url: `https://console.cloud.google.com/iam-admin/serviceaccounts/details/${encodeURIComponent(email)}/keys`
  }
}

async function listKeysOf(ctx: ProviderContext, email: string): Promise<Observed[]> {
  const r = await googleCall(
    ctx,
    IAM_ORIGIN,
    'GET',
    `/v1/projects/${pinnedProject(ctx)}/serviceAccounts/${emailSeg(email)}/keys`,
    { query: { keyTypes: 'USER_MANAGED' }, allow: [404] }
  )
  const own = ownKeyId(ctx)
  const out: Observed[] = []
  for (const k of Array.isArray(r.body?.keys) ? r.body.keys : []) {
    const o = keyObserved(email, k)
    if (o && o.fields.key_id !== own) out.push(o)
  }
  return out
}

async function readFcmKey(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const { email, keyId } = parseFcmId(ctx, id)
  const r = await googleCall(
    ctx,
    IAM_ORIGIN,
    'GET',
    `/v1/projects/${pinnedProject(ctx)}/serviceAccounts/${email}/keys/${keyId}`,
    { allow: [404] }
  )
  if (r.status === 404 || !r.body?.name) return null
  return keyObserved(email, r.body)
}

const FCM_FIELDS: FieldSpec[] = [
  {
    key: 'service_account',
    label: 'Service account',
    kind: 'string',
    required: true,
    createOnly: true,
    replaceOnChange: true,
    pattern: SA_EMAIL_RE.source,
    help: 'An existing service account of the pinned project with a Firebase Cloud Messaging send role.'
  },
  { key: 'key_id', label: 'Key id', kind: 'string', readOnly: true },
  { key: 'valid_before', label: 'Valid until', kind: 'string', readOnly: true },
  {
    key: ROTATE_OUTPUTS_FIELD,
    label: 'Make a new key',
    kind: 'boolean',
    trigger: true,
    default: false,
    help: 'Google shows a key once. This makes a NEW key and hands it out; the old key stays valid until you delete it.'
  }
]

function planFcm(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    if (observed.fields.key_id === ownKeyId(ctx))
      throw new ProviderError(
        'CONNECTION_KEY',
        'This is the key the connection itself uses. Delete it in Google Cloud after the connection has another key.'
      )
    return [
      {
        kind: 'delete',
        type: T_FCM,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Delete ${typedName(FCM_LABEL, observed.name)}. Anything still sending push with it is refused straight away.`,
        changes: [],
        preconditions: { key_id: observed.fields.key_id },
        risk: []
      }
    ]
  }
  const email = String(desired.fields.service_account ?? '')
  if (!SA_EMAIL_RE.test(email))
    throw invalid('The service account is an email ending .gserviceaccount.com.')
  if (!saProjectOk(ctx, email)) throw outOfProject(`The service account ${email}`)
  if (!observed)
    return [
      {
        kind: 'create',
        type: T_FCM,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Make a new key for ${email}. Google shows it once; the Hub seals it.${FCM_NOTE}`,
        changes: [{ field: 'service_account', to: email }],
        preconditions: {},
        risk: []
      }
    ]
  const replace = diffFields(['service_account'], desired.fields, observed.fields)
  if (replace.length)
    return [
      {
        kind: 'replace',
        type: T_FCM,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Replace ${typedName(FCM_LABEL, observed.name)}: a key cannot move to another service account, so the old key is deleted and a new one is made.`,
        changes: replace,
        preconditions: { key_id: observed.fields.key_id },
        risk: []
      }
    ]
  if (desired.fields[ROTATE_OUTPUTS_FIELD] === true)
    return [
      {
        kind: 'update',
        type: T_FCM,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Make a new key for ${typedName(FCM_LABEL, observed.name)}. The old key stays valid until you delete it.`,
        changes: [{ field: ROTATE_OUTPUTS_FIELD, to: true }],
        preconditions: { key_id: observed.fields.key_id },
        risk: [],
        action: 'rotate'
      }
    ]
  return []
}

async function newKey(
  ctx: ProviderContext,
  email: string
): Promise<{ id: string; observed: Observed | null; outputs: Record<string, string> }> {
  if (!saProjectOk(ctx, email)) throw outOfProject(`The service account ${email}`)
  const r = await googleCall(
    ctx,
    IAM_ORIGIN,
    'POST',
    `/v1/projects/${pinnedProject(ctx)}/serviceAccounts/${emailSeg(email)}/keys`,
    { body: { keyAlgorithm: 'KEY_ALG_RSA_2048', privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE' } }
  )
  const keyId = String(r.body?.name ?? '').split('/keys/')[1] ?? ''
  if (!/^[a-f0-9]{16,64}$/.test(keyId) || typeof r.body?.privateKeyData !== 'string')
    throw new ProviderError('PROVIDER_REJECTED', 'Google did not return the new key.')
  const json = Buffer.from(r.body.privateKeyData, 'base64').toString('utf8')
  // The key goes out as an output only: never into observed, the answer or an error.
  return {
    id: fcmId(email, keyId),
    observed: keyObserved(email, {
      name: r.body.name,
      validAfterTime: r.body.validAfterTime,
      validBeforeTime: r.body.validBeforeTime
    }),
    outputs: { service_account_json: json }
  }
}

async function applyFcm(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'create') {
    if (!desired) throw invalid('Nothing to create.')
    const email = String(desired.fields.service_account ?? '')
    if (desired.externalId) {
      // A resumed create: the key exists, its JSON was shown once and is not re-readable.
      const have = await readFcmKey(ctx, desired.externalId)
      if (have) return ok(have.externalId, have, { already: 'exists' })
    }
    const made = await newKey(ctx, email)
    return ok(made.id, made.observed, { created: true }, made.outputs)
  }
  const id = op.externalId as string
  const { email, keyId } = parseFcmId(ctx, id)
  if (op.kind === 'delete' || op.kind === 'replace') {
    if (keyId === ownKeyId(ctx))
      throw new ProviderError(
        'CONNECTION_KEY',
        'This is the key the connection itself uses; it is not deleted from here.'
      )
    await googleCall(
      ctx,
      IAM_ORIGIN,
      'DELETE',
      `/v1/projects/${pinnedProject(ctx)}/serviceAccounts/${email}/keys/${keyId}`,
      { allow: [404] }
    )
    if (op.kind === 'delete') return ok(id, null)
    if (!desired) throw invalid('Nothing to write.')
    const made = await newKey(ctx, String(desired.fields.service_account ?? ''))
    return ok(made.id, made.observed, { replaced: true }, made.outputs)
  }
  if (!desired) throw invalid('Nothing to write.')
  mismatch(op, desired)
  const have = await readFcmKey(ctx, id)
  if (!have) throw new ProviderError('NOT_FOUND', 'The key no longer exists.', { status: 404 })
  if (op.action === 'rotate') {
    // The new key is made for the service account the existing key belongs to.
    const made = await newKey(ctx, email)
    return ok(
      made.id,
      made.observed,
      { rotated: true, previous_key_id: keyId, previous_key_kept: true },
      made.outputs
    )
  }
  return ok(id, have, { already: 'matches' })
}

// ═══ Types ═══

const caps = (over: Partial<ResourceTypeSpec['capabilities']> = {}) => ({
  create: true,
  update: true,
  delete: true,
  adopt: true,
  snapshot: false,
  tag: false,
  ...over
})

const appOutputs = [
  { key: 'config_file', label: 'App config file', secret: false },
  { key: 'config_filename', label: 'Config file name', secret: false }
]

const appType = (cfg: AppCfg): ResourceTypeSpec => ({
  key: cfg.type,
  label: cfg.label,
  scope: 'app',
  nameField: 'display_name',
  fields: cfg.fields,
  capabilities: caps(),
  reversible: false,
  refs: [],
  outputs: appOutputs,
  risk(op) {
    const out: RiskFlag[] = []
    if (op.kind === 'delete' || op.kind === 'replace') out.push('destructive')
    return out
  }
})

const TYPES: ResourceTypeSpec[] = [
  {
    key: T_PROJECT,
    label: PROJECT_LABEL,
    scope: 'shared',
    nameField: 'project_id',
    fields: PROJECT_FIELDS,
    capabilities: caps({ delete: false }),
    reversible: false,
    refs: [],
    risk: () => []
  },
  appType(APPS[T_ANDROID]),
  appType(APPS[T_IOS]),
  appType(APPS[T_WEB]),
  {
    key: T_FCM,
    label: FCM_LABEL,
    scope: 'app',
    nameField: 'service_account',
    fields: FCM_FIELDS,
    capabilities: caps({ update: true, adopt: true }),
    reversible: false,
    refs: [],
    outputs: [
      {
        key: 'service_account_json',
        label: 'Service-account key (JSON) for FCM sends',
        secret: true,
        onceOnly: true
      }
    ],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete' || op.kind === 'replace') out.push('destructive', 'downtime')
      return out
    }
  }
]

// ═══ The adapter ═══

export const firebaseAdapter: ProviderAdapter = {
  key: 'firebase',
  label: 'Firebase',
  connection: {
    fields: [
      {
        key: 'projectId',
        label: 'Google Cloud project id',
        kind: 'string',
        required: true,
        placeholder: 'my-app-12345',
        help: 'Everything the Hub does stays inside this one project.'
      },
      {
        key: 'serviceAccountJson',
        label: 'Service-account key (JSON)',
        kind: 'text',
        secret: true,
        required: true,
        help: 'The JSON key of a service account of that project that may manage Firebase and its keys. Sealed; never shown again.'
      }
    ],
    hosts: () => [
      'firebase.googleapis.com',
      'oauth2.googleapis.com',
      'iam.googleapis.com',
      'fcm.googleapis.com'
    ],
    describe: (config) => `Firebase (${String(config.projectId ?? 'no project')})`,
    validate(config, secrets) {
      const problems: string[] = []
      const pin = String(config.projectId ?? '')
      if (config.projectId !== undefined && !PROJECT_RE.test(pin))
        problems.push('The project id is lower-case letters, digits and dashes (6 to 30).')
      if (secrets.serviceAccountJson !== undefined) {
        const sa = parseServiceAccount(secrets.serviceAccountJson)
        if (!sa) problems.push('The key is not a Google service-account key (JSON).')
        else if (PROJECT_RE.test(pin) && sa.project_id !== pin)
          problems.push('The key belongs to a different project than the one named here.')
      }
      return problems
    }
  },
  types: TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    const sa = parseServiceAccount(ctx.secrets.serviceAccountJson)
    const fail = (message: string): ConnectionTest => {
      const permissions = [
        { type: T_PROJECT, need: 'read the Firebase project', has: false },
        { type: T_FCM, need: 'manage service-account keys', has: false }
      ]
      return {
        ok: false,
        identity: null,
        permissions,
        missing: permissions.map((p) => p.need),
        message
      }
    }
    if (!sa) return fail('The connection has no usable service-account key.')
    const pin = pinnedProject(ctx)
    if (sa.project_id !== pin) return fail('The key belongs to a different project than the pin.')
    let project: any = null
    try {
      const r = await googleCall(ctx, FIREBASE_ORIGIN, 'GET', `/v1beta1/projects/${pin}`, {
        allow: [403, 404]
      })
      project = r
    } catch (err) {
      if (err instanceof ProviderError) return fail(ctx.scrub(err.message))
      throw err
    }
    const probe = async (origin: string, method: string, path: string, body?: unknown) => {
      try {
        const r = await googleCall(ctx, origin, method, path, {
          body,
          allow: [400, 401, 403, 404]
        })
        return r.status
      } catch {
        return 0
      }
    }
    const [apps, keys, fcm] = await Promise.all([
      probe(FIREBASE_ORIGIN, 'GET', `/v1beta1/projects/${pin}/androidApps?pageSize=1`),
      probe(
        IAM_ORIGIN,
        'GET',
        `/v1/projects/${pin}/serviceAccounts/${emailSeg(sa.client_email)}/keys?keyTypes=USER_MANAGED`
      ),
      // A dry-run send with a made-up token: 400 (bad token) means the permission is there.
      probe(FCM_ORIGIN, 'POST', `/v1/projects/${pin}/messages:send`, {
        validate_only: true,
        message: { token: 'hub-permission-probe', notification: { title: 'probe' } }
      })
    ])
    const projectOk = project.status < 400 && Boolean(project.body?.projectId)
    const permissions = [
      {
        type: T_PROJECT,
        need: 'read the Firebase project (Firebase Viewer or Admin)',
        has: projectOk
      },
      {
        type: T_ANDROID,
        need: 'manage Firebase apps (Firebase Admin)',
        has: apps > 0 && apps < 400
      },
      {
        type: T_FCM,
        need: 'make and delete service-account keys (Service Account Key Admin)',
        has: keys > 0 && keys < 400
      },
      {
        type: '*',
        need: 'send push with FCM (Firebase Cloud Messaging API on, send role)',
        has: fcm === 400 || fcm === 200
      }
    ]
    return {
      ok: true,
      identity: `Service account ${sa.client_email}`,
      permissions,
      missing: permissions.filter((p) => !p.has).map((p) => p.need)
    }
  },

  async observe(ctx, type, externalId) {
    if (type === T_PROJECT) return readProject(ctx, externalId)
    if (APPS[type]) return readApp(ctx, APPS[type], externalId)
    if (type === T_FCM) return readFcmKey(ctx, externalId)
    throw unknownType(type)
  },

  async list(ctx, type, cursor): Promise<ListPage> {
    if (type === T_PROJECT) {
      const one = await readProject(ctx, pinnedProject(ctx))
      return { items: one ? [one] : [], cursor: null }
    }
    if (APPS[type]) {
      const cfg = APPS[type]
      const page = await listApps(ctx, cfg, cursor ?? null)
      return { items: page.rows.map((a) => appObserved(cfg, a)), cursor: page.next }
    }
    if (type === T_FCM) {
      const r = await googleCall(
        ctx,
        IAM_ORIGIN,
        'GET',
        `/v1/projects/${pinnedProject(ctx)}/serviceAccounts`,
        { query: { pageSize: MAX_ACCOUNTS } }
      )
      const items: Observed[] = []
      for (const a of (Array.isArray(r.body?.accounts) ? r.body.accounts : []).slice(
        0,
        MAX_ACCOUNTS
      )) {
        const email = String(a?.email ?? '')
        if (SA_EMAIL_RE.test(email) && saProjectOk(ctx, email))
          items.push(...(await listKeysOf(ctx, email)))
      }
      return { items, cursor: null }
    }
    throw unknownType(type)
  },

  /** Plan time: an app that already has this package / bundle id / name in the project. */
  async findExisting(ctx, type, desired) {
    if (desired.externalId) return null
    if (type === T_PROJECT) return readProject(ctx, pinnedProject(ctx))
    if (APPS[type]) return findApp(ctx, APPS[type], desired)
    return null
  },

  plan(ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    if (type === T_PROJECT) return planProject(ctx, desired, observed)
    if (type && APPS[type]) return planApp(APPS[type], desired, observed)
    if (type === T_FCM) return planFcm(ctx, desired, observed)
    throw unknownType(type)
  },

  async apply(ctx, op, desired) {
    if (op.kind === 'noop') return ok(op.externalId, null)
    if (op.type === T_PROJECT) return applyProject(ctx, op, desired)
    if (APPS[op.type]) {
      const cfg = APPS[op.type]
      const result = await applyApp(ctx, cfg, op, desired)
      // An update or a resumed run re-reads the config file: it is not a secret.
      if (!result.outputs && result.ok && result.externalId && op.kind !== 'delete')
        result.outputs = await appConfig(ctx, cfg, result.externalId)
      return result
    }
    if (op.type === T_FCM) return applyFcm(ctx, op, desired)
    throw unknownType(op.type)
  },

  /** What Google shows again: an app's config file. A service-account key is once-only. */
  async readOutputs(ctx, type, externalId) {
    if (APPS[type]) return appConfig(ctx, APPS[type], externalId)
    return {}
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    const seen = await this.observe(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone in Firebase.', checkedAt }
    if (type === T_FCM) {
      const until =
        typeof seen.fields.valid_before === 'string' ? Date.parse(seen.fields.valid_before) : NaN
      // Google's own "never expires" date is year 9999.
      if (Number.isFinite(until) && until < ctx.now().getTime() + 14 * 86_400_000)
        return { status: 'warn', message: 'The key expires within two weeks.', checkedAt }
    }
    return { status: 'ok', checkedAt }
  }
}
