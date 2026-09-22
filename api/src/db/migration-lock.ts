/** knex's MigrationLocked, by name or by its one message — kept free of any
 *  db import so the boot path's lock handling is unit-testable. */
export function isMigrationLockedError(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown } | null
  return (
    e?.name === 'MigrationLocked' ||
    (typeof e?.message === 'string' && /migration table is already locked/i.test(e.message))
  )
}
