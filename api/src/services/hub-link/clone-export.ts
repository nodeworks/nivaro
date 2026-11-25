import { db } from '../../db/index.js'
import { NIVARO_VERSION } from '../../version.js'
import { logActivity } from '../activity.js'
import {
  isSystemCollection,
  type SanitizeReview,
  sanitizeBlueprint,
  TemplateShapeError
} from '../blueprint-sanitize.js'
import { scrubBlueprintSecrets } from '../blueprint-secrets.js'
import { buildManifest, exportBlueprint, type PublishedBlueprint } from '../blueprints.js'

/**
 * Hub enhancement 46, app side: this app's STRUCTURE as one App Blueprint package, for a Nivaro
 * Hub that clones the app into a new one (routes/hub-link-clone.ts).
 *
 * What it carries: every business collection with its fields and relations, the workflows and
 * pipelines bound to them (with their owner dimensions), layouts, queues, rules, the payload
 * templates transition actions name (published body, as drafts), roles with their policies, and
 * flows with their steps. What it never carries: records, files, people (users, owner groups,
 * owner seats), external API configurations, settings or secrets.
 *
 * Secrets are taken out HERE, before anything leaves the app (services/blueprint-secrets.ts:
 * header values, credential-named values, URL user info and credential query values), then the
 * bundle is cut down to what a template may carry (services/blueprint-sanitize.ts — the same pure
 * function the receiving app runs before it installs). Flows are exported inactive and rules
 * switched off: nothing in the clone runs before an administrator there turns it on.
 *
 * The answer names what was emptied by path only, never a value.
 */

/** The library keeps bundles up to 8 MB (services/hub/templates/library.ts TEMPLATE_MAX_BYTES). */
export const CLONE_MAX_BYTES = 8 * 1024 * 1024

export interface CloneExport {
  package: PublishedBlueprint
  /** Paths whose credential value was emptied before the bundle left (names only). */
  scrubbed: string[]
  review: SanitizeReview
  bytes: number
}

export class CloneExportError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'CloneExportError'
    this.code = code
    this.status = status
  }
}

/** The business collections of this app (system tables never). */
export async function businessCollections(): Promise<string[]> {
  const rows = (await db('nivaro_collections').select('collection')) as Array<{
    collection: string
  }>
  return rows
    .map((r) => String(r.collection ?? ''))
    .filter((c) => /^[a-zA-Z0-9_]+$/.test(c) && !isSystemCollection(c))
    .sort()
}

/** Rules switched off: a clone's rules run only once an administrator there turns them on. */
function rulesOff<T extends { rules: Array<Record<string, unknown>> }>(bp: T): T {
  return { ...bp, rules: bp.rules.map((r) => ({ ...r, enabled: false })) }
}

export async function exportCloneBlueprint(
  o: { label?: string | null } = {}
): Promise<CloneExport> {
  const collections = await businessCollections()
  if (!collections.length)
    throw new CloneExportError('NOTHING_TO_CLONE', 'This app has no collections of its own.')
  const name = `Structure of ${(o.label ?? '').trim() || 'this app'}`.slice(0, 200)
  const raw = await exportBlueprint(name, collections, { structure: true })
  // 1. Secrets out first, on the raw export.
  const { blueprint: scrubbedBp, scrubbed } = scrubBlueprintSecrets(rulesOff(raw))
  // 2. Then only what a template may carry (and the caps).
  let clean: ReturnType<typeof sanitizeBlueprint>
  try {
    clean = sanitizeBlueprint(scrubbedBp)
  } catch (err) {
    if (err instanceof TemplateShapeError) throw new CloneExportError(err.code, err.message)
    throw err
  }
  // 3. Once more after the sanitizer (it never adds a value, so this finds nothing new).
  const final = scrubBlueprintSecrets(rulesOff(clean.blueprint))
  const pkg: PublishedBlueprint = {
    type: 'nivaro-blueprint-package',
    version: 1,
    manifest: buildManifest(final.blueprint, {
      description:
        'App structure exported for a Nivaro Hub clone: no records, files, people or secrets.',
      version: null,
      nivaroVersion: NIVARO_VERSION
    }),
    blueprint: final.blueprint
  }
  const bytes = Buffer.byteLength(JSON.stringify(pkg))
  if (bytes > CLONE_MAX_BYTES)
    throw new CloneExportError(
      'TOO_LARGE',
      'The structure of this app is larger than the 8 MB a Hub template may hold.',
      413
    )
  const all = [...new Set([...scrubbed, ...final.scrubbed])]
  await logActivity({
    action: 'hub-clone-export',
    user: null,
    collection: 'nivaro_collections',
    comment:
      `Structure exported for a Hub clone: ${pkg.manifest.counts.collections} collections, ${pkg.manifest.counts.workflows} workflows, ${pkg.manifest.counts.roles ?? 0} roles, ${pkg.manifest.counts.flows ?? 0} flows; ${all.length} credential values emptied`.slice(
        0,
        400
      )
  }).catch(() => null)
  return { package: pkg, scrubbed: all, review: clean.review, bytes }
}
