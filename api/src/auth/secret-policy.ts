/**
 * Boot-time rules for the session secret and the session cookie (security audit 2026-10-27,
 * H4/H5/M13). A leaf module — no config import — so config.ts and tests can both use it.
 *
 * SESSION_SECRET signs sessions, approval links, help-video tickets, keyset cursors and Teams
 * links: a value anyone can read (a placeholder from an example file, the old cloud default)
 * lets an anonymous caller forge any of them. The API refuses to boot with one, in every mode.
 */

/** Values published in this repo (example files, the old cloud default) — never a real secret. */
export const KNOWN_PLACEHOLDER_SECRETS: ReadonlySet<string> = new Set([
  'change_this_to_a_long_random_string_minimum_32_chars',
  'cloud-mode-session-secret-placeholder-32ch'
])

export const SESSION_SECRET_MIN_LENGTH = 32

/** How to make one, for the boot error and the example files. */
export const SESSION_SECRET_HINT = 'generate one with: openssl rand -hex 32'

/**
 * Why `secret` cannot sign anything, or null when it can. Missing, shorter than 32 characters,
 * a known placeholder, or so repetitive it is not random (fewer than 8 distinct characters).
 */
export function sessionSecretProblem(secret: string | undefined | null): string | null {
  const s = typeof secret === 'string' ? secret : ''
  if (!s.trim()) return `SESSION_SECRET is not set — ${SESSION_SECRET_HINT}`
  if (s.length < SESSION_SECRET_MIN_LENGTH)
    return `SESSION_SECRET must be at least ${SESSION_SECRET_MIN_LENGTH} characters — ${SESSION_SECRET_HINT}`
  if (KNOWN_PLACEHOLDER_SECRETS.has(s.trim()))
    return `SESSION_SECRET is the placeholder from an example file — ${SESSION_SECRET_HINT}`
  if (new Set(s).size < 8)
    return `SESSION_SECRET is not random enough (too few distinct characters) — ${SESSION_SECRET_HINT}`
  return null
}

/**
 * The session cookie's Secure flag. An explicit COOKIE_SECURE (true/false) always wins;
 * unset, it is on when the public or admin URL is https — a deployment served over TLS should
 * never send its session cookie over plain HTTP — and off otherwise (local plain-HTTP dev).
 */
export function resolveCookieSecure(env: {
  COOKIE_SECURE?: string
  PUBLIC_URL?: string
  ADMIN_URL?: string
}): boolean {
  const raw = env.COOKIE_SECURE?.trim().toLowerCase()
  if (raw === 'true') return true
  if (raw === 'false') return false
  return [env.PUBLIC_URL, env.ADMIN_URL].some((u) => /^https:\/\//i.test(String(u ?? '').trim()))
}
