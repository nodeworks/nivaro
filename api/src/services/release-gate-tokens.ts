import { db } from '../db/index.js'

/**
 * Admin tokens for the release chain's post-deploy gate (#1045), keyed by API
 * base URL: the `api_token` each api component holds in the Environments
 * registry. The Release card hands this map to the chain in its environment
 * (RELEASE_GATE_TOKENS); a chain started from a terminal loads it through
 * scripts/release-gate-tokens.mts. Never printed or logged.
 *
 * Best-effort: a registry that cannot be read means no tokens (the gate then
 * checks /api/ready only and says so), never a release that cannot start.
 */
export async function readGateTokens(): Promise<Record<string, string>> {
  let rows: Array<{ base_url: string; api_token: string }> = []
  try {
    rows = await db('nivaro_environment_components')
      .where('kind', 'api')
      .whereNotNull('base_url')
      .whereNotNull('api_token')
      .select('base_url', 'api_token')
  } catch {
    rows = []
  }
  const map: Record<string, string> = {}
  for (const r of rows) {
    const base = String(r.base_url).trim().replace(/\/+$/, '')
    if (base && r.api_token) map[base] = String(r.api_token)
  }
  return map
}
