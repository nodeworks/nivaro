/**
 * One-shot script to create and migrate the nivaro_template database.
 * Run via: railway run --service <nivaro-api-service> pnpm setup:template
 *
 * The template DB is cloned for every new tenant provisioned via Nivaro Cloud,
 * so all tenant DBs start with the full schema without running migrations.
 *
 * After running this, future schema changes work like this:
 *   1. Add a new migration file (e.g. 001_new_feature.ts)
 *   2. Run this script again → template gets the new migration
 *   3. Run pnpm migrate-all in Nivaro Cloud → all existing tenants updated
 *   4. New tenants cloned from template already have the new migration
 */

// @ts-ignore — no @types/pg; pg types not needed for this one-shot script
import pg from 'pg'
import knex from 'knex'
import { migrationSource } from './index.js'

const TEMPLATE_DB = 'nivaro_template'

async function main() {
  // Resolve admin connection string
  const adminUrl = process.env.DATABASE_URL ?? process.env.CLOUD_META_DB_URL
  if (!adminUrl) {
    console.error('DATABASE_URL or CLOUD_META_DB_URL must be set')
    process.exit(1)
  }

  const adminUrlObj = new URL(adminUrl)
  const adminDb = adminUrlObj.pathname.replace(/^\//, '') || 'postgres'

  // Connect to the admin DB to create/verify the template DB
  const adminConnStr = adminUrl.replace(adminUrlObj.pathname, '/postgres')
  const adminClient = new pg.Client(adminConnStr)
  await adminClient.connect()

  try {
    // Terminate existing connections to template DB (required before DROP/CREATE)
    await adminClient.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `, [TEMPLATE_DB])

    // Create template DB if it doesn't exist
    const exists = await adminClient.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [TEMPLATE_DB]
    )

    if (exists.rows.length === 0) {
      console.log(`Creating ${TEMPLATE_DB}...`)
      await adminClient.query(`CREATE DATABASE "${TEMPLATE_DB}"`)
      console.log(`${TEMPLATE_DB} created`)
    } else {
      console.log(`${TEMPLATE_DB} already exists — will run any pending migrations`)
    }
  } finally {
    await adminClient.end()
  }

  // Connect to the template DB and run all migrations
  const templateConnStr = adminUrl.replace(adminUrlObj.pathname, `/${TEMPLATE_DB}`)
  const db = knex({
    client: 'pg',
    connection: templateConnStr,
    pool: { min: 1, max: 3 },
    migrations: { migrationSource, tableName: 'nivaro_migrations' }
  })

  try {
    console.log(`Running migrations on ${TEMPLATE_DB}...`)
    const [batch, migrations] = await db.migrate.latest()
    if (migrations.length === 0) {
      console.log(`${TEMPLATE_DB} is already up to date`)
    } else {
      console.log(`Batch ${batch}: applied ${migrations.length} migration(s)`)
      migrations.forEach((m: string) => console.log(`  ✓ ${m}`))
    }
    console.log(`\n✓ ${TEMPLATE_DB} is ready — new tenant DBs will clone from it`)
  } finally {
    await db.destroy()
  }
}

main().catch((err) => {
  console.error('setup:template failed:', err.message)
  process.exit(1)
})
