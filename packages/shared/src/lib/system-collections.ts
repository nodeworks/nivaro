/**
 * System tables as the screens know them. Twin of the server's rule
 * (api/src/services/system-collections.ts): `nivaro_*` and the legacy `directus_*` tables are
 * never business collections.
 *
 * Why the screens need it: a record page, a list or a picker pointed at one of these used to
 * send every read a business record gets, and the API refuses most of them for system tables
 * by name. Each was a 400/403/404 in the request log for something that could never work. The
 * server checks stay exactly as they are; this only stops asking.
 */
const SYSTEM_COLLECTION = /^(nivaro_|directus_)/i

export function isSystemCollection(collection: string | null | undefined): boolean {
  return !!collection && SYSTEM_COLLECTION.test(collection)
}

/**
 * Last touch, origin, record links, "referenced by", who viewed, the recap strip, the
 * integrity check and "why can't I see this": the API refuses each for a system table by
 * name, so a record page on one never asks.
 */
export function hasRecordExtras(collection: string | null | undefined): boolean {
  return !isSystemCollection(collection)
}

/**
 * Among system tables only addendums carry a pipeline (they move through their parent's).
 * For any other the instance read is refused to everyone but an unrestricted administrator,
 * and has nothing to show them.
 */
export function mayHavePipeline(collection: string | null | undefined): boolean {
  return !isSystemCollection(collection) || String(collection).toLowerCase() === 'nivaro_addendums'
}

/** The file tables: read through /files, never through /items or /collections. */
export function isFileCollection(collection: string | null | undefined): boolean {
  const c = String(collection ?? '').toLowerCase()
  return c === 'nivaro_files' || c === 'directus_files'
}
