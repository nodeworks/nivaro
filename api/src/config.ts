import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

// Load .env from the repo root (two levels up from api/src/)
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') })

const schema = z.object({
  PORT: z.coerce.number().default(3055),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  PUBLIC_URL: z.string().default('http://localhost:3055'),

  DB_CLIENT: z.enum(['mssql', 'pg', 'mysql2']).default('mssql'),
  DB_HOST: z.string().min(1),
  // Optional — per-client default applied in db/index.ts (mssql 1433, pg 5432, mysql2 3306)
  DB_PORT: z.coerce.number().optional(),
  DB_DATABASE: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_ENCRYPT: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  DB_TRUST_SERVER_CERT: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),

  // Read replica (optional) — when DB_READ_HOST is set, GET-heavy queries can
  // use the dbRead knex instance exported from db/index.ts.
  DB_READ_HOST: z.string().optional(),
  DB_READ_PORT: z.coerce.number().optional(),

  // Zero-downtime migrations — advisory lock prevents concurrent migration
  // runs across instances in a rolling deploy.
  MIGRATION_SAFE_MODE: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  MIGRATION_LOCK_TIMEOUT_MS: z.coerce.number().default(60_000),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  SESSION_SECRET: z.string().min(32),
  SESSION_TTL: z.coerce.number().default(604800),
  COOKIE_SECURE: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),

  OIDC_ISSUER: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  OIDC_REDIRECT_URI: z.string().url(),

  ADMIN_URL: z.string().default('http://localhost:3056'),

  INNGEST_EVENT_KEY: z.string().default('local'),
  INNGEST_SIGNING_KEY: z.string().default('local'),

  MAIL_FROM: z.string().default('noreply@example.com'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_SECURE: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),

  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('./uploads'),

  ANTHROPIC_API_KEY: z.string().optional()
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  console.error('Invalid environment configuration:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const config = parsed.data
export type Config = typeof config
