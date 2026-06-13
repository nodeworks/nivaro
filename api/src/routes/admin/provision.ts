import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import knex from 'knex'
import { migrationSource } from '../../db/index.js'

// Only registered in cloud mode (when CLOUD_META_DB_URL is set).
// Self-hosted users never see this route.
export async function adminProvisionRoutes(app: FastifyInstance) {
  // Migrate only — runs pending migrations on an existing tenant DB (no seeding)
  app.post('/admin/migrate', async (req, reply) => {
    const secret = req.headers['x-provision-secret']
    if (!secret || secret !== process.env.PROVISION_SECRET) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const { connectionString, dbClient } = req.body as {
      connectionString: string
      dbClient: 'pg' | 'mssql' | 'mysql2'
    }

    if (!connectionString || !dbClient) {
      return reply.code(400).send({ error: 'connectionString and dbClient required' })
    }

    const db = knex({
      client: dbClient,
      connection: connectionString,
      pool: { min: 1, max: 3 },
      migrations: { migrationSource, tableName: 'nivaro_migrations' }
    })

    try {
      const [batch, migrations] = await db.migrate.latest()
      app.log.info({ batch, count: migrations.length }, 'Tenant migrations applied')
      return { ok: true, batch, migrations }
    } catch (err: any) {
      app.log.error({ err }, 'Tenant migration failed')
      return reply.code(500).send({ error: err.message })
    } finally {
      await db.destroy()
    }
  })


  app.post('/admin/provision', async (req, reply) => {
    const secret = req.headers['x-provision-secret']
    if (!secret || secret !== process.env.PROVISION_SECRET) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const { connectionString, dbClient, slug, name, adminEmail } = req.body as {
      connectionString: string
      dbClient: 'pg' | 'mssql' | 'mysql2'
      slug: string
      name: string
      adminEmail: string
    }

    if (!connectionString || !dbClient || !slug || !adminEmail) {
      return reply.code(400).send({ error: 'connectionString, dbClient, slug, adminEmail required' })
    }

    const db = knex({
      client: dbClient,
      connection: connectionString,
      pool: { min: 1, max: 3 },
      migrations: { migrationSource, tableName: 'nivaro_migrations' }
    })

    try {
      // Run pending migrations. If DB was cloned from nivaro_template, only
      // new migrations since the template was built will run. On a fresh DB
      // (no template), 000_base_schema creates all tables first.
      await db.migrate.latest()

      // Seed workspace, admin role, admin user
      const workspaceId = randomUUID()
      const roleId = randomUUID()
      const userId = randomUUID()
      const staticToken = randomUUID().replace(/-/g, '')

      await db('nivaro_workspaces').insert({
        id: workspaceId,
        name,
        slug,
        icon: '📦',
        color: '#00ceff',
      })

      await db('nivaro_roles').insert({
        id: roleId,
        name: 'Administrator',
        admin_access: true,
        app_access: true,
        workspace: workspaceId,
      })

      await db('nivaro_users').insert({
        id: userId,
        email: adminEmail,
        first_name: 'Admin',
        last_name: '',
        role: roleId,
        status: 'active',
        static_token: staticToken,
        current_workspace: workspaceId,
      })

      app.log.info({ slug }, 'Tenant provisioned — migrations and seed complete')
      return { ok: true, userId, workspaceId, staticToken }
    } catch (err: any) {
      app.log.error({ err, slug }, 'Tenant provisioning failed')
      return reply.code(500).send({ error: err.message })
    } finally {
      await db.destroy()
    }
  })
}
