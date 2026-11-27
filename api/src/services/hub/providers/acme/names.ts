import { ProviderError } from '../types.js'
import { allowedDomains, HOST_RE } from './client.js'

/** Most names one certificate may carry (Let's Encrypt allows 100). */
export const MAX_NAMES = 100

export interface ParsedName {
  /** As written, lower-case: 'example.com' or '*.example.com'. */
  name: string
  wildcard: boolean
  /** The host without any `*.`. */
  base: string
}

/** Lower-cases and checks every name; a wildcard is only `*.` in front of a plain host. */
export function parseNames(input: unknown): ParsedName[] {
  const list = Array.isArray(input) ? input : []
  if (!list.length)
    throw new ProviderError('INVALID_FIELDS', 'A certificate needs at least one name.')
  if (list.length > MAX_NAMES)
    throw new ProviderError('INVALID_FIELDS', `A certificate can carry at most ${MAX_NAMES} names.`)
  const seen = new Set<string>()
  const out: ParsedName[] = []
  for (const raw of list) {
    const name = String(raw ?? '')
      .trim()
      .toLowerCase()
    const wildcard = name.startsWith('*.')
    const base = wildcard ? name.slice(2) : name
    if (!HOST_RE.test(base))
      throw new ProviderError(
        'INVALID_FIELDS',
        `“${name.slice(0, 80)}” is not a valid certificate name. Use a host name such as app.example.com or *.example.com (punycode for non-ASCII names).`
      )
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ name, wildcard, base })
  }
  return out
}

export const sortedNames = (names: string[]): string[] =>
  [...new Set(names.map((n) => String(n).trim().toLowerCase()))].sort()

export const sameNames = (a: string[], b: string[]): boolean =>
  JSON.stringify(sortedNames(a)) === JSON.stringify(sortedNames(b))

/** `host` is the zone itself or a subdomain of it. */
export function insideZone(base: string, zoneName: string): boolean {
  const z = zoneName.toLowerCase().replace(/\.$/, '')
  return base === z || base.endsWith(`.${z}`)
}

/** Refuses a name outside the DNS zone or the connection's allowed domains. */
export function checkNamesAllowed(
  names: ParsedName[],
  zoneName: string,
  config: Record<string, unknown>
): void {
  const allowed = allowedDomains(config)
  for (const n of names) {
    if (!insideZone(n.base, zoneName))
      throw new ProviderError(
        'NAME_OUTSIDE_ZONE',
        `${n.name} is not inside the DNS zone ${zoneName}. One certificate uses one zone.`
      )
    if (allowed.length && !allowed.some((d) => insideZone(n.base, d)))
      throw new ProviderError(
        'NAME_NOT_ALLOWED',
        `${n.name} is not under one of this connection's allowed domains.`
      )
  }
}

export const challengeName = (base: string): string => `_acme-challenge.${base}`
