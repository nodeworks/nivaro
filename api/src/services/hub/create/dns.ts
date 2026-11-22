// DNS names for Hub creation targets and the apps they create. Pure functions, shared by
// targets.ts (validating a target) and app-config.ts (making an environment's hostname).

export const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * A DNS suffix (`apps.example.com`, `localhost`), lower-cased; a leading `*.` and trailing `.`
 * dropped. At least two labels, except the single names `localhost` and `test`.
 */
export function dnsSuffix(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')
  if (!s || s.length > 253) return null
  const labels = s.split('.')
  if (labels.length < 2 && s !== 'localhost' && s !== 'test') return null
  return labels.every((l) => DNS_LABEL.test(l)) ? s : null
}

/** Names that may be served over plain http: localhost and the reserved .test domain. */
export function httpAllowed(name: string | null): boolean {
  if (!name) return false
  return (
    name === 'localhost' || name.endsWith('.localhost') || name === 'test' || name.endsWith('.test')
  )
}
