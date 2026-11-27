import { scrubValues } from '../context.js'
import { typedName } from '../plan-words.js'
import { appAllowedConnections, readConnection, readResource } from '../store.js'
import type {
  DesiredResource,
  FieldChange,
  Observed,
  OpResult,
  PlannedOp,
  ProviderContext
} from '../types.js'
import { ProviderError } from '../types.js'
import { composeId, gql, splitId } from './client.js'
import * as Q from './queries.js'

/**
 * `expo.android_push_credentials`: uploads an FCM V1 service-account key (made by a
 * `firebase.fcm_service_account` resource) to EAS and links it as the Android app's push key.
 *
 * The key never leaves this file's call chain: it is read from the Firebase resource's SEALED
 * output (engine/bindings.ts `openOutputForCredentialLink`), sent in one GraphQL variable, and
 * scrubbed from every error. It is never in observed, desired, an op, a step or an answer.
 *
 * Which Firebase resource: a refs-never-cross-connections engine cannot carry a `ref` to another
 * connection's resource, so the Expo CONNECTION names the Firebase connection (admin-set
 * `firebase_connection_id`, like ACME's `dns_connection_id`) and the resource names the Firebase
 * resource by Hub id (`fcm_key_resource_id`). `loadKey` accepts it only when it is an FCM key
 * resource of that very connection AND of the same app as this resource, and the app is allowed
 * to use that connection.
 *
 * Provider ids: `<appId>:<androidAppCredentialsId>`. iOS (APNs) is out of scope.
 */

export const T_PUSH = 'expo.android_push_credentials'
const FIREBASE_PROVIDER = 'firebase'
const FIREBASE_FCM_TYPE = 'firebase.fcm_service_account'
const FIREBASE_KEY_OUTPUT = 'service_account_json'

export const APPLICATION_ID_PATTERN = '^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$'
const APPLICATION_ID_RE = new RegExp(APPLICATION_ID_PATTERN)

const LABEL = 'Android push credentials'

/** The admin-set Firebase connection of an Expo connection (null = not set). */
export function firebaseConnectionId(config: Record<string, unknown>): number | null {
  const n = Number(config.firebase_connection_id)
  return Number.isInteger(n) && n > 0 ? n : null
}

// ── Mapping ──

interface CredRow {
  id: string
  applicationIdentifier?: string | null
  googleServiceAccountKeyForFcmV1?: {
    id?: string
    clientEmail?: string | null
    privateKeyIdentifier?: string | null
  } | null
}

export function mapCreds(appId: string, row: CredRow, echo?: number | null): Observed {
  const key = row.googleServiceAccountKeyForFcmV1 ?? null
  return {
    type: T_PUSH,
    externalId: composeId(appId, String(row.id)),
    name: row.applicationIdentifier ?? null,
    fields: {
      project: appId,
      application_id: row.applicationIdentifier ?? null,
      // Identifiers only: the key itself is never readable.
      key_linked: Boolean(key?.id),
      key_email: key?.clientEmail ?? null,
      ...(echo ? { fcm_key_resource_id: echo } : {})
    },
    tags: {},
    status: key?.id ? 'linked' : 'unlinked'
  }
}

export async function credRows(ctx: ProviderContext, appId: string): Promise<CredRow[]> {
  const d = await gql(ctx, Q.Q_ANDROID_CREDENTIALS, { appId })
  return (d.app?.byId?.androidAppCredentials ?? []) as CredRow[]
}

export async function observePush(
  ctx: ProviderContext,
  externalId: string,
  guardApp: (ctx: ProviderContext, appId: string) => Promise<boolean>
): Promise<Observed | null> {
  const { appId, id } = splitId(externalId)
  if (!(await guardApp(ctx, appId))) return null
  const row = (await credRows(ctx, appId)).find((r) => String(r.id) === id)
  return row ? mapCreds(appId, row) : null
}

/** Credentials rows that have a push key (what adopt offers), for each app of the page. */
export async function listPush(ctx: ProviderContext, appIds: string[]): Promise<Observed[]> {
  const out: Observed[] = []
  for (const appId of appIds)
    for (const row of await credRows(ctx, appId))
      if (row.googleServiceAccountKeyForFcmV1?.id) out.push(mapCreds(appId, row))
  return out
}

// ── Plan ──

const echoId = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

function planned(
  d: DesiredResource,
  kind: PlannedOp['kind'],
  externalId: string | null,
  reason: string,
  changes: FieldChange[],
  extra: Partial<PlannedOp> = {}
): PlannedOp {
  return {
    kind,
    type: d.type,
    resourceId: d.resourceId,
    externalId,
    reason,
    changes,
    preconditions: {},
    risk: [],
    ...extra
  }
}

export function planPush(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired && !observed) return []
  if (!desired && observed)
    return [
      {
        kind: 'delete',
        type: T_PUSH,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Remove the push key of ${typedName(LABEL, observed.name ?? observed.externalId)} from Expo. Android devices of this app stop receiving pushes until another key is linked. The credentials row itself stays.`,
        changes: [],
        preconditions: { application_id: observed.fields.application_id ?? null },
        risk: []
      }
    ]
  const d = desired as DesiredResource
  const keyChange: FieldChange = { field: 'fcm_key_resource_id', to: d.fields.fcm_key_resource_id }
  if (!observed)
    return [
      planned(
        d,
        'create',
        null,
        `Upload the Firebase key (Hub resource #${String(d.fields.fcm_key_resource_id ?? '?')}) to Expo and link it as the push key of ${typedName(LABEL, String(d.fields.application_id ?? ''))}. A credentials row that already has a push key stops the change with ALREADY_EXISTS: adopt it instead.`,
        [
          { field: 'project', to: d.refs.project ?? null },
          { field: 'application_id', to: d.fields.application_id },
          keyChange
        ],
        { action: 'link_fcm' }
      )
    ]
  const name = observed.name ?? observed.externalId
  if ((observed.fields.application_id ?? null) !== (d.fields.application_id ?? null))
    return [
      planned(
        d,
        'replace',
        observed.externalId,
        `Replace ${typedName(LABEL, name)}: the application id cannot change in place. The old row's push key is removed from Expo and the key is uploaded for the new one.`,
        [
          {
            field: 'application_id',
            from: observed.fields.application_id ?? null,
            to: d.fields.application_id
          }
        ],
        { preconditions: { application_id: observed.fields.application_id ?? null } }
      )
    ]
  const echoed = echoId(observed.fields.fcm_key_resource_id)
  const wanted = echoId(d.fields.fcm_key_resource_id)
  const reasons: string[] = []
  const changes: FieldChange[] = []
  if (observed.fields.key_linked === false) reasons.push('no push key is linked')
  // Expo never says which Hub resource a key came from: the apply echoes it, a fresh read drops it.
  if (echoed !== null && wanted !== null && echoed !== wanted) {
    reasons.push('another Firebase key is wanted')
    changes.push({ field: 'fcm_key_resource_id', from: echoed, to: wanted })
  }
  if (d.fields.upload_key === true) {
    reasons.push('an upload was requested')
    changes.push({ field: 'upload_key', to: true })
  }
  if (!reasons.length)
    return [planned(d, 'noop', observed.externalId, `${typedName(LABEL, name)} is up to date.`, [])]
  return [
    planned(
      d,
      'update',
      observed.externalId,
      `Upload the Firebase key (Hub resource #${String(wanted ?? '?')}) to Expo for ${typedName(LABEL, name)} (${reasons.join('; ')}). The previous key stays in the Expo account.`,
      changes,
      { action: 'link_fcm', preconditions: { key_linked: observed.fields.key_linked ?? null } }
    )
  ]
}

// ── The key ──

interface LoadedKey {
  json: Record<string, unknown>
  privateKeyId: string
  resourceId: number
  /** Every value to mask in anything an error might carry. */
  secrets: string[]
}

function refuse(code: string, message: string): ProviderError {
  return new ProviderError(code, message)
}

/**
 * Opens the Firebase key for one apply, after proving it is the right resource: admin-set
 * connection, FCM key type, same app, and the app may use the connection.
 */
export async function loadKey(ctx: ProviderContext, d: DesiredResource): Promise<LoadedKey> {
  const connectionId = firebaseConnectionId(ctx.config)
  if (connectionId === null)
    throw refuse(
      'EXPO_FIREBASE_CONNECTION',
      'This Expo connection has no Firebase connection. A Hub administrator picks it in the connection settings (firebase_connection_id).'
    )
  const conn = await readConnection(connectionId)
  if (!conn || conn.status === 'disabled' || conn.provider !== FIREBASE_PROVIDER)
    throw refuse(
      'EXPO_FIREBASE_CONNECTION',
      'The Firebase connection of this Expo connection is missing, disabled or not a Firebase connection.'
    )
  const resourceId = echoId(d.fields.fcm_key_resource_id)
  if (resourceId === null)
    throw refuse('EXPO_FIREBASE_KEY', 'Name the Hub resource id of the Firebase FCM key.')
  const appId = d.appId
  if (appId === null || !Number.isInteger(appId))
    throw refuse('EXPO_FIREBASE_KEY', 'Push credentials belong to one app.')
  if (!(await appAllowedConnections(appId)).includes(connectionId))
    throw refuse(
      'EXPO_FIREBASE_KEY',
      'This app is not allowed to use the Firebase connection. A Hub administrator allows it first.'
    )
  const res = await readResource(resourceId)
  // One message for every "not that one" so the answer never tells what another app owns.
  if (
    !res ||
    res.deleted_at ||
    res.provider !== FIREBASE_PROVIDER ||
    res.type !== FIREBASE_FCM_TYPE ||
    res.connection_id !== connectionId ||
    res.scope !== 'app' ||
    res.app_id !== appId
  )
    throw refuse(
      'EXPO_FIREBASE_KEY',
      'That is not a Firebase FCM key of this app on the connection the administrator set.'
    )
  const { openOutputForCredentialLink } = await import('../engine/bindings.js')
  const text = await openOutputForCredentialLink(resourceId, {
    provider: FIREBASE_PROVIDER,
    type: FIREBASE_FCM_TYPE,
    key: FIREBASE_KEY_OUTPUT
  })
  if (!text)
    throw refuse(
      'EXPO_FIREBASE_KEY_UNAVAILABLE',
      'The Firebase key has no stored copy (Google shows a key once). Make a new key on the Firebase resource (rotate), then apply again.'
    )
  let json: Record<string, unknown>
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
    json = parsed as Record<string, unknown>
  } catch {
    throw refuse('EXPO_FIREBASE_KEY_INVALID', 'The stored Firebase key is not a JSON object.')
  }
  const privateKey = typeof json.private_key === 'string' ? json.private_key : ''
  const privateKeyId = typeof json.private_key_id === 'string' ? json.private_key_id : ''
  if (
    json.type !== 'service_account' ||
    typeof json.client_email !== 'string' ||
    !privateKey.startsWith('-----BEGIN') ||
    !privateKeyId
  )
    throw refuse(
      'EXPO_FIREBASE_KEY_INVALID',
      'The stored Firebase key is not a service-account key.'
    )
  const secrets = [
    text,
    privateKey,
    privateKeyId,
    ...privateKey.split('\n').filter((l) => l.length >= 16)
  ]
  return { json, privateKeyId, resourceId, secrets }
}

async function withScrub<T>(secrets: string[], run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof ProviderError) err.message = scrubValues(err.message, secrets)
    throw err
  }
}

// ── Apply ──

const done = (externalId: string | null, observed: Observed | null, answer?: object): OpResult => ({
  ok: true,
  externalId,
  observed,
  ...(answer ? { answer: answer as Record<string, unknown> } : {})
})

/** create / update / replace-create: upload the key, link it, say the row. */
export async function linkKey(
  ctx: ProviderContext,
  d: DesiredResource,
  requireApp: (ctx: ProviderContext, appId: string) => Promise<void>,
  account: string
): Promise<OpResult> {
  const appId = d.refs.project
  if (typeof appId !== 'string' || !appId)
    throw refuse('EXPO_REF_UNRESOLVED', 'The project has not been created yet.')
  const application = String(d.fields.application_id ?? '')
  if (!APPLICATION_ID_RE.test(application))
    throw refuse('EXPO_BAD_APPLICATION_ID', 'That is not an Android application id.')
  await requireApp(ctx, appId)
  if (d.externalId && splitId(d.externalId).appId !== appId)
    throw refuse('TARGET_MISMATCH', 'The credentials belong to another project.')
  const key = await loadKey(ctx, d)
  const rows = await credRows(ctx, appId)
  let row = d.externalId
    ? rows.find((r) => String(r.id) === splitId(String(d.externalId)).id)
    : rows.find((r) => r.applicationIdentifier === application)
  if (d.externalId && !row)
    throw refuse('EXPO_NOT_FOUND', 'The credentials row is gone. Plan again.')
  if (d.externalId && row?.applicationIdentifier !== application)
    throw refuse('TARGET_MISMATCH', 'The credentials row is for another application id.')
  const linked = row?.googleServiceAccountKeyForFcmV1 ?? null
  // Create-time match: a row that already carries a push key is never replaced silently.
  if (!d.externalId && row && linked?.id)
    throw refuse(
      'ALREADY_EXISTS',
      `${application} already has a push key in Expo that the Hub did not set. Adopt it instead of creating it.`
    )
  // The same key is already linked (a resumed run, or a re-apply): nothing to upload.
  if (row && linked?.privateKeyIdentifier && linked.privateKeyIdentifier === key.privateKeyId)
    return done(composeId(appId, String(row.id)), mapCreds(appId, row, key.resourceId), {
      existed: true
    })
  if (!row) {
    const out = await gql(ctx, Q.M_CREATE_ANDROID_CREDENTIALS, {
      appId,
      applicationIdentifier: application
    })
    row = out.androidAppCredentials?.createAndroidAppCredentials as CredRow | undefined
    if (!row?.id) throw refuse('EXPO_BAD_ANSWER', 'Expo did not return the credentials row.')
  }
  const acc = await gql(ctx, Q.Q_ACCOUNT, { name: account })
  const accountId = acc.account?.byName?.id
  if (!accountId) throw refuse('EXPO_ACCOUNT_NOT_FOUND', `Account ${account} is not reachable.`)
  const created = await withScrub(key.secrets, () =>
    gql(ctx, Q.M_CREATE_SA_KEY, { accountId, input: { jsonKey: key.json } })
  )
  const keyId = created.googleServiceAccountKey?.createGoogleServiceAccountKey?.id
  if (!keyId) throw refuse('EXPO_BAD_ANSWER', 'Expo did not return the uploaded key.')
  try {
    const out = await gql(ctx, Q.M_SET_FCM_V1, { id: row.id, keyId })
    const after = (out.androidAppCredentials?.setGoogleServiceAccountKeyForFcmV1 ?? row) as CredRow
    return done(composeId(appId, String(row.id)), mapCreds(appId, after, key.resourceId), {
      key_uploaded: true
    })
  } catch (err) {
    // Do not leave an unlinked copy of the key in the Expo account.
    await gql(ctx, Q.M_DELETE_SA_KEY, { id: keyId }).catch(() => undefined)
    throw err
  }
}

/** delete / replace-delete: removes the linked push key from the Expo account. */
export async function removeKey(
  ctx: ProviderContext,
  externalId: string,
  guardApp: (ctx: ProviderContext, appId: string) => Promise<boolean>
): Promise<OpResult> {
  const { appId, id } = splitId(externalId)
  if (!(await guardApp(ctx, appId))) return done(externalId, null)
  const row = (await credRows(ctx, appId)).find((r) => String(r.id) === id)
  const keyId = row?.googleServiceAccountKeyForFcmV1?.id
  if (keyId) await gql(ctx, Q.M_DELETE_SA_KEY, { id: keyId })
  return done(externalId, null)
}

/** Plan time: a row for this application id that already holds a push key blocks a create. */
export async function findExistingPush(
  ctx: ProviderContext,
  d: DesiredResource
): Promise<Observed | null> {
  const appId = d.refs.project
  if (typeof appId !== 'string' || !appId) return null
  const row = (await credRows(ctx, appId)).find(
    (r) => r.applicationIdentifier === String(d.fields.application_id ?? '')
  )
  return row?.googleServiceAccountKeyForFcmV1?.id ? mapCreds(appId, row) : null
}
