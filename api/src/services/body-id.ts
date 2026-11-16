/** A PATCH body naming a different record than its URL: 400, nothing written. */
export class BodyIdMismatchError extends Error {
  statusCode = 400
  code = 'ID_MISMATCH'
  constructor() {
    super('The id in the request body is not the record being updated.')
    this.name = 'BodyIdMismatchError'
  }
}

/**
 * The record's id comes from the URL. A body that repeats it (a client sending back the whole
 * row) used to reach the UPDATE as `set [id] = …`, which SQL Server refuses for an identity
 * column ("Cannot update identity column 'id'", 2026-11-16) — so it is taken out here. A body
 * that names a different record is refused instead of silently updating the URL's one.
 */
export function takeBodyId(data: Record<string, unknown>, id: string | number): void {
  if (!Object.hasOwn(data, 'id')) return
  const bodyId = data.id
  delete data.id
  if (bodyId == null || bodyId === '') return
  if (String(bodyId).toLowerCase() !== String(id).toLowerCase()) throw new BodyIdMismatchError()
}
