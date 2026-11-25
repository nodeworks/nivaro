// Every refusal code the Hub's database, server and connection routes can answer. The admin's
// Databases tab keeps plain copy for each (admin/src/pages/hub/databases/db-api.ts) and a test
// compares that copy with this list, so a new code without words fails there. HubDbError and the
// server input validator are typed against it.
export const HUB_DB_CODES = [
  // Input
  'BAD_NAME',
  'BAD_ENGINE',
  'BAD_HOST',
  'BAD_PORT',
  'BAD_MODE',
  'BAD_SSL',
  'BAD_COLLATION',
  'BAD_USER_HOST',
  'BAD_NOTES',
  'BAD_SECRET',
  'BAD_CONNECTION',
  'BAD_DROP',
  // Servers and logins
  'ADMIN_REQUIRED',
  'SECRET_REQUIRED',
  'LOGIN_HALF_MASKED',
  'SERVER_IN_USE',
  'IN_USE',
  'NAME_TAKEN',
  'SERVER_MOVED',
  'NOT_AUTOMATIC',
  'NOT_MANUAL',
  'ENGINE_MISMATCH',
  'ENGINE_NOT_PROVISIONABLE',
  // Names
  'DATABASE_NAME_INVALID',
  'LOGIN_NAME_INVALID',
  'UNSAFE_IDENTIFIER',
  'RESERVED_NAME',
  'LOGIN_EXISTS',
  'DATABASE_EXISTS',
  'NOT_OWNED',
  'DATABASE_RECORDED',
  'DATABASE_IN_USE',
  // State
  'NOT_FOUND',
  // Create app (routes/hub-create.ts): keeping a template role's admin access (review M2)
  'OWN_SESSION_REQUIRED',
  'NOT_READY',
  'DATABASE_NOT_READY',
  'NOT_WAITING',
  'NO_CONNECTION',
  'DATABASE_DROPPING',
  'PROVISION_RUNNING',
  'LOCK_UNAVAILABLE',
  'STATE_CHANGED',
  'CONNECTION_UNREADABLE',
  'HUB_SECRET_UNREADABLE',
  'HUB_SECRET_NOT_SEALED',
  'HUB_NEEDS_ENCRYPTION_KEY',
  // Delete and drop
  'CONFIRM_REQUIRED',
  'DROP_NOT_ALLOWED',
  // What a check found
  'DATABASE_UNREACHABLE',
  'DATABASE_TOO_OLD',
  'DATABASE_NO_RIGHTS',
  'DATABASE_NOT_NIVARO',
  'DATABASE_NOT_EMPTY',
  // Owners (ruling P3-24) and the Hub itself
  'HOST_NOT_SERVER',
  'TOO_MANY_TRIES',
  'DB_ERROR',
  'HUB_ERROR',
  // A SQLite app's database (0.3.215): a file its shared deployment keeps
  'SQLITE_FILE'
] as const

export type HubDbCode = (typeof HUB_DB_CODES)[number]
