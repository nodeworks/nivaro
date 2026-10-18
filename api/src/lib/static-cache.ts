/**
 * Cache-Control for the admin build the release image serves (#2438).
 *
 * Vite writes every script, style and imported asset under `assets/` with a content hash in
 * its name, so a given URL never changes: browsers keep those a year and never revalidate.
 * Everything else — index.html (which names the current hashes), the service worker, icons,
 * the manifest — is revalidated on every load, so a release reaches people at once.
 * `path` is the file @fastify/static is sending (with preCompressed, possibly its .br/.gz twin).
 */
const HASHED_ASSET = /[\\/]assets[\\/][^\\/]+[-.][A-Za-z0-9_-]{8,}\.[a-z0-9]+(?:\.(?:br|gz))?$/

export function adminAssetCacheControl(path: string): string {
  return HASHED_ASSET.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache'
}
