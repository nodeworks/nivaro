import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { safeFetch } from '../lib/ssrf.js'
import { instanceKey } from './instance-key.js'

/**
 * The Nivaro push relay: how the official Nivaro phone app gets alerts without every
 * instance owning Apple/Google push credentials. An instance registers once
 * (`connectPushRelay`, key shown once and stored), then sends `{device, title, body, data}`
 * messages; the relay forwards them to APNs/FCM and says which devices are gone.
 *
 * Phone rows in `nivaro_push_subscriptions`: `expo:<token>` (direct, own Expo app) or
 * `relay:<device id>` (relay). `wherePhoneEndpoint` / `isPhoneEndpoint` match both.
 *
 *   MOBILE_PUSH_RELAY_URL=   default https://push.nivaro.dev
 *   MOBILE_PUSH_RELAY_KEY=   the instance key (`_FILE` works); beats the stored one
 *   nivaro_settings_overrides key `mobile_push` {relay_key, content: 'full'|'minimal'}
 */

export const EXPO_PREFIX = 'expo:'
export const RELAY_PREFIX = 'relay:'
export const DEFAULT_RELAY_URL = 'https://push.nivaro.dev'
export const RELAY_TIMEOUT_MS = 3000
export const RELAY_KEY_MASK = '********'
/** Messages per relay call: a public relay key may send 60 a minute, so a batch of 100 would
 *  always be refused. */
export const RELAY_BATCH = 50

export type RelayContent = 'full' | 'minimal'

/** SQL for "this subscription row is a phone" (raw select/group expressions). */
export const PHONE_ENDPOINT_SQL =
  `(endpoint LIKE '${EXPO_PREFIX}%' ` + `OR endpoint LIKE '${RELAY_PREFIX}%')`

export function isPhoneEndpoint(endpoint: string): boolean {
  return endpoint.startsWith(EXPO_PREFIX) || endpoint.startsWith(RELAY_PREFIX)
}

/** Restrict a subscriptions query to phone rows (Expo and relay). */
export function wherePhoneEndpoint(q: Knex.QueryBuilder): Knex.QueryBuilder {
  return q.where((b) =>
    b.where('endpoint', 'like', `${EXPO_PREFIX}%`).orWhere('endpoint', 'like', `${RELAY_PREFIX}%`)
  )
}

export interface PushRelayConfig {
  url: string
  key: string | null
  content: RelayContent
}

async function storedConfig(): Promise<Record<string, unknown>> {
  try {
    const row = (await db('nivaro_settings_overrides')
      .where({ instance_key: instanceKey() })
      .first('data')) as { data?: string | null } | undefined
    const data = row?.data ? JSON.parse(row.data) : null
    const mp = data?.mobile_push
    return mp && typeof mp === 'object' ? (mp as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function pushRelayConfig(): Promise<PushRelayConfig> {
  const stored = await storedConfig()
  const url = (process.env.MOBILE_PUSH_RELAY_URL || DEFAULT_RELAY_URL).replace(/\/+$/, '')
  const envKey = process.env.MOBILE_PUSH_RELAY_KEY?.trim()
  const key = envKey || (typeof stored.relay_key === 'string' && stored.relay_key) || null
  return { url, key, content: stored.content === 'minimal' ? 'minimal' : 'full' }
}

/** Merge a patch into the `mobile_push` key, keeping the rest of the instance's override row. */
async function saveStored(patch: Record<string, unknown>): Promise<void> {
  const k = instanceKey()
  const row = (await db('nivaro_settings_overrides')
    .where({ instance_key: k })
    .first('id', 'data')) as { id: number; data?: string | null } | undefined
  let data: Record<string, unknown> = {}
  try {
    data = row?.data ? JSON.parse(row.data) : {}
  } catch {
    data = {}
  }
  const prev = (data.mobile_push as Record<string, unknown> | undefined) ?? {}
  data.mobile_push = { ...prev, ...patch }
  if (row) {
    await db('nivaro_settings_overrides')
      .where({ instance_key: k })
      .update({ data: JSON.stringify(data), updated_at: new Date() })
  } else {
    await db('nivaro_settings_overrides').insert({
      instance_key: k,
      data: JSON.stringify(data),
      updated_at: new Date()
    })
  }
}

export async function setRelayContent(content: RelayContent): Promise<void> {
  await saveStored({ content })
}

/** Forget the stored relay key (an env key is not touched). */
export async function clearRelayKey(): Promise<void> {
  await saveStored({ relay_key: null })
}

/** Store a relay key. The masked placeholder (a re-sent GET value) keeps the stored one. */
export async function setRelayKey(key: string): Promise<void> {
  if (!key || key === RELAY_KEY_MASK) return
  await saveStored({ relay_key: key })
}

/** Register this instance with the relay and store the key it answers (shown once). */
export class RelayError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message)
  }
}

export async function connectPushRelay(origin: string, name: string): Promise<void> {
  if (!origin.trim()) {
    throw new RelayError(
      'This instance has no public address to register with the push relay.',
      'RELAY_NO_ORIGIN'
    )
  }
  const cfg = await pushRelayConfig()
  const res = await safeFetch(`${cfg.url}/v1/instances`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ origin, name }),
    timeoutMs: 10_000
  })
  const json = (await res.json().catch(() => ({}))) as { key?: string }
  if (!res.ok || typeof json.key !== 'string' || !json.key) {
    throw new Error(`The push relay refused the connection (${res.status}).`)
  }
  await setRelayKey(json.key)
}

export interface RelayMessage {
  device: string
  title: string
  body: string
  data: Record<string, string>
  badge?: number
}

export type RelayStatus = 'ok' | 'gone' | 'error'

/**
 * Send one batch (≤ RELAY_BATCH) through the relay. Never throws: a relay that is down, slow (3 s) or
 * answers non-2xx yields `null`, so the caller counts the batch as failed.
 */
export async function relaySend(
  cfg: PushRelayConfig,
  messages: RelayMessage[]
): Promise<Array<{ device: string; status: RelayStatus }> | null> {
  if (!cfg.key || messages.length === 0) return null
  try {
    const res = await safeFetch(`${cfg.url}/v1/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ messages }),
      timeoutMs: RELAY_TIMEOUT_MS
    })
    const json = (await res.json().catch(() => ({}))) as {
      results?: Array<{ device: string; status: RelayStatus }>
    }
    if (!res.ok || !Array.isArray(json.results)) {
      console.warn('[push-relay] send failed:', res.status)
      return null
    }
    return json.results
  } catch (err) {
    console.warn('[push-relay] send error:', (err as Error)?.message ?? err)
    return null
  }
}
