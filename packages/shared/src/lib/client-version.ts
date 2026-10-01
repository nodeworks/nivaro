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

export function clientVersion(): ClientVersion {
  return { build, api, tab: tabId(), loaded }
}

/** `build=…; api=…; tab=…; loaded=…` — null until the host set a build. */
export function clientVersionHeader(): string | null {
  if (!build) return null
  const v = clientVersion()
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
