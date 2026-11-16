/**
 * Environment refresh — which environments exist and which directions are allowed.
 *
 * A direction is `<from>-to-<to>` (the host runbook's target). Refusals are absolute and checked
 * three times (registration, the API route, the runner): the target is never a production
 * environment, never a database a production environment uses, never a database whose name says
 * production, never the source, and never a database the declaration does not name.
 */
import type { EnvRefreshDecl, EnvRefreshEnvironment } from '@nivaro/extension-kit'

export class EnvRefreshRefused extends Error {}

const KEY = /^[a-z][a-z0-9]*$/
const DB = /^[A-Za-z0-9_]{1,128}$/

/**
 * Database names a refresh never writes, whatever a declaration says. `EFP` is the production
 * database of the EFP deployment: the one name that must never be a target, so it is refused by
 * name as well as by its `production` flag.
 */
export const NEVER_TARGET_DATABASES: readonly string[] = [
  'EFP',
  'master',
  'model',
  'msdb',
  'tempdb'
]

export function directionKey(from: string, to: string): string {
  return `${from}-to-${to}`
}

export interface ResolvedDirection {
  key: string
  source: EnvRefreshEnvironment
  target: EnvRefreshEnvironment
}

/** Throws EnvRefreshRefused when a target database may never be written by a refresh. */
export function assertWritableTarget(
  database: string,
  decl?: Pick<EnvRefreshDecl, 'environments'>
): void {
  if (!DB.test(database)) throw new EnvRefreshRefused(`${database} is not a plain database name`)
  const lower = database.toLowerCase()
  if (NEVER_TARGET_DATABASES.some((d) => d.toLowerCase() === lower))
    throw new EnvRefreshRefused(`${database} is never a refresh target`)
  if (/(^|_)(prod|production|live)($|_)/i.test(database))
    throw new EnvRefreshRefused(`${database} looks like a production database — never a target`)
  for (const e of decl?.environments ?? [])
    if (e.production && e.database.toLowerCase() === lower)
      throw new EnvRefreshRefused(
        `${database} is ${e.label}'s database — production is never a target`
      )
}

/** Validates a declaration (throws EnvRefreshRefused). */
export function validateRefreshDecl(decl: EnvRefreshDecl): void {
  if (!decl || typeof decl.runbook !== 'string' || !decl.runbook)
    throw new EnvRefreshRefused('a refresh declaration names its host runbook')
  const keys = new Set<string>()
  for (const e of decl.environments ?? []) {
    if (!KEY.test(e.key))
      throw new EnvRefreshRefused(`environment key ${e.key} must be a plain word`)
    if (!DB.test(e.database))
      throw new EnvRefreshRefused(`${e.database} is not a plain database name`)
    if (keys.has(e.key)) throw new EnvRefreshRefused(`environment ${e.key} is declared twice`)
    keys.add(e.key)
  }
  if (!(decl.directions ?? []).length) throw new EnvRefreshRefused('no directions declared')
  for (const d of decl.directions) resolveDirection(decl, directionKey(d.from, d.to))
}

/** The source and target of a declared direction — or EnvRefreshRefused. */
export function resolveDirection(decl: EnvRefreshDecl, key: unknown): ResolvedDirection {
  if (typeof key !== 'string' || !/^[a-z0-9]+-to-[a-z0-9]+$/.test(key))
    throw new EnvRefreshRefused('direction must look like production-to-staging')
  const declared = (decl.directions ?? []).find((d) => directionKey(d.from, d.to) === key)
  if (!declared) throw new EnvRefreshRefused(`${key} is not a declared direction`)
  const source = decl.environments.find((e) => e.key === declared.from)
  const target = decl.environments.find((e) => e.key === declared.to)
  if (!source || !target) throw new EnvRefreshRefused(`${key} names an undeclared environment`)
  if (target.production)
    throw new EnvRefreshRefused(`${target.label} is production — never a target`)
  if (source.key === target.key || source.database.toLowerCase() === target.database.toLowerCase())
    throw new EnvRefreshRefused('source and target are the same database')
  assertWritableTarget(target.database, decl)
  return { key, source, target }
}

// ─── Registration (one refresh declaration per instance) ────────────────────

let registered: (EnvRefreshDecl & { extension: string }) | null = null

export function registerRefreshDecl(extension: string, decl: EnvRefreshDecl): void {
  validateRefreshDecl(decl)
  if (registered && registered.extension !== extension)
    throw new EnvRefreshRefused(`${registered.extension} already declared the environment refresh`)
  registered = { ...decl, extension }
}

export function refreshDecl(): (EnvRefreshDecl & { extension: string }) | null {
  return registered
}

/** Test seam. */
export function _resetRefreshDecl(): void {
  registered = null
}
