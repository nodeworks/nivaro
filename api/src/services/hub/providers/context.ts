import { createHash } from 'node:crypto'
import { HUB_MASK } from '../secrets.js'
import { makeProviderFetch, type ProviderFetchOptions } from './provider-fetch.js'
import type {
  ProviderAdapter,
  ProviderContext,
  ProviderLogger,
  ProviderTokenCache
} from './types.js'

/**
 * Builds the `ProviderContext` an adapter call gets: the connection's config + opened secrets,
 * a fetch limited to the hosts `adapter.connection.hosts(config)` names, a scrubber for every
 * secret of the connection (and every token minted from it), a per-connection token cache, the
 * region, the abort signal and the clock. The engine builds one per call; adapter tests build
 * one the same way (pass `fetchImpl` to answer from fixtures).
 */

export interface ProviderContextInput {
  adapter: ProviderAdapter
  connectionId: number
  config: Record<string, unknown>
  secrets: Record<string, string>
  region?: string | null
  signal?: AbortSignal
  log?: ProviderLogger
  now?: () => Date
  /** Passed to makeProviderFetch (timeout, test fetchImpl). */
  fetch?: Omit<ProviderFetchOptions, 'signal'>
}

const SILENT: ProviderLogger = { info() {}, warn() {}, error() {} }

interface CachedToken {
  value: string
  /** Epoch ms after which the token is not handed out (60 s before it stops working). */
  until: number
}

// Hub-only (HUB=on, never a shared deployment): connection id → (token key → token). Dropped for
// a connection by forgetConnectionTokens when its credentials change or it is deleted.
const tokenCaches = new Map<number, Map<string, CachedToken>>()
const TOKEN_SLACK_MS = 60_000

function credentialStamp(secrets: Record<string, string>): string {
  const h = createHash('sha256')
  for (const k of Object.keys(secrets).sort()) h.update(`${k}\0${secrets[k]}\0`)
  return h.digest('hex').slice(0, 16)
}

/** Forget every cached token of a connection (credentials changed, connection deleted). */
export function forgetConnectionTokens(connectionId: number): void {
  tokenCaches.delete(connectionId)
}

function tokenCacheFor(
  connectionId: number,
  stamp: string,
  now: () => Date,
  onToken: (value: string) => void
): ProviderTokenCache {
  // Keys carry the credential stamp, so a token minted from old credentials is never reused.
  const k = (key: string) => `${stamp}:${key}`
  const bucket = () => {
    let b = tokenCaches.get(connectionId)
    if (!b) {
      b = new Map()
      tokenCaches.set(connectionId, b)
    }
    return b
  }
  return {
    get(key) {
      const hit = tokenCaches.get(connectionId)?.get(k(key))
      if (!hit) return null
      if (now().getTime() >= hit.until) {
        tokenCaches.get(connectionId)?.delete(k(key))
        return null
      }
      onToken(hit.value)
      return hit.value
    },
    set(key, value, expiresAt) {
      onToken(value)
      const until = expiresAt.getTime() - TOKEN_SLACK_MS
      if (until <= now().getTime()) return
      const b = bucket()
      // Drop entries of earlier credentials (a different stamp).
      for (const key2 of b.keys()) if (!key2.startsWith(`${stamp}:`)) b.delete(key2)
      b.set(k(key), { value, until })
    },
    delete(key) {
      tokenCaches.get(connectionId)?.delete(k(key))
    }
  }
}

/** Masks every listed value (longest first) in `text`. Values shorter than 4 are ignored. */
export function scrubValues(text: string, values: Iterable<string>): string {
  const list = [...new Set([...values].filter((v) => typeof v === 'string' && v.length >= 4))]
  list.sort((a, b) => b.length - a.length)
  let out = String(text ?? '')
  for (const v of list) out = out.split(v).join(HUB_MASK)
  return out
}

export function makeProviderContext(input: ProviderContextInput): ProviderContext {
  const now = input.now ?? (() => new Date())
  const signal = input.signal ?? new AbortController().signal
  const known = new Set<string>(Object.values(input.secrets).filter((v) => typeof v === 'string'))
  const tokens = tokenCacheFor(input.connectionId, credentialStamp(input.secrets), now, (value) =>
    known.add(value)
  )
  return {
    connectionId: input.connectionId,
    provider: input.adapter.key,
    config: input.config,
    secrets: input.secrets,
    fetch: makeProviderFetch(input.adapter.connection.hosts(input.config), {
      ...input.fetch,
      signal
    }),
    log: input.log ?? SILENT,
    region: input.region ?? null,
    signal,
    scrub: (text) => scrubValues(text, known),
    tokens,
    now
  }
}
