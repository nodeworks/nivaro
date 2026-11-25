import { createHash } from 'node:crypto'
import { db } from '../../db/index.js'
import { logActivity } from '../activity.js'
import { appBox } from '../app-state.js'
import { type InstallReport, installBlueprint, unwrapBlueprint } from '../blueprints.js'

/**
 * Hub link (app side, Hub enhancement 24): install an App Blueprint the Nivaro Hub sends into an
 * app the Hub has just created.
 *
 *   POST /api/hub-link/template {bundle, digest, template?: {name, version}} (routes/hub-link.ts)
 *
 * The caller is the Hub (the HUB_TOKEN bearer), never a person; the install runs as the app's
 * oldest active administrator (owner of the queues it makes), the same way an administrator's
 * install from Promotion → Blueprints does (services/blueprints.ts installBlueprint: schema,
 * workflows, layouts, queues, rules; payload templates as drafts; never data rows).
 *
 * Refused unless the app is fresh: every business collection it has (a nivaro_collections row
 * that is not a nivaro_ / directus_ system table) must be one the blueprint itself brings. So a
 * brand-new app (none) takes it, and so does a retry after a cut-off call (only the blueprint's
 * own collections are there yet: the install is idempotent and skips what exists). An app with
 * any other collection answers 409 APP_NOT_EMPTY and nothing is written.
 *
 * `digest` must be the sha256 of the bundle as sent (`sha256:<hex>` of JSON.stringify(bundle)):
 * a bundle changed on the way answers 400 BAD_DIGEST. Two calls at once in this process share one
 * run (the second waits for the first and gets its report).
 */

export const SYSTEM_PREFIXES = ['nivaro_', 'directus_'] as const

export type TemplateInstallResult =
  | { ok: true; report: InstallReport; collections: string[] }
  | {
      ok: false
      status: 400 | 409
      code: 'BAD_BUNDLE' | 'BAD_DIGEST' | 'APP_NOT_EMPTY'
      message: string
      /** APP_NOT_EMPTY: the collections that are not the blueprint's (names only, at most 10). */
      extra?: string[]
    }

/** sha256 of the bundle as sent: what the Hub stored and what it says it sent. */
export function bundleDigest(bundle: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(bundle)).digest('hex')}`
}

export function isBusinessCollection(name: string): boolean {
  const n = name.toLowerCase()
  return !SYSTEM_PREFIXES.some((p) => n.startsWith(p))
}

/** Pure: the business collections that stop the install (not brought by the blueprint). */
export function foreignCollections(present: string[], brought: string[]): string[] {
  const own = new Set(brought.map((c) => c.toLowerCase()))
  return present.filter((c) => isBusinessCollection(c) && !own.has(c.toLowerCase()))
}

async function businessCollections(): Promise<string[]> {
  const rows = (await db('nivaro_collections').select('collection')) as Array<{
    collection: string
  }>
  return rows.map((r) => String(r.collection)).filter(isBusinessCollection)
}

/** The oldest active administrator person (the install's owner), or null. */
async function installOwner(): Promise<string | null> {
  try {
    const row = (await db('nivaro_users as u')
      .join('nivaro_roles as r', 'r.id', 'u.role')
      .where('r.admin_access', true)
      .where('u.status', 'active')
      .whereNull('u.account_kind')
      .orderBy('u.id', 'asc')
      .first('u.id')) as { id: string } | undefined
    return row ? String(row.id) : null
  } catch {
    return null
  }
}

/** One install at a time per app in this process: a second call joins the first. */
const inFlight = appBox<{ digest: string; run: Promise<TemplateInstallResult> } | null>(() => null)

export async function installHubTemplate(body: unknown): Promise<TemplateInstallResult> {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as {
    bundle?: unknown
    digest?: unknown
    template?: { name?: unknown; version?: unknown }
  }
  const bp = unwrapBlueprint(b.bundle)
  if (!bp)
    return {
      ok: false,
      status: 400,
      code: 'BAD_BUNDLE',
      message: 'The bundle is not a Nivaro blueprint or blueprint package'
    }
  const digest = bundleDigest(b.bundle)
  if (typeof b.digest !== 'string' || b.digest !== digest)
    return {
      ok: false,
      status: 400,
      code: 'BAD_DIGEST',
      message: 'The bundle does not match its digest'
    }

  const running = inFlight.value
  if (running && running.digest === digest) return running.run

  const run = (async (): Promise<TemplateInstallResult> => {
    const brought = bp.collections.map((c) => String(c.meta.collection ?? '')).filter(Boolean)
    const foreign = foreignCollections(await businessCollections(), brought)
    if (foreign.length)
      return {
        ok: false,
        status: 409,
        code: 'APP_NOT_EMPTY',
        message:
          'This app already has collections of its own; a template is installed only into a new app',
        extra: foreign.slice(0, 10)
      }
    const report = await installBlueprint(bp, await installOwner())
    const name = typeof b.template?.name === 'string' ? b.template.name.slice(0, 120) : bp.name
    const version =
      typeof b.template?.version === 'string' ? ` v${b.template.version.slice(0, 40)}` : ''
    await logActivity({
      action: 'hub-template-install',
      user: null,
      collection: 'nivaro_collections',
      comment:
        `Hub template ${name}${version}: +${report.collections.created} collections, +${report.workflows.created} workflows, +${report.queues.created} queues${report.errors.length ? `, ${report.errors.length} errors` : ''}`.slice(
          0,
          400
        )
    })
    return { ok: true, report, collections: brought }
  })()
  inFlight.value = { digest, run }
  try {
    return await run
  } finally {
    if (inFlight.value?.run === run) inFlight.value = null
  }
}
