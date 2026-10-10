/**
 * The page:at socket ping (presence map, "who else is here", journeys) —
 * validation in one place so the admin and the portal (#1391) are read the
 * same way.
 *
 * `path`: same-origin absolute path only — never persist something that could
 * later render as a javascript:/protocol-relative link in the admin.
 * `app`: which front end sent it. The ping's own label wins; else the label the
 * socket gave in client:hello; else null (an older admin build, which is the
 * admin). Labels are short plain tokens — anything else drops to the fallback.
 */

const PATH_RE = /^\/(?!\/)[A-Za-z0-9/_\-?=&.%~]*$/
const APP_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,49}$/

export function cleanAppLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  return APP_RE.test(v) ? v : null
}

export function parsePageAt(
  payload: unknown,
  helloApp: string | null | undefined
): { path: string; app: string | null } | null {
  const p = payload as { path?: unknown; app?: unknown } | null | undefined
  if (typeof p?.path !== 'string' || !PATH_RE.test(p.path)) return null
  return {
    path: p.path.slice(0, 200),
    app: cleanAppLabel(p.app) ?? cleanAppLabel(helloApp)
  }
}
