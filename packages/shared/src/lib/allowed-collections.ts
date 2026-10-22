/**
 * `one_allowed_collections` on an M2A relation reaches the client in three shapes:
 * an array (the API parses it — services/collections.ts parseAllowedCollections),
 * JSON text (rows the Data Model wrote, read raw) or a bare comma list (legacy
 * Directus M2A imports, 'additional_emails,directus_users'). Calling `.split` on the
 * array crashed every record form with an M2A-backed picker (2026-10-22).
 */
export function parseAllowedCollections(v: unknown): string[] {
  if (v == null || v === '') return []
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean)
  const text = String(v).trim()
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed.map((s) => String(s).trim()).filter(Boolean)
    } catch {
      // not JSON after all: read it as a comma list below
    }
  }
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
