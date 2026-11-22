// Names and generated secrets for the databases the Hub provisions. Pure functions.
//
// Identifiers reach DDL (CREATE DATABASE / LOGIN / USER cannot bind identifiers), so every one
// passes isDbIdentifier first. Passwords are [A-Za-z0-9] only: safe as a SQL literal, in a URL
// and in a GitLab masked variable.
import { createHash, randomBytes, randomInt } from 'node:crypto'
import type { HubDbEngine } from './connection.js'

const IDENTIFIER = /^[a-z][a-z0-9_]{1,62}$/

export function isDbIdentifier(v: unknown): v is string {
  return typeof v === 'string' && IDENTIFIER.test(v)
}

/** Lowercase, anything outside [a-z0-9] becomes '_', runs collapsed, ends trimmed. */
function slug(v: string): string {
  const s = String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return s || 'x'
}

const sha4 = (v: string) => createHash('sha1').update(v).digest('hex').slice(0, 4)

/** Fit `name` into `max` chars: longer names keep (max - 5) chars + '_' + 4 hex of sha1(name). */
function fitName(name: string, max: number): string {
  if (name.length <= max) return name
  return `${name.slice(0, max - 5).replace(/_+$/, '')}_${sha4(name)}`
}

export function defaultDatabaseName(appKey: string, envKey: string): string {
  return fitName(`nivaro_${slug(appKey)}_${slug(envKey)}`, 63)
}

/** `<app>_<env>`; MySQL and MariaDB logins hold 32 characters at most, others 63. */
export function defaultLoginName(appKey: string, envKey: string, engine: HubDbEngine): string {
  let name = `${slug(appKey)}_${slug(envKey)}`
  if (!/^[a-z]/.test(name)) name = `u_${name}`
  return fitName(name, engine === 'mysql2' || engine === 'mariadb' ? 32 : 63)
}

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const DIGIT = '0123456789'
// MySQL validate_password MEDIUM and MariaDB simple_password_check want a special character.
// - _ . ~ are the URL "unreserved" set (no percent-encoding), carry no meaning inside a
// single-quoted SQL literal on any engine (no quote, backslash, percent or wildcard), and keep
// the password valid in a shell-free GitLab variable.
const SPECIAL = '-_.~'
const ALL = UPPER + LOWER + DIGIT

const pick = (set: string) => set[randomInt(set.length)]

/** 32 characters [A-Za-z0-9] plus -_.~, with at least one upper, lower, digit and special. */
export function generatePassword(): string {
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SPECIAL)]
  while (chars.length < 32) chars.push(pick(ALL))
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

export function generateHexSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex')
}

const RESERVED = new Set([
  'sa',
  'root',
  'postgres',
  'master',
  'msdb',
  'model',
  'tempdb',
  'mysql',
  'sys',
  'information_schema',
  'performance_schema',
  'template0',
  'template1',
  'public',
  'dbo',
  'guest',
  'admin',
  'administrator',
  'system',
  'default'
])

/** Names a database or login must never take, on any engine. */
export function isReservedDbName(_engine: HubDbEngine, name: string): boolean {
  const n = String(name ?? '').toLowerCase()
  return RESERVED.has(n) || n.startsWith('pg_') || n.startsWith('mysql')
}

export function maxLoginLength(engine: HubDbEngine): number {
  if (engine === 'mysql2' || engine === 'mariadb') return 32
  return engine === 'pg' ? 63 : 128
}

/**
 * A database name for GRANT / REVOKE on MySQL and MariaDB: backquoted, with `_` and `%` escaped,
 * because both are wildcards in a grant (`a_b` would also cover `axb`).
 */
export function mysqlGrantDb(name: string): string {
  return `\`${name.replace(/`/g, '``').replace(/([_%])/g, '\\$1')}\``
}
