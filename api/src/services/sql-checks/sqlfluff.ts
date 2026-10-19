/**
 * Optional SQLFluff sidecar for the SQL checks (#2562). SQL_LINT_URL points at a small service
 * that runs SQLFluff (T-SQL dialect); SQL_LINT_TOKEN is its bearer token (a secret: never logged;
 * SQL_LINT_TOKEN_FILE works like every other secret).
 *
 *   POST {SQL_LINT_URL}/lint   authorization: Bearer <token>
 *   body     {sql, dialect: 'tsql', rules?: string[]}
 *   200      {violations: [{code, line, description}], parse_errors: number}
 *   401      bad / missing token        → the whole run marks SQLFluff unavailable
 *   503      busy                       → retried with a short backoff, then unavailable
 *   504      this module timed out      → recorded for that module, the run continues
 *
 * Only module text is sent — never data. Only correctness rules become findings (KEEP_CODES);
 * layout and style rules are dropped here even if the sidecar reports them.
 */

export interface LintViolation {
  code: string
  line: number
  description: string
}

export type LintResult =
  | { ok: true; violations: LintViolation[]; parseErrors: number }
  | { ok: false; reason: 'timeout' | 'unavailable' | 'unauthorized' | 'error'; status?: number }

/** Correctness rules worth a finding: ambiguity, references, unused CTEs, joins in subqueries. */
const KEEP = /^(AM0[1-7]|RF0[12]|ST0[35])$/

export function keepLintCode(code: string): boolean {
  return KEEP.test(code)
}

export function lintConfig(): { url: string; token: string | null } | null {
  const url = process.env.SQL_LINT_URL?.trim().replace(/\/+$/, '')
  if (!url) return null
  return { url, token: process.env.SQL_LINT_TOKEN?.trim() || null }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>
let transport: Fetch = (url, init) => fetch(url, init)
export function setLintFetchForTests(f: Fetch | null): void {
  transport = f ?? ((url, init) => fetch(url, init))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Lint one module's text. Retries a busy sidecar (503) up to `retries` times. */
export async function lintSql(
  sql: string,
  opts: { timeoutMs?: number; retries?: number; backoffMs?: number } = {}
): Promise<LintResult> {
  const cfg = lintConfig()
  if (!cfg) return { ok: false, reason: 'unavailable' }
  const retries = opts.retries ?? 3
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await transport(`${cfg.url}/lint`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {})
        },
        body: JSON.stringify({ sql, dialect: 'tsql' }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000)
      })
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      return { ok: false, reason: name === 'TimeoutError' ? 'timeout' : 'unavailable' }
    }
    if (res.status === 503 && attempt < retries) {
      await sleep((opts.backoffMs ?? 500) * (attempt + 1))
      continue
    }
    if (res.status === 401 || res.status === 403)
      return { ok: false, reason: 'unauthorized', status: res.status }
    if (res.status === 504) return { ok: false, reason: 'timeout', status: 504 }
    if (res.status === 503) return { ok: false, reason: 'unavailable', status: 503 }
    if (!res.ok) return { ok: false, reason: 'error', status: res.status }
    try {
      const body = (await res.json()) as {
        violations?: Array<{ code?: unknown; line?: unknown; description?: unknown }>
        parse_errors?: unknown
      }
      const violations = (body.violations ?? [])
        .map((v) => ({
          code: String(v.code ?? ''),
          line: Number(v.line) || 0,
          description: String(v.description ?? '').slice(0, 300)
        }))
        .filter((v) => v.code)
      return { ok: true, violations, parseErrors: Number(body.parse_errors) || 0 }
    } catch {
      return { ok: false, reason: 'error', status: res.status }
    }
  }
}
