import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import knex from 'knex'
import { migrationSource } from '../../db/index.js'

// Only registered in cloud mode (when CLOUD_META_DB_URL is set).
// Self-hosted users never see this route.
export async function adminProvisionRoutes(app: FastifyInstance) {
  // Migrate only — runs pending migrations on an existing tenant DB (no seeding)
  // Migration status — returns applied + pending migration names without running anything
  app.post('/admin/migration-status', async (req, reply) => {
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
      const [completed, pending] = await db.migrate.list()
      const appliedNames: string[] = completed.map((m: { name?: string; file?: string } | string) =>
        typeof m === 'string' ? m : (m.name ?? m.file ?? String(m))
      )
      const pendingNames: string[] = pending.map((m: { name?: string; file?: string } | string) =>
        typeof m === 'string' ? m : (m.name ?? m.file ?? String(m))
      )
      return { ok: true, applied: appliedNames, pending: pendingNames, upToDate: pendingNames.length === 0 }
    } catch (err: any) {
      app.log.error({ err }, 'Migration status check failed')
      return reply.code(500).send({ error: err.message })
    } finally {
      await db.destroy()
    }
  })

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

    const { connectionString, dbClient, slug, name, adminEmail, firstName, lastName } = req.body as {
      connectionString: string
      dbClient: 'pg' | 'mssql' | 'mysql2'
      slug: string
      name: string
      adminEmail: string
      firstName?: string
      lastName?: string
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
        first_name: firstName || 'Admin',
        last_name: lastName || '',
        role: roleId,
        status: 'active',
        static_token: staticToken,
        current_workspace: workspaceId,
      })

      // Update project_name in settings to the tenant's company name
      await db('nivaro_settings').update({ project_name: name }).catch(() => {})

      app.log.info({ slug }, 'Tenant provisioned — migrations and seed complete')
      return { ok: true, userId, workspaceId, staticToken }
    } catch (err: any) {
      app.log.error({ err, slug }, 'Tenant provisioning failed')
      return reply.code(500).send({ error: err.message })
    } finally {
      await db.destroy()
    }
  })

  // Write storage config into a tenant's nivaro_settings row.
  // Called by the gateway after provisioning, or manually to update storage creds.
  // Requires the 003_storage_config migration to have run on the tenant DB first.
  // In self-hosted mode this route is never registered (CLOUD_META_DB_URL not set).
  app.post('/admin/configure-storage', async (req, reply) => {
    const secret = req.headers['x-provision-secret']
    if (!secret || secret !== process.env.PROVISION_SECRET) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const {
      connectionString,
      dbClient,
      slug,
      storageProvider,
      bucket,
      endpoint,
      accessKeyId,
      secretAccessKey,
      region,
      cdnUrl,
      keyPrefix,
      gatewayUrl,
      provisionSecret,
    } = req.body as {
      connectionString: string
      dbClient: 'pg' | 'mssql' | 'mysql2'
      slug?: string
      storageProvider?: string
      bucket?: string
      endpoint?: string
      accessKeyId?: string
      secretAccessKey?: string
      region?: string
      cdnUrl?: string
      keyPrefix?: string
      gatewayUrl?: string
      provisionSecret?: string
    }

    if (!connectionString || !dbClient) {
      return reply.code(400).send({ error: 'connectionString and dbClient required' })
    }

    const db = knex({
      client: dbClient,
      connection: connectionString,
      pool: { min: 1, max: 3 },
    })

    try {
      // nivaro_settings is a single-row table. Fetch the row id then update it.
      const settings = await db('nivaro_settings').orderBy('id', 'asc').first('id')
      if (!settings) {
        return reply.code(500).send({ error: 'nivaro_settings row not found — has the tenant been provisioned?' })
      }

      const patch: Record<string, string | null> = {
        storage_provider: storageProvider ?? 's3',
        storage_s3_bucket: bucket ?? null,
        storage_s3_endpoint: endpoint ?? null,
        storage_s3_access_key: accessKeyId ?? null,
        storage_s3_secret: secretAccessKey ?? null,
        storage_s3_region: region ?? 'auto',
        storage_cdn_url: cdnUrl ?? null,
        storage_key_prefix: keyPrefix ?? (slug ? `${slug}/` : null),
        gateway_url: gatewayUrl ?? null,
        provision_secret: provisionSecret ?? null,
      }

      await db('nivaro_settings').where({ id: settings.id }).update(patch)

      app.log.info({ slug }, 'Storage config written to tenant settings')
      return { ok: true }
    } catch (err: any) {
      app.log.error({ err, slug }, 'configure-storage failed')
      return reply.code(500).send({ error: err.message })
    } finally {
      await db.destroy()
    }
  })
}
