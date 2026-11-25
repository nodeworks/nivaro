/**
 * P6-31 (pure, no I/O): the saved-settings storage drivers whose objects a move's pull can copy
 * (`nivaro_files.storage` as storage-drivers.ts names them). A leaf module: the plan imports it
 * without the pull's I/O.
 */
export const COPYABLE_OBJECT_STORAGE = ['s3', 'azure-blob'] as const

/**
 * 0.3.215: what an env-driven provider writes in `nivaro_files.storage` (STORAGE_PROVIDER s3 /
 * azure; `local` is copied always). A move from that version copies these rows too, wherever the
 * key prefix goes. 's3' is also what the saved-settings S3 driver writes: the source says which
 * store really holds each object (routes/hub-transfer.ts X-Nivaro-Transfer-Store).
 */
export const ENV_STORAGE_PROVIDERS = ['s3', 'azure'] as const

/** What a 0.3.215 move copies on any provider: the env-driven ones and the saved-settings ones. */
export const COPYABLE_SINCE_ENV_STORAGE: readonly string[] = [
  ...new Set<string>([...COPYABLE_OBJECT_STORAGE, ...ENV_STORAGE_PROVIDERS])
]

/** The Hub side: a reported `objects` map, or undefined when absent or not one (unknown). */
export function parseObjectCounts(raw: unknown): Record<string, number> | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return undefined
  const out: Record<string, number> = {}
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > 20) return undefined
  for (const [k, v] of entries) {
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(k)) return undefined
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined
    out[k] = Math.floor(v)
  }
  return out
}
