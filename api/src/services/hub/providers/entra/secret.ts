import { graph, graphErrorCode, graphGuid, graphPage } from '../microsoft/graph.js'
import { typedName } from '../plan-words.js'
import type {
  DesiredResource,
  HealthAnswer,
  ListPage,
  Observed,
  OpResult,
  PlannedOp,
  ProviderContext
} from '../types.js'
import { ProviderError, ROTATE_OUTPUTS_FIELD } from '../types.js'
import { assertNotSelf, requireApplication } from './application.js'
import { arr, joinId, mkOp, type Obj, splitId, str } from './shared.js'
import { ENTRA_TYPES, SECRET } from './specs.js'

/**
 * Entra client secrets (`passwordCredentials` of an app registration). The provider shows a
 * secret's value once, when it is made: it leaves as the `client_secret` output (sealed by the
 * engine) and never appears in `Observed`, a change, an answer or an error. A rotation makes a
 * second secret next to the current one; the older ones are removed by the one-shot
 * `remove_older` after the new one has been applied to the stack.
 */

const label = ENTRA_TYPES.find((t) => t.key === SECRET)?.label ?? SECRET
const WARN_DAYS = 30
const DAY_MS = 86_400_000

function siblingOf(name: string, credentialName: string): boolean {
  return credentialName === name || credentialName.startsWith(`${name} (rotated `)
}

/** Whole months from `from`, calendar-wise, as an ISO time. */
function endsAt(from: Date, months: number): string {
  const d = new Date(from.getTime())
  d.setUTCMonth(d.getUTCMonth() + months)
  return d.toISOString()
}

function stamp(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
}

export function observedSecret(appObjectId: string, cred: Obj, all: Obj[], now: Date): Observed {
  const keyId = str(cred.keyId) ?? ''
  const name = str(cred.displayName) ?? ''
  // `secretText` and `hint` are never read: a credential is shown by id, name and dates only.
  const older = all
    .filter((c) => c.keyId !== keyId && siblingOf(baseName(name), str(c.displayName) ?? ''))
    .map((c) => String(c.keyId ?? ''))
  const end = str(cred.endDateTime)
  return {
    type: SECRET,
    externalId: joinId(appObjectId, keyId),
    name: name || keyId,
    fields: {
      application: appObjectId,
      name,
      expires_at: end,
      key_id: keyId,
      older_secrets: older
    },
    tags: {},
    status: end && Date.parse(end) <= now.getTime() ? 'expired' : 'active'
  }
}

/** A rotated credential's displayName is `<name> (rotated …)`: its Hub name is the part before that. */
function baseName(displayName: string): string {
  const i = displayName.indexOf(' (rotated ')
  return i > 0 ? displayName.slice(0, i) : displayName
}

export async function observeSecret(
  ctx: ProviderContext,
  externalId: string
): Promise<Observed | null> {
  const ids = splitId(externalId)
  if (!ids) return null
  const app = await getAppWithCredentials(ctx, ids.parent)
  if (!app) return null
  const creds = arr(app.passwordCredentials)
  const cred = creds.find((c) => c.keyId === ids.child)
  return cred ? observedSecret(ids.parent, cred, creds, ctx.now()) : null
}

async function getAppWithCredentials(ctx: ProviderContext, objectId: string): Promise<Obj | null> {
  const res = await graph(ctx, 'GET', `/applications/${graphGuid(objectId, 'application id')}`, {
    query: { $select: 'id,appId,displayName,passwordCredentials' },
    allow: [404]
  })
  return res.status === 404 ? null : (res.body as Obj)
}

export async function listSecrets(
  ctx: ProviderContext,
  _cursor?: string | null
): Promise<ListPage> {
  // Credentials hang off applications; the app registration list is the way in.
  const page = await graphPage(ctx, '/applications', {
    query: { $select: 'id,passwordCredentials', $top: 50 },
    from: _cursor ?? null
  })
  const items: Observed[] = []
  for (const a of page.items) {
    const creds = arr(a.passwordCredentials)
    for (const c of creds) items.push(observedSecret(String(a.id ?? ''), c, creds, ctx.now()))
  }
  return { items, cursor: page.next }
}

export function planSecret(
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      mkOp(
        SECRET,
        null,
        'delete',
        observed.externalId,
        `Delete ${typedName(label, observed.name)}: whatever signs in with it stops.`,
        { preconditions: { name: observed.fields.name, key_id: observed.fields.key_id } }
      )
    ]
  }
  const name = typedName(label, String(desired.fields.name ?? observed?.name ?? ''))
  if (!observed)
    return [
      mkOp(
        SECRET,
        desired,
        'create',
        null,
        `Create ${name}: the value is shown once and sealed by the Hub (a secret with the same name is refused: adopt it instead).`,
        {
          changes: [
            { field: 'name', to: desired.fields.name },
            { field: 'valid_months', to: desired.fields.valid_months ?? 12 }
          ]
        }
      )
    ]
  if (desired.fields[ROTATE_OUTPUTS_FIELD] === true)
    return [
      mkOp(
        SECRET,
        desired,
        'update',
        observed.externalId,
        `Rotate ${name}: a new secret is made next to the current one; the current one keeps working until you remove it.`,
        {
          action: 'rotate',
          changes: [{ field: ROTATE_OUTPUTS_FIELD, to: true }],
          preconditions: { key_id: observed.fields.key_id },
          data: { $oneShot: [ROTATE_OUTPUTS_FIELD] }
        }
      )
    ]
  if (desired.fields.remove_older === true) {
    const older = Array.isArray(observed.fields.older_secrets)
      ? (observed.fields.older_secrets as string[])
      : []
    return [
      mkOp(
        SECRET,
        desired,
        'update',
        observed.externalId,
        older.length
          ? `Remove ${older.length} older secret${older.length === 1 ? '' : 's'} of ${name}: anything still signing in with them stops.`
          : `Remove older secrets of ${name}: there are none.`,
        {
          action: 'remove_older',
          changes: [{ field: 'remove_older', to: true }],
          preconditions: { key_id: observed.fields.key_id, older_secrets: older },
          data: { $oneShot: ['remove_older'] }
        }
      )
    ]
  }
  return [mkOp(SECRET, desired, 'noop', observed.externalId, `${name} is up to date.`)]
}

async function addPassword(
  ctx: ProviderContext,
  appObjectId: string,
  displayName: string,
  endDateTime: string
): Promise<{ keyId: string; secretText: string; end: string | null }> {
  let res: { body: unknown }
  try {
    res = await graph(
      ctx,
      'POST',
      `/applications/${graphGuid(appObjectId, 'application id')}/addPassword`,
      {
        body: { passwordCredential: { displayName, endDateTime } }
      }
    )
  } catch (err) {
    // A just-made app registration may not be visible everywhere yet.
    if (err instanceof ProviderError && err.status === 404)
      throw new ProviderError(
        'REPLICATION_PENDING',
        'The app registration is not visible in Entra yet. Retry in a moment.',
        { status: 404, retryable: true }
      )
    throw err
  }
  const b = (res.body ?? {}) as Obj
  const keyId = str(b.keyId)
  const secretText = str(b.secretText)
  if (!keyId || !secretText)
    throw new ProviderError('PROVIDER_ERROR', 'Entra did not return the new secret.')
  return { keyId, secretText, end: str(b.endDateTime) }
}

function okSecret(
  appObjectId: string,
  made: { keyId: string; end: string | null },
  displayName: string,
  extra: Partial<OpResult> = {}
): OpResult {
  return {
    ok: true,
    externalId: joinId(appObjectId, made.keyId),
    observed: {
      type: SECRET,
      externalId: joinId(appObjectId, made.keyId),
      name: displayName,
      fields: {
        application: appObjectId,
        name: baseName(displayName),
        expires_at: made.end,
        key_id: made.keyId,
        older_secrets: []
      },
      tags: {},
      status: 'active'
    },
    answer: { status: 200 },
    ...extra
  }
}

export async function createSecret(
  ctx: ProviderContext,
  desired: DesiredResource
): Promise<OpResult> {
  const app = await requireApplication(ctx, desired)
  const appId = String(app.id)
  const name = str(desired.fields.name)
  if (!name) throw new ProviderError('INVALID', 'A client secret needs a name.')
  const months = Math.min(24, Math.max(1, Number(desired.fields.valid_months ?? 12) || 12))
  const full = await getAppWithCredentials(ctx, appId)
  const creds = arr(full?.passwordCredentials)
  if (desired.externalId) {
    const ids = splitId(desired.externalId)
    const own = ids ? creds.find((c) => c.keyId === ids.child) : null
    // The Hub's own recorded secret (a resumed run): it exists, its value is not shown again.
    if (own) {
      const o = observedSecret(appId, own, creds, ctx.now())
      return { ok: true, externalId: o.externalId, observed: o, answer: { status: 200 } }
    }
  }
  if (creds.some((c) => str(c.displayName) === name))
    throw new ProviderError(
      'ALREADY_EXISTS',
      `A client secret named ${name} already exists on this app registration and was not created by the Hub. Adopt it instead of creating it.`,
      { status: 409 }
    )
  const made = await addPassword(ctx, appId, name, endsAt(ctx.now(), months))
  return okSecret(appId, made, name, { outputs: { client_secret: made.secretText } })
}

async function currentOf(
  ctx: ProviderContext,
  externalId: string
): Promise<{ appId: string; app: Obj; creds: Obj[]; current: Obj }> {
  const ids = splitId(externalId)
  if (!ids) throw new ProviderError('INVALID', 'That is not a client secret id.')
  const app = await getAppWithCredentials(ctx, ids.parent)
  if (!app)
    throw new ProviderError('NOT_FOUND', 'The app registration no longer exists in Entra.', {
      status: 404
    })
  assertNotSelf(ctx, app.appId)
  const creds = arr(app.passwordCredentials)
  const current = creds.find((c) => c.keyId === ids.child)
  if (!current)
    throw new ProviderError('NOT_FOUND', 'The client secret no longer exists in Entra.', {
      status: 404
    })
  return { appId: ids.parent, app, creds, current }
}

async function rotate(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (!op.externalId || !desired) throw new ProviderError('INVALID', 'A rotation needs a secret.')
  const { appId, current } = await currentOf(ctx, op.externalId)
  const name = baseName(str(current.displayName) ?? str(desired.fields.name) ?? 'secret')
  const months = Math.min(24, Math.max(1, Number(desired.fields.valid_months ?? 12) || 12))
  const displayName = `${name} (rotated ${stamp(ctx.now())})`
  const made = await addPassword(ctx, appId, displayName, endsAt(ctx.now(), months))
  return okSecret(appId, made, displayName, {
    outputs: { client_secret: made.secretText },
    answer: { status: 200, rotated: true, replaced: str(current.keyId) }
  })
}

async function removeOlder(ctx: ProviderContext, op: PlannedOp): Promise<OpResult> {
  if (!op.externalId) throw new ProviderError('INVALID', 'Removing older secrets needs a secret.')
  const { appId, creds, current } = await currentOf(ctx, op.externalId)
  const base = baseName(str(current.displayName) ?? '')
  // Only the Hub's own naming (the same name, or `<name> (rotated …)`), never the current one.
  const older = creds.filter(
    (c) => c.keyId !== current.keyId && siblingOf(base, str(c.displayName) ?? '')
  )
  for (const c of older) await removePassword(ctx, appId, String(c.keyId))
  const o = observedSecret(
    appId,
    current,
    creds.filter((c) => !older.includes(c)),
    ctx.now()
  )
  return {
    ok: true,
    externalId: o.externalId,
    observed: o,
    answer: { status: 200, removed: older.length }
  }
}

async function removePassword(
  ctx: ProviderContext,
  appObjectId: string,
  keyId: string
): Promise<void> {
  try {
    await graph(
      ctx,
      'POST',
      `/applications/${graphGuid(appObjectId, 'application id')}/removePassword`,
      {
        body: { keyId: graphGuid(keyId, 'key id') }
      }
    )
  } catch (err) {
    // Already removed (a rerun): nothing to do.
    if (err instanceof ProviderError && err.status === 404) return
    if (graphErrorCode(err) === 'Request_ResourceNotFound') return
    throw err
  }
}

async function deleteSecret(ctx: ProviderContext, externalId: string): Promise<OpResult> {
  const ids = splitId(externalId)
  if (!ids) throw new ProviderError('INVALID', 'That is not a client secret id.')
  const app = await getAppWithCredentials(ctx, ids.parent)
  if (!app) return { ok: true, externalId, observed: null, answer: { status: 204 } }
  assertNotSelf(ctx, app.appId)
  if (arr(app.passwordCredentials).some((c) => c.keyId === ids.child))
    await removePassword(ctx, ids.parent, ids.child)
  return { ok: true, externalId, observed: null, answer: { status: 204 } }
}

export async function applySecret(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  switch (op.kind) {
    case 'noop':
      return {
        ok: true,
        externalId: op.externalId,
        observed: op.externalId ? await observeSecret(ctx, op.externalId) : null,
        answer: { status: 200 }
      }
    case 'create':
      if (!desired) throw new ProviderError('INVALID', 'A create needs the wanted values.')
      return createSecret(ctx, desired)
    case 'update':
      if (op.action === 'rotate') return rotate(ctx, op, desired)
      if (op.action === 'remove_older') return removeOlder(ctx, op)
      throw new ProviderError(
        'UNSUPPORTED',
        'A client secret cannot be edited: rotate it or make a new one.'
      )
    case 'delete':
      if (!op.externalId) throw new ProviderError('INVALID', 'A delete needs a secret id.')
      return deleteSecret(ctx, op.externalId)
    default:
      throw new ProviderError(
        'UNSUPPORTED',
        'A client secret is made, rotated or removed, not replaced.'
      )
  }
}

export async function findSecret(
  ctx: ProviderContext,
  desired: DesiredResource
): Promise<Observed | null> {
  const ref = desired.refs.application
  const name = str(desired.fields.name)
  if (typeof ref !== 'string' || !name || desired.externalId) return null
  const app = await getAppWithCredentials(ctx, ref)
  if (!app) return null
  const creds = arr(app.passwordCredentials)
  const hit = creds.find((c) => str(c.displayName) === name)
  return hit ? observedSecret(ref, hit, creds, ctx.now()) : null
}

export async function secretHealth(
  ctx: ProviderContext,
  externalId: string
): Promise<HealthAnswer> {
  const checkedAt = ctx.now().toISOString()
  const seen = await observeSecret(ctx, externalId)
  if (!seen) return { status: 'down', message: 'The secret is gone in Entra.', checkedAt }
  const end = typeof seen.fields.expires_at === 'string' ? Date.parse(seen.fields.expires_at) : NaN
  const older = Array.isArray(seen.fields.older_secrets) ? seen.fields.older_secrets.length : 0
  const details: Record<string, string | number | boolean> = { older_secrets: older }
  if (Number.isFinite(end)) details.expires_at = new Date(end).toISOString()
  if (Number.isFinite(end) && end <= ctx.now().getTime())
    return {
      status: 'down',
      message: 'The client secret has expired. Rotate it.',
      checkedAt,
      details
    }
  if (Number.isFinite(end) && end - ctx.now().getTime() <= WARN_DAYS * DAY_MS) {
    const days = Math.max(0, Math.ceil((end - ctx.now().getTime()) / DAY_MS))
    return {
      status: 'warn',
      message: `The client secret expires in ${days} day${days === 1 ? '' : 's'}. Rotate it.`,
      checkedAt,
      details
    }
  }
  return {
    status: 'ok',
    message: older
      ? `${older} older secret${older === 1 ? ' is' : 's are'} still valid.`
      : undefined,
    checkedAt,
    details
  }
}
