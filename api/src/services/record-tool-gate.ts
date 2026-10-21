import type { FastifyRequest } from 'fastify'
import { legitimatePinForRecord, resolveLayout } from '../routes/collection-layouts.js'
import { canUpdateItem, readOne } from './items.js'
import { can } from './permissions.js'
import { isSystemCollection } from './system-collections.js'

/** Layout columns that hand a record tool to everyone who opens the form. */
export type RecordToolGrant = 'allow_disable_pickers' | 'allow_schedule'

export type RecordToolRequest = Pick<FastifyRequest, 'user' | 'isAdmin'> & {
  workspaceId?: string | null
}

/**
 * Who may use a record tool a form grants to all users ("Disable in pickers",
 * "Schedule a change…"): administrators, and anyone whose form for this record
 * turns the grant column on — provided they can see the record and may update
 * THIS record (the item-level gates updateOne applies). The form is the one
 * /active resolves for this person and record; a ?layout= pin (`layout`) only
 * counts when it is a record form their role may open whose record rules match
 * this record — the request never chooses the layout that grants it.
 * Null = allowed; otherwise the refusal to send.
 */
export async function recordToolRefusal(
  req: RecordToolRequest,
  collection: string,
  itemId: string,
  grant: RecordToolGrant,
  opts: { layout?: string | null; denied: string }
): Promise<{ status: number; error: string } | null> {
  if (req.isAdmin) return null
  const user = req.user
  if (!user) return { status: 401, error: 'Unauthorized' }
  const denied = { status: 403, error: opts.denied }
  if (isSystemCollection(collection)) return denied
  if (!(await can(user, 'update', collection))) return denied
  const workspaceId = req.workspaceId ?? undefined
  // readOne answers null (or throws) for a record the caller can't see —
  // asked before the form is resolved, so a hidden record's fields never
  // decide between 403 and 404.
  const visible = await readOne(user, collection, itemId, workspaceId).catch(() => null)
  if (!visible) return { status: 404, error: 'Not found' }
  const role = user.role ?? null
  const { row } = await resolveLayout({
    collection,
    slug: null,
    item: itemId,
    role,
    isAdmin: false,
    userId: user.id ? String(user.id) : null
  })
  let granted = !!row?.[grant]
  // On a small screen the record opens with its form's phone version (#2715).
  if (!granted) {
    const phone = await resolveLayout({
      collection,
      slug: null,
      item: itemId,
      role,
      isAdmin: false,
      userId: user.id ? String(user.id) : null,
      viewport: 'phone'
    })
    if (phone.reason?.kind === 'phone') granted = !!phone.row?.[grant]
  }
  if (!granted && opts.layout) {
    const pin = await legitimatePinForRecord({ collection, slug: opts.layout, item: itemId, role })
    granted = !!pin?.[grant]
  }
  if (!granted) return denied
  if (!(await canUpdateItem(user, collection, itemId, workspaceId))) return denied
  return null
}
