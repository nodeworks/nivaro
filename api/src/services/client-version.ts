import { NIVARO_VERSION } from '../version.js'

/**
 * Which build an open tab runs (#1048 / #1180). Front ends send it on every API request as
 * `x-nivaro-client: build=…; api=…; tab=…; loaded=…` and in the socket's `client:hello` as the
 * same fields (packages/shared lib/client-version.ts). Untrusted: every field is cleaned and
 * capped here.
 */

export interface ClientVersion {
  /** The frontend bundle the tab loaded; null = unknown. */
  build: string | null
  /** The API version the tab first talked to; null = unknown. */
  api: string | null
  /** A random id per browser tab (kept across that tab's reloads). */
  tab: string | null
  /** When this page load started (ms since epoch); null = unknown. */
  loaded: number | null
}

export const CLIENT_HEADER = 'x-nivaro-client'

function clean(v: unknown, max = 60): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v)
    .trim()
    .replace(/[^\w.+@-]/g, '')
  return s ? s.slice(0, max) : null
}

function cleanLoaded(v: unknown): number | null {
  const n = Number(v)
  // A page load can't start in the future or before 2020.
  if (!Number.isFinite(n) || n < 1_577_836_800_000 || n > Date.now() + 60_000) return null
  return Math.round(n)
}

/** Parse the `x-nivaro-client` header (or null when absent / empty). */
export function parseClientHeader(raw: unknown): ClientVersion | null {
  const text = Array.isArray(raw) ? raw[0] : raw
  if (typeof text !== 'string' || !text.trim()) return null
  const fields: Record<string, string> = {}
  for (const part of text.slice(0, 400).split(';')) {
    const at = part.indexOf('=')
    if (at < 1) continue
    fields[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim()
  }
  const out = fromFields(fields)
  return out.build || out.tab ? out : null
}

/** The same fields from a socket's `client:hello` payload. */
export function clientVersionFromHello(payload: unknown): ClientVersion {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  return fromFields(p)
}

function fromFields(f: Record<string, unknown>): ClientVersion {
  return {
    build: clean(f.build),
    api: clean(f.api ?? f.api_version),
    tab: clean(f.tab, 24),
    loaded: cleanLoaded(f.loaded)
  }
}

/** A build string the API can compare ('dev' and dev placeholders never count). */
export function judgeable(v: string | null | undefined): v is string {
  return !!v && v !== 'dev' && !v.startsWith('0.0.0')
}

/** True when the tab loaded against a different API version than this process serves. */
export function onOlderApi(v: ClientVersion | null | undefined): boolean {
  if (!v || !judgeable(v.api) || !judgeable(NIVARO_VERSION)) return false
  return v.api !== NIVARO_VERSION
}

/**
 * Per app, the build that is current: the build of the most recent page load seen. A tab that
 * loads now loads what is being served now, so the newest load names the current bundle — no
 * release registry needed, and an API restart (every tab reconnecting at once) can't reorder it.
 */
export function currentBuilds(
  clients: Iterable<{ app: string | null; version: ClientVersion | null }>
): Map<string, string> {
  const best = new Map<string, { build: string; loaded: number }>()
  for (const c of clients) {
    const v = c.version
    if (!v || !judgeable(v.build) || v.loaded == null) continue
    const app = c.app ?? 'app'
    const prev = best.get(app)
    if (!prev || v.loaded > prev.loaded) best.set(app, { build: v.build, loaded: v.loaded })
  }
  return new Map([...best].map(([app, b]) => [app, b.build]))
}

/** Why a tab counts as old (null = current, or unknown). */
export function olderReason(
  app: string | null,
  v: ClientVersion | null | undefined,
  current: Map<string, string>
): 'build' | 'api' | null {
  if (!v) return null
  const cur = current.get(app ?? 'app')
  if (judgeable(v.build) && cur && v.build !== cur) return 'build'
  if (onOlderApi(v)) return 'api'
  return null
}
