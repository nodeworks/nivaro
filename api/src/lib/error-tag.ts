/**
 * An engine error code or name worth logging: short word characters only, never the message.
 * knex inlines bound values (sealed secrets, emails) into its error messages, so code that must
 * not leak them logs this tag with a fixed line instead of the error.
 */
export function errorTag(e: unknown): string {
  const err = e as { code?: unknown; number?: unknown; name?: unknown }
  for (const v of [err?.code, err?.number, err?.name]) {
    const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : ''
    if (/^[A-Za-z0-9_]{1,40}$/.test(s)) return s
  }
  return 'unknown'
}
