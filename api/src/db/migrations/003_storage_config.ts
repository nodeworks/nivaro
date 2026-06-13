import type { Knex } from 'knex'

/**
 * Adds per-tenant storage configuration columns to nivaro_settings.
 * Written by /admin/configure-storage when the gateway provisions storage
 * for a tenant. In self-hosted mode these columns are unused.
 *
 * All columns are nullable so existing rows are unaffected.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.string('storage_provider', 50).nullable()      // 's3' | 'azure' | 'local'
    t.string('storage_s3_bucket', 255).nullable()
    t.string('storage_s3_endpoint', 500).nullable()
    t.string('storage_s3_access_key', 255).nullable()
    t.string('storage_s3_secret', 500).nullable()
    t.string('storage_s3_region', 50).nullable()
    t.string('storage_cdn_url', 500).nullable()
    t.string('storage_key_prefix', 255).nullable()   // e.g. '{slug}/'
    t.string('gateway_url', 500).nullable()
    t.string('provision_secret', 500).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('storage_provider')
    t.dropColumn('storage_s3_bucket')
    t.dropColumn('storage_s3_endpoint')
    t.dropColumn('storage_s3_access_key')
    t.dropColumn('storage_s3_secret')
    t.dropColumn('storage_s3_region')
    t.dropColumn('storage_cdn_url')
    t.dropColumn('storage_key_prefix')
    t.dropColumn('gateway_url')
    t.dropColumn('provision_secret')
  })
}
