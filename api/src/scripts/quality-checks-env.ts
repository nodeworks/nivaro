/**
 * Imported FIRST by quality-checks.ts, before anything loads db/index.ts.
 * The runner's core connection points at the database being checked, and a
 * configuration write seen at the driver seam would move the cache epoch —
 * a write into nivaro_cache_epochs of that database. db/config-epoch.ts reads
 * this switch once, when it loads, so it has to be set before that import.
 */
process.env.CACHE_EPOCH = 'off'

export {}
