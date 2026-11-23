import { db } from '../../../db/index.js'
import { APP_KEY_RE, keyFingerprint } from '../../app-key-fingerprint.js'
import { openStackSecrets, readStackSettings } from '../docker/stack-settings.js'
import { openSecret } from '../secrets.js'
import { DeploymentLinkError, deploymentClient, linkedKeyFingerprint } from './deployment-client.js'
import { getShared, openAppKey, type SharedDeployment, tenantIdFor } from './store.js'

/**
 * Nivaro Hub phase 6: may an administrator store this ENCRYPTION_KEY for an environment
 * (`PUT /api/hub/environments/:envId/app-key`, ruling P6-7)?
 *
 * The key the Hub holds is what a shared deployment seals the app's values with (the tenants list
 * sends `openAppKey`), and what a move seeds a new stack with. So a key the Hub already holds is
 * never replaced on faith:
 *  - the same key again changes nothing;
 *  - an environment placed on a shared deployment keeps its key (APP_KEY_IMMUTABLE): the
 *    deployment already seals with it, and nothing else holds a copy;
 *  - any other replacement needs the app itself to report the new key's fingerprint (hub link,
 *    or Docker stack settings that already hold it); anything less is APP_KEY_UNVERIFIED;
 *  - a first-time entry (the Hub knew no key) may be stored unverified, saying why.
 * What the app runs with comes from its CURRENT placement first: the shared deployment it is on,
 * else its Docker stack settings, else its hub link (`shared-readiness`, Task 9).
 *
 * Fingerprints only (services/app-key-fingerprint.ts); a key is never logged or answered.
 */

const ENVS = 'nivaro_hub_environments'
const APPS = 'nivaro_hub_apps'
const PLACEMENTS = 'nivaro_hub_placements'

/** Sentence for an environment whose app key the Hub does not know (preflight R9). */
export const APP_KEY_UNKNOWN_MESSAGE =
  "The Hub does not know this app's encryption key. Enter it on the environment (the app's ENCRYPTION_KEY, 64 hex characters). Apps created through GitLab always need this: the Hub never kept their key."

export interface KeyEnv {
  id: number
  app_id: number
  base_url: string
  placement_id: number | null
  hub_token: string | null
  encryption_key: string | null
  encryption_key_fp: string | null
}

export async function readKeyEnv(envId: number): Promise<KeyEnv | null> {
  const row = (await db(ENVS)
    .where({ id: envId })
    .first(
      'id',
      'app_id',
      'base_url',
      'placement_id',
      'hub_token',
      'encryption_key',
      'encryption_key_fp'
    )) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    id: Number(row.id),
    app_id: Number(row.app_id),
    base_url: String(row.base_url ?? ''),
    placement_id: row.placement_id == null ? null : Number(row.placement_id),
    hub_token: (row.hub_token as string | null) ?? null,
    encryption_key: (row.encryption_key as string | null) ?? null,
    encryption_key_fp: (row.encryption_key_fp as string | null) ?? null
  }
}

/** The shared deployment the environment's own placement is on, else null. */
export async function sharedPlacementOf(env: KeyEnv): Promise<SharedDeployment | null> {
  if (env.placement_id === null) return null
  const p = await db(PLACEMENTS).where({ id: env.placement_id }).first('shared_deployment_id')
  if (p?.shared_deployment_id == null) return null
  return getShared(Number(p.shared_deployment_id))
}

/** True when the environment holds an entry that no longer opens (wrong Hub key, damaged). */
export function entryUnreadable(env: KeyEnv): boolean {
  if (!env.encryption_key) return false
  try {
    const v = openSecret(env.encryption_key)
    return !v || !APP_KEY_RE.test(v)
  } catch {
    return true
  }
}

async function stackKeyFp(envId: number): Promise<string | null> {
  try {
    const k = openStackSecrets(await readStackSettings(envId)).ENCRYPTION_KEY
    return k && APP_KEY_RE.test(k) ? keyFingerprint(k.toLowerCase()) : null
  } catch {
    return null
  }
}

export type KeySource = 'stack' | 'shared' | 'hub-link'

export type KeyEvidence = { source: KeySource; fp: string | null } | { source: null; code: string }

/**
 * Which key the environment really runs with, asked of its current placement first: the shared
 * deployment it is placed on (the app's `key_fp` there), else its Docker stack settings, else its
 * hub link. `source: null` = it cannot be told (with a code).
 */
export async function runningKeyFp(
  env: KeyEnv,
  shared?: SharedDeployment | null
): Promise<KeyEvidence> {
  const on = shared === undefined ? await sharedPlacementOf(env) : shared
  if (on) {
    const app = await db(APPS).where({ id: env.app_id }).first('key')
    if (!app) return { source: null, code: 'UNKNOWN_APP' }
    try {
      const st = await deploymentClient(on).appStatus(
        tenantIdFor({ key: String(app.key) }, { id: env.id })
      )
      return { source: 'shared', fp: st.key_fp }
    } catch (err) {
      return {
        source: null,
        code: err instanceof DeploymentLinkError ? err.code : 'LINK_UNREACHABLE'
      }
    }
  }
  const stack = await stackKeyFp(env.id)
  if (stack) return { source: 'stack', fp: stack }
  if (env.hub_token) {
    let token: string | null = null
    try {
      token = openSecret(env.hub_token)
    } catch {
      token = null
    }
    if (!token) return { source: null, code: 'HUB_SECRET_UNREADABLE' }
    const r = await linkedKeyFingerprint(env, token)
    return r.ok ? { source: 'hub-link', fp: r.fp } : { source: null, code: r.code }
  }
  return { source: null, code: 'NO_LINK' }
}

async function decideAtRetireStop(
  env: KeyEnv,
  fp: string,
  storedFp: string | null,
  newHome: NewHomeKeyEvidence
): Promise<AppKeyDecision> {
  const held = storedFp ? ` The Hub holds the key with fingerprint ${storedFp}.` : ''
  if (storedFp && storedFp !== fp && (await sharedPlacementOf(env)))
    return {
      action: 'refuse',
      fp,
      code: 'APP_KEY_IMMUTABLE',
      message: `This app already runs on a shared deployment with the encryption key the Hub holds (fingerprint ${storedFp}). A different key (fingerprint ${fp}) would leave every value it sealed unreadable, so it cannot be changed here. Wait until the deployment reports that key, then Resume the move.`
    }
  if ('code' in newHome)
    return {
      action: 'refuse',
      fp,
      code: 'APP_KEY_UNVERIFIED',
      reason: newHome.code,
      message:
        'The Hub could not ask the new home which key it runs, so nothing was changed. Try again in a moment.'
    }
  if (newHome.fp === null)
    return {
      action: 'refuse',
      fp,
      code: 'APP_KEY_UNVERIFIED',
      reason: 'NO_KEY_FP',
      message: `The new home reports no encryption key for this app, so the key entered (fingerprint ${fp}) cannot be checked against it and nothing was changed.${held} Make the new home report the app's key, then Resume the move.`
    }
  if (newHome.fp !== fp)
    return {
      action: 'refuse',
      fp,
      code: 'APP_KEY_MISMATCH',
      message: `The new home reports the key with fingerprint ${newHome.fp}; the key entered has fingerprint ${fp}, so nothing was changed.${held} Enter the key the new home runs.`
    }
  if (storedFp === fp) return { action: 'unchanged', fp }
  return { action: 'save', fp, verified: newHome.source }
}

const MISMATCH_TEXT: Record<KeySource, string> = {
  stack:
    "This environment's Docker stack settings hold a different encryption key. Values the app sealed would not open with this one.",
  shared:
    'The shared deployment serves this app with a different encryption key. Values the app sealed would not open with this one.',
  'hub-link':
    'The app reports a different encryption key over its hub link. Values it sealed would not open with this one.'
}

export type AppKeyRefusalCode = 'APP_KEY_MISMATCH' | 'APP_KEY_UNVERIFIED' | 'APP_KEY_IMMUTABLE'

export type AppKeyDecision =
  | { action: 'unchanged'; fp: string }
  | { action: 'save'; fp: string; verified: KeySource | null; unverified_code?: string }
  | { action: 'refuse'; fp: string; code: AppKeyRefusalCode; message: string; reason?: string }

/**
 * Ruling P6-43 (a): what the NEW home of a move stopped at retire_source reports (the same reader
 * as the move's key check, run.ts newHomeKeyFp), or `code` when it could not be asked.
 */
export type NewHomeKeyEvidence =
  | { source: 'shared' | 'hub-link'; fp: string | null }
  | { code: string }

/**
 * Decides a PUT of `hexKey` (already checked as 64 hex) for `env`. Reads only; never writes.
 * `newHome`: the environment's move is stopped at retire_source (P6-43 (a)); the key is taken only
 * when its fingerprint matches the one the new home reports, which is how the Hub gets a verified
 * copy of the key the app really runs. A shared target still refuses a key that differs from the
 * one the Hub holds (APP_KEY_IMMUTABLE).
 */
export async function decideAppKey(
  env: KeyEnv,
  hexKey: string,
  opts: { newHome?: NewHomeKeyEvidence } = {}
): Promise<AppKeyDecision> {
  const fp = keyFingerprint(hexKey.toLowerCase())
  const stored = await openAppKey(env.id)
  const storedFp = stored ? keyFingerprint(stored) : null
  if (opts.newHome) return decideAtRetireStop(env, fp, storedFp, opts.newHome)
  if (storedFp === fp) return { action: 'unchanged', fp }

  const shared = await sharedPlacementOf(env)
  if (storedFp && shared)
    return {
      action: 'refuse',
      fp,
      code: 'APP_KEY_IMMUTABLE',
      message:
        'This app already runs on a shared deployment with the encryption key the Hub holds. A different key would leave every value it sealed unreadable, so it cannot be changed here.'
    }

  const running = await runningKeyFp(env, shared)
  if (running.source !== null && running.fp !== null && running.fp !== fp)
    return {
      action: 'refuse',
      fp,
      code: 'APP_KEY_MISMATCH',
      message: MISMATCH_TEXT[running.source]
    }

  const confirmed = running.source !== null && running.fp === fp
  const why = running.source === null ? running.code : 'NO_KEY_FP'
  if (storedFp && !confirmed)
    return {
      action: 'refuse',
      fp,
      code: 'APP_KEY_UNVERIFIED',
      reason: why,
      message:
        'The Hub already holds a different key for this app and could not confirm that the app runs with the new one, so nothing was changed. Check that the app answers over its hub link, then try again.'
    }
  return confirmed
    ? { action: 'save', fp, verified: running.source as KeySource }
    : { action: 'save', fp, verified: null, unverified_code: why }
}
