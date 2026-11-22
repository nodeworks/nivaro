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
const ALL = UPPER + LOWER + DIGIT

const pick = (set: string) => set[randomInt(set.length)]

/** 32 characters [A-Za-z0-9] with at least one upper, lower and digit. */
export function generatePassword(): string {
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT)]
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
