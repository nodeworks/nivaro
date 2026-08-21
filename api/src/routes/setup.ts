import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'

/**
 * Instance setup checklist (#34): first-run admin page with LIVE done/not-done
 * detection — connect SMTP, configure OIDC, create a collection, invite
 * users, branding, AI key. Detection reads what's actually configured, never
 * a "mark complete" bit that can drift from reality.
 */
export async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/status', async () => {
    const settings = ((await db('nivaro_settings').where({ id: 1 }).first().catch(() => undefined)) ??
      {}) as Record<string, unknown>

    const [collectionCount, userCount, roleCount, flowCount, layoutCount] = await Promise.all([
      db('nivaro_collections')
        .whereNot('collection', 'like', 'nivaro_%')
        .count({ c: '*' })
        .first()
        .then((r) => Number((r as { c?: number | string } | undefined)?.c ?? 0))
        .catch(() => 0),
      db('nivaro_users')
        .where((qb) => qb.whereNull('status').orWhereNot('status', 'suspended'))
        .count({ c: '*' })
        .first()
        .then((r) => Number((r as { c?: number | string } | undefined)?.c ?? 0))
        .catch(() => 0),
      db('nivaro_roles')
        .where({ admin_access: false })
        .count({ c: '*' })
        .first()
        .then((r) => Number((r as { c?: number | string } | undefined)?.c ?? 0))
        .catch(() => 0),
      db('nivaro_flows')
        .count({ c: '*' })
        .first()
        .then((r) => Number((r as { c?: number | string } | undefined)?.c ?? 0))
        .catch(() => 0),
      db('nivaro_collection_layouts')
        .count({ c: '*' })
        .first()
        .then((r) => Number((r as { c?: number | string } | undefined)?.c ?? 0))
        .catch(() => 0)
    ])

    const checks = [
      {
        id: 'smtp',
        label: 'Connect email (SMTP)',
        done: !!(settings.smtp_host || config.SMTP_HOST),
        detail: settings.smtp_host
          ? `Configured in Settings (${settings.smtp_host})`
          : config.SMTP_HOST
            ? `Configured via env (${config.SMTP_HOST})`
            : 'No SMTP host — outgoing mail silently no-ops',
        link: '/settings'
      },
      {
        id: 'oidc',
        label: 'Configure single sign-on (OIDC)',
        done: !!config.OIDC_ISSUER && !!config.OIDC_CLIENT_ID,
        detail: config.OIDC_ISSUER
          ? `Issuer: ${config.OIDC_ISSUER}`
          : 'OIDC env vars not set — password login only',
        link: '/settings'
      },
      {
        id: 'collections',
        label: 'Create your first collection',
        done: collectionCount > 0,
        detail: `${collectionCount} business collection(s) registered`,
        link: '/data-model'
      },
      {
        id: 'roles',
        label: 'Create a non-admin role',
        done: roleCount > 0,
        detail: `${roleCount} non-admin role(s)`,
        link: '/roles'
      },
      {
        id: 'users',
        label: 'Invite your team',
        done: userCount > 1,
        detail: `${userCount} active user(s)`,
        link: '/users'
      },
      {
        id: 'layout',
        label: 'Design a record layout',
        done: layoutCount > 0,
        detail: `${layoutCount} layout(s)`,
        link: '/data-model'
      },
      {
        id: 'branding',
        label: 'Brand the instance',
        done: !!(settings.project_name || settings.brand_logo),
        detail: settings.project_name ? `Named "${settings.project_name}"` : 'Default Nivaro branding',
        link: '/settings'
      },
      {
        id: 'automation',
        label: 'Build your first flow (optional)',
        done: flowCount > 0,
        detail: `${flowCount} flow(s)`,
        link: '/flows',
        optional: true
      },
      {
        id: 'ai',
        label: 'Add an AI key (optional)',
        done: !!(settings.anthropic_api_key || config.ANTHROPIC_API_KEY),
        detail: settings.anthropic_api_key || config.ANTHROPIC_API_KEY ? 'AI features available' : 'AI features disabled',
        link: '/settings',
        optional: true
      }
    ]
    const required = checks.filter((c) => !c.optional)
    return {
      data: {
        checks,
        done: required.filter((c) => c.done).length,
        total: required.length
      }
    }
  })
}
