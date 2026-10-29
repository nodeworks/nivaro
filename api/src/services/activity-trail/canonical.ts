import { createHash } from 'node:crypto'

/**
 * The canonical form of one nivaro_activity row — what its seal hash covers (#16).
 *
 * A FIXED, versioned column list: a column a later migration adds is not in v1, so old hashes
 * never change. Adding a column to the trail means a new version (v2 = v1 + the new columns),
 * written by the sealer from then on; v1 rows stay v1 and verify as v1 forever.
 *
 * Rules that keep the form stable whatever driver read the row:
 *   - keys in this exact order (JSON.stringify keeps insertion order);
 *   - a column this database does not have yet reads as null (the same as a NULL value);
 *   - timestamp → ISO 8601 UTC with milliseconds; uuids lower-case; integers as numbers;
 *     text exactly as stored (no trimming).
 *
 * NEVER UPDATE a column listed here on an existing row (a backfill included): the next
 * verification reports the row as tampered.
 */
export const CANONICAL_COLUMNS = {
  1: [
    'id',
    'timestamp',
    'action',
    'user',
    'ip',
    'user_agent',
    'collection',
    'item',
    'comment',
    'origin',
    'legacy_id',
    'chain_id',
    'chain_parent',
    'api_key_id',
    'auth_method',
    'mcp_conn',
    'via_app'
  ]
} as const satisfies Record<number, readonly string[]>

export type SealVersion = keyof typeof CANONICAL_COLUMNS

/** The version the sealer writes today. */
export const CURRENT_SEAL_VERSION: SealVersion = 1

/** The hash the first row of the chain links to. */
export const GENESIS_HASH = '0'.repeat(64)

const INT_COLUMNS = new Set(['id', 'legacy_id', 'api_key_id'])
const UUID_COLUMNS = new Set(['user', 'chain_id'])
const TIME_COLUMNS = new Set(['timestamp'])

export function isSealVersion(v: unknown): v is SealVersion {
  return typeof v === 'number' && Object.hasOwn(CANONICAL_COLUMNS, v)
}

/** Every column any version reads — the sealer/verifier select list (intersected with the table). */
export function allCanonicalColumns(): string[] {
  const out = new Set<string>()
  for (const cols of Object.values(CANONICAL_COLUMNS)) for (const c of cols) out.add(c)
  return [...out]
}

function normalise(column: string, value: unknown): string | number | null {
  if (value === undefined || value === null) return null
  if (TIME_COLUMNS.has(column)) {
    const d = value instanceof Date ? value : new Date(String(value))
    return Number.isNaN(d.getTime()) ? String(value) : d.toISOString()
  }
  if (INT_COLUMNS.has(column)) {
    const n = Number(value)
    return Number.isFinite(n) ? n : String(value)
  }
  if (UUID_COLUMNS.has(column)) return String(value).toLowerCase()
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return value.toString('hex')
  return typeof value === 'number' ? value : String(value)
}

/** The canonical JSON text of a row under a seal version. */
export function canonicalRow(row: Record<string, unknown>, version: SealVersion = 1): string {
  const cols = CANONICAL_COLUMNS[version]
  const out: Record<string, string | number | null> = {}
  for (const c of cols) out[c] = normalise(c, row[c])
  return JSON.stringify(out)
}

/** seal_hash = sha256(previous seal_hash || canonical(row)), hex. */
export function sealHash(prevHash: string, canonical: string): string {
  return createHash('sha256').update(prevHash, 'utf8').update(canonical, 'utf8').digest('hex')
}

export const HASH_RE = /^[0-9a-f]{64}$/
