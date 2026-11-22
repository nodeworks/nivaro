// Does an environment's name work yet (phase 3, decision 9)? Two halves, each answered on its
// own so "Check now" says which is missing: the hostname resolves (DNS), and
// `<base_url>/api/version` answers the expected version (the edge routes the name to the new
// app, not to an old one or nothing). No timeout ends a wait: a name that never works keeps the
// environment `waiting_for_name`; that is the caller's business, this only looks.
//
// The request carries no credential, follows no redirect (`redirect: 'error'`) and is bounded.
import { lookup as dnsLookup } from 'node:dns/promises'
import { fetchJson } from '../../gitlab-client.js'

export interface NameCheck {
  resolves: boolean
  serves: boolean
  /** The version /api/version answered, null when nothing answered one. */
  version: string | null
  text: string
}

export const NAME_CHECK_TIMEOUT_MS = 8000

function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

function versionUrl(baseUrl: string): string | null {
  let u: URL
  try {
    u = new URL(String(baseUrl).trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password) return null
  return `${u.origin}/api/version`
}

const short = (v: string) => (v.length > 64 ? `${v.slice(0, 64)}…` : v)

/**
 * Checks `hostname` and `<baseUrl>/api/version`. `version` is the version the environment must
 * serve; an empty `version` accepts any version that answers.
 */
export async function checkName(
  hostname: string,
  baseUrl: string,
  version: string,
  deps: {
    lookup?: (h: string) => Promise<unknown>
    fetchJson?: typeof fetchJson
    timeoutMs?: number
  } = {}
): Promise<NameCheck> {
  const timeoutMs = deps.timeoutMs ?? NAME_CHECK_TIMEOUT_MS
  const lookup = deps.lookup ?? ((h: string) => dnsLookup(h, { all: true }))
  const get = deps.fetchJson ?? fetchJson
  const host = typeof hostname === 'string' ? hostname.trim().toLowerCase() : ''
  const want = typeof version === 'string' ? version.trim() : ''
  const waitsFor = want ? `version ${want}` : 'a version'

  let resolves = false
  if (host) {
    try {
      const found = await bounded(Promise.resolve(lookup(host)), timeoutMs)
      resolves = !Array.isArray(found) || found.length > 0
    } catch {
      resolves = false
    }
  }
  if (!resolves)
    return {
      resolves: false,
      serves: false,
      version: null,
      text: `${short(host || '(no hostname)')} does not resolve yet.`
    }

  const url = versionUrl(baseUrl)
  if (!url)
    return {
      resolves: true,
      serves: false,
      version: null,
      text: `${short(host)} resolves, but the environment has no http(s) address to ask for its version.`
    }

  let answered: string | null = null
  let why = ''
  try {
    const res = await bounded(
      get(url, { accept: 'application/json' }, timeoutMs, { redirect: 'error' }),
      timeoutMs + 1000
    )
    const v = (res.body as { version?: unknown } | null)?.version
    if (res.ok && typeof v === 'string' && v.trim()) answered = v.trim().slice(0, 64)
    else why = res.ok ? 'it answered without a version' : `it answered HTTP ${res.status}`
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    why = code === 'FETCH_REDIRECT' ? 'it answered with a redirect' : 'nothing answered'
  }

  if (answered === null)
    return {
      resolves: true,
      serves: false,
      version: null,
      text: `${short(host)} resolves but does not serve ${waitsFor} yet (${why}).`
    }
  if (want && answered !== want)
    return {
      resolves: true,
      serves: false,
      version: answered,
      text: `${short(host)} resolves but serves version ${answered}, not ${want}.`
    }
  return {
    resolves: true,
    serves: true,
    version: answered,
    text: `${short(host)} resolves and serves version ${answered}.`
  }
}
