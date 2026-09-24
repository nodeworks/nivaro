/**
 * Who wrote a piece of history — structurally, not by reading its text (#518).
 *
 * Writers stamp `origin` on nivaro_activity / nivaro_workflow_history:
 *   person       — someone did this in the product (form, grid, transition click)
 *   integration  — an identity that is a machine account wrote through the API
 *   import       — an import run (file prefill, staged service-mode run)
 *   machine      — the system itself (auto transitions, crons, extension jobs)
 *
 * Historic rows carry NULL; for those the reader falls back to what it used to
 * do — the legacy provenance column, the writer's account kind, then the
 * registered text markers. A new machine writer that stamps `origin` needs no
 * marker registration to stay out of the Notes thread.
 */
import { relatedNoteRegistry } from '../extensions/related-notes.js'
import { accountKindOf } from './machine-accounts.js'

export type NoteOrigin = 'person' | 'machine' | 'import' | 'integration'

const ORIGINS = new Set<NoteOrigin>(['person', 'machine', 'import', 'integration'])

export function isNoteOrigin(v: unknown): v is NoteOrigin {
  return typeof v === 'string' && ORIGINS.has(v as NoteOrigin)
}

/** The import stamp every import write carries as its change reason. */
export function isImportStamp(text: string | null | undefined): boolean {
  return /^import:/i.test(String(text ?? '').trim())
}

/**
 * The origin a WRITE should record. `actor` is the user row doing it (null =
 * the system); `comment` is the reason it carries.
 */
export function originForWrite(
  actor: { account_kind?: string | null; email?: string | null } | null | undefined,
  comment?: string | null
): NoteOrigin {
  if (isImportStamp(comment)) return 'import'
  if (!actor) return 'machine'
  return accountKindOf(actor) ? 'integration' : 'person'
}

/**
 * The origin of a STORED row: the column when set, else inferred the old way.
 * `legacy` = the row came from the Directus history import (legacy_id set).
 */
export function originOfRow(row: {
  origin?: unknown
  comment?: unknown
  legacy?: boolean
  actorKind?: string | null
}): NoteOrigin {
  if (isNoteOrigin(row.origin)) return row.origin
  const text = String(row.comment ?? '').trim()
  if (isImportStamp(text)) return 'import'
  if (row.actorKind) return 'integration'
  if (relatedNoteRegistry.isMachineComment(text)) return 'machine'
  if (row.legacy && /^legacy-/i.test(text)) return 'machine'
  return 'person'
}

// The origin column arrives with migration 340; an instance that has not run
// it yet must keep writing history. Probed once per table per TENANT (cloud
// mode: one tenant may be migrated while another is not), per process.
const hasOrigin = new Map<string, Promise<boolean>>()

/** `{origin}` for an insert into `table`, or `{}` before migration 340 ran. */
export async function originFields(
  table: string,
  origin: NoteOrigin
): Promise<{ origin?: NoteOrigin }> {
  const { getTenantId } = await import('../db/tenant-context.js')
  const key = `${getTenantId() ?? ''}\u0000${table}`
  let p = hasOrigin.get(key)
  if (!p) {
    p = (async () => {
      try {
        const { db } = await import('../db/index.js')
        return await db.schema.hasColumn(table, 'origin')
      } catch {
        return false
      }
    })()
    hasOrigin.set(key, p)
  }
  return (await p) ? { origin } : {}
}
