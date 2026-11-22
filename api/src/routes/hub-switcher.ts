import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import { hubLinkToken, hubUrl } from '../services/hub/mode.js'
import { hubSigninConfig, hubSigninProblems } from '../services/hub-signin/config.js'
import { fetchSwitcher, type LinkDeps } from '../services/hub-signin/link-client.js'
import { hubSigninUp } from '../services/hub-signin/probe.js'
import { registerReadinessCheck } from '../services/readiness.js'

/**
 * App switcher (Hub phase 7, app side).
 *
 *   GET /api/hub-switcher   (signed in) → { data: { apps, unavailable } }
 *
 * The other apps this person uses through the Hub (services/hub-signin/link-client.ts). 404 unless
 * HUB_URL and HUB_TOKEN are set (feature `hub_switcher` in /api/app-info; never in cloud mode).
 * Only a person on their own browser session gets a list: View-as, API keys, OAuth/MCP, phone
 * and static-token callers get `{ apps: [], unavailable: false }` and the Hub is never asked.
 *
 * Also registers the readiness check `hub-signin` (group Sign-in): passes with no Hub sign-in env
 * set, warns naming what is missing or when the Hub does not answer; never fails (people can
 * always sign in directly with Microsoft).
 */

export function hubSwitcherEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!hubUrl(env) && !!hubLinkToken(env)
}

/** An Entra v1 issuer (https://sts.windows.net/<tenant>/): its tokens differ from v2.0 ones. */
function entraV1Issuer(raw: string | undefined): boolean {
  try {
    return new URL((raw ?? '').trim()).hostname.toLowerCase() === 'sts.windows.net'
  } catch {
    return false
  }
}

export function registerHubSigninReadiness(
  deps: { up?: typeof hubSigninUp; env?: NodeJS.ProcessEnv } = {}
): void {
  registerReadinessCheck({
    id: 'hub-signin',
    label: 'Sign-in through the Hub',
    group: 'Sign-in',
    description:
      'When this app signs in through the Nivaro Hub: its settings are complete and the Hub answers.',
    run: async () => {
      const env = deps.env ?? process.env
      const problems = hubSigninProblems(env)
      if (problems.length)
        return {
          status: 'warn',
          detail: `Hub sign-in is set up partly: fix ${problems.join(', ')}. People sign in directly with Microsoft until then.`,
          blockers: problems.map((p) => `Set or fix ${p}`)
        }
      const cfg = hubSigninConfig(env)
      if (!cfg) return { status: 'pass', detail: 'Hub sign-in is not set up here.' }
      if (entraV1Issuer(env.OIDC_ISSUER))
        return {
          status: 'warn',
          detail:
            'OIDC_ISSUER is an Entra v1 issuer (sts.windows.net): Hub sign-in needs the Hub and app to use the same token version.',
          blockers: ['Use the v2.0 issuer (https://login.microsoftonline.com/<tenant>/v2.0)']
        }
      const up = await (deps.up ?? hubSigninUp)(cfg)
      if (!up)
        return {
          status: 'warn',
          detail:
            'The Hub does not answer: people sign in directly with Microsoft until the Hub answers.'
        }
      return { status: 'pass', detail: 'People sign in through the Hub.' }
    }
  })
}

export async function hubSwitcherRoutes(app: FastifyInstance, opts: { linkDeps?: LinkDeps } = {}) {
  registerHubSigninReadiness()

  app.get('/hub-switcher', { preHandler: requireAuth }, async (req, reply) => {
    if (!hubSwitcherEnabled()) return reply.code(404).send({ error: 'Not found' })
    reply.header('Cache-Control', 'private, no-store')
    const user = req.user
    if (!user || req.authMethod !== 'session' || req.masqueradeAdminId)
      return { data: { apps: [], unavailable: false } }
    const data = await fetchSwitcher(
      app.redis,
      { id: String(user.id), email: (user.email as string | null | undefined) ?? null },
      opts.linkDeps
    )
    return { data }
  })
}
