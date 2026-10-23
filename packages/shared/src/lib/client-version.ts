/**
 * Which build an open tab is running (#1048 / #1180).
 *
 * One signal, sent two ways: every API request carries it in the `x-nivaro-client` header, and the
 * socket's `client:hello` carries the same fields. The API uses it to count open tabs per build
 * and to reload only the tabs that run an older one.
 *
 *   build   the frontend bundle the tab loaded (admin: the release version it was built with;
 *           a headless host: its own build id). 'dev' / unset = unknown, never judged.
 *   api     the API version the tab first talked to — read from the `X-Nivaro-Version` header of
 *           the first API response, so an API-only deploy shows up too.
 *   tab     a random id per browser tab, kept across reloads of that tab (sessionStorage), so a
 *           reload moves the tab to the new build instead of counting it twice.
 *   loaded  when this page load started (ms) — the newest load of an app tells the API which
 *           build is current, without a release registry.
 *
 * The server parses the header again and caps every field (it is untrusted).
 */

export const CLIENT_HEADER = 'x-nivaro-client'
const TAB_KEY = 'nvr-tab-id'

export interface ClientVersion {
  build: string | null
  api: string | null
  tab: string
  loaded: number
  /** Force-reload instruction ids this tab already reloaded for (absent = none). */
  obeyed?: string[]
}

const loaded = Date.now()
let build: string | null = null
let api: string | null = null
let tab: string | null = null

function randomId(): string {
  try {
    const a = new Uint8Array(8)
    crypto.getRandomValues(a)
    return Array.from(a, (b) => b.toString(36).padStart(2, '0'))
      .join('')
      .slice(0, 12)
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  }
}

function clean(v: unknown, max = 60): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().replace(/[^\w.+@-]/g, '')
  return s ? s.slice(0, max) : null
}

function tabId(): string {
  if (tab) return tab
  try {
    const stored = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(TAB_KEY) : null
    tab = clean(stored, 24) ?? randomId()
    if (stored !== tab && typeof sessionStorage !== 'undefined')
      sessionStorage.setItem(TAB_KEY, tab)
  } catch {
    tab = randomId()
  }
  return tab
}

/** The bundle this tab runs. Called once at boot by the host. */
export function setClientBuild(value: string | null | undefined): void {
  build = clean(value)
}

/** Remember the first API version this tab talked to (later answers never replace it). */
export function noteApiVersion(value: string | null | undefined): void {
  if (api) return
  const v = clean(value)
  if (v) api = v
}

/** The build fields, plus `obeyed` (the sticky-refresh marker) when this tab has one. */
export function clientVersion(): ClientVersion {
  const obeyed = obeyedReloads()
  return obeyed.length ? { ...baseVersion(), obeyed } : baseVersion()
}

function baseVersion(): ClientVersion {
  return { build, api, tab: tabId(), loaded }
}

// ─── Force-reload marker (sticky refresh) ─────────────────────────────────────
// Per tab (sessionStorage, like the tab id): the force-reload instructions this tab already
// reloaded for, and how often. client:hello carries the ids (`obeyed`) so the server never
// sends a remembered instruction again, and the banner refuses one past its cap — a tab whose
// reload still lands on the old bundle (a cached one) must not reload forever.
const RELOADS_KEY = 'nvr-fr-obeyed'
const RELOADS_KEPT = 30

function readReloads(): Record<string, number> {
  try {
    const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(RELOADS_KEY) : null
    const v = raw ? (JSON.parse(raw) as unknown) : null
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {}
  } catch {
    return {}
  }
}

/** Instruction ids this tab reloaded for (newest last). */
export function obeyedReloads(): string[] {
  return Object.keys(readReloads())
}

/** How many times this tab already reloaded for `id`. */
export function reloadCountFor(id: string): number {
  return Number(readReloads()[id]) || 0
}

/** Called right before the tab reloads for `id`. */
export function markReloadFor(id: string): void {
  try {
    const all = readReloads()
    const prev = Number(all[id]) || 0
    delete all[id]
    const next = { ...all, [id]: prev + 1 }
    const keys = Object.keys(next)
    for (const k of keys.slice(0, Math.max(0, keys.length - RELOADS_KEPT))) delete next[k]
    sessionStorage.setItem(RELOADS_KEY, JSON.stringify(next))
  } catch {
    /* private mode: the server's own per-tab cap still holds */
  }
}

/** `build=…; api=…; tab=…; loaded=…` — null until the host set a build. */
export function clientVersionHeader(): string | null {
  if (!build) return null
  // Every request carries this: no sessionStorage read for the marker (client:hello has it).
  const v = baseVersion()
  return [`build=${v.build}`, v.api ? `api=${v.api}` : null, `tab=${v.tab}`, `loaded=${v.loaded}`]
    .filter(Boolean)
    .join('; ')
}

/** Read the API version off a response (the `X-Nivaro-Version` header every response carries). */
export function noteApiVersionFrom(res: Response | null | undefined): void {
  if (api || !res) return
  try {
    noteApiVersion(res.headers.get('x-nivaro-version'))
  } catch {
    /* opaque or headerless responses carry nothing */
  }
}
