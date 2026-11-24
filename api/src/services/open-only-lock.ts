// Kept apart from edit-lock.ts so the many tests that mock that module keep
// working: this only calls its lockHolderVerdict.
import { type EditLockVerdict, lockHolderVerdict } from './edit-lock.js'

/**
 * Whether a lock held for the open fields alone at an APPROVAL step gives way
 * to `asker`. At an approval step the creator, the step's owners and admins
 * must be able to work the record; someone who may change only its open
 * fields (edit_lock.open_fields) never holds them off with a person-held lock
 * (security review 2026-11-24). At an admin-only step nobody but admins
 * changes more than the open fields, so that lock stays as it was.
 */
export async function openOnlyLockYields(
  holderVerdict: EditLockVerdict,
  asker: { id: string; role?: string | null } | string,
  collection: string,
  item: string
): Promise<boolean> {
  if (!holderVerdict.open_only || holderVerdict.tier !== 'approval') return false
  const mine = await lockHolderVerdict(asker, collection, item).catch(() => null)
  return !!mine && mine.allowed && !mine.open_only
}
