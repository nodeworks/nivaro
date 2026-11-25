/**
 * Per-app storage scope on a Hub shared deployment (Hub phase 6, Decision 7).
 *
 * One shared process serves many apps, and two of them may be copies of one database (dev = a
 * copy of prod) with the very same file keys. On such a deployment `getStorage()` wraps the
 * env-driven provider with `scopedStorage`, which keys every object under `apps/<tenantId>/`
 * for the app the call runs in. An app can then never read, list or delete another app's
 * objects, and a call outside any app (a process job, a boot pass) reaches nothing.
 *
 * The wrapper is a Proxy over the (instrumented) provider, so `instanceof LocalStorage` still
 * holds and `resolveKey` — the one way code reaches a local file by path
 * (stored-object-stream, files.getFilePath) — resolves inside the scope too. A method it does
 * not know is refused rather than passed through unscoped.
 *
 * Self-hosted and Nivaro Cloud never use it.
 */
import type { StorageProvider } from './index.js'
import { LocalStorage } from './local.js'

export type AppScopeCode = 'NO_APP_CONTEXT' | 'BAD_KEY'

export class AppScopeError extends Error {
  readonly code: AppScopeCode
  readonly statusCode: number
  constructor(code: AppScopeCode, message: string) {
    super(message)
    this.name = 'AppScopeError'
    this.code = code
    this.statusCode = code === 'BAD_KEY' ? 400 : 500
  }
}

/** The folder every app's objects live under on a shared deployment. */
export const APP_SCOPE_ROOT = 'apps/'

// A tenant id is `<app key, ≤48>-e<env id>` (tenantIdFor); never a dot, slash or backslash.
const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** `apps/<tenantId>/` for the app a call runs in; NO_APP_CONTEXT outside any app. */
export function appScopePrefix(tenantId: string | null | undefined): string {
  if (!tenantId) {
    throw new AppScopeError(
      'NO_APP_CONTEXT',
      'Stored files on a shared deployment can only be reached from inside an app.'
    )
  }
  if (!TENANT_RE.test(tenantId)) {
    throw new AppScopeError('NO_APP_CONTEXT', 'This app has no usable storage folder.')
  }
  return `${APP_SCOPE_ROOT}${tenantId}/`
}

/** A key that stays inside its scope: no `..` or `.` path segment, no leading `/`, no `\`,
 *  no NUL. Two dots inside a name (`a..b.pdf`) are fine. */
export function assertScopableKey(key: unknown, opts: { allowEmpty?: boolean } = {}): string {
  if (
    typeof key !== 'string' ||
    (key === '' && !opts.allowEmpty) ||
    key.startsWith('/') ||
    key.includes('\\') ||
    key.includes('\0') ||
    key.split('/').some((seg) => seg === '..' || seg === '.')
  ) {
    throw new AppScopeError('BAD_KEY', 'That storage key is not allowed.')
  }
  return key
}

/** The stored key for `key` inside the app's scope. */
export function appScopedKey(key: unknown, tenantId: string | null | undefined): string {
  const prefix = appScopePrefix(tenantId)
  return prefix + assertScopableKey(key)
}

/**
 * Where a server-side copy (a Hub move, 0.3.215) may read from: `root` = a dedicated source's
 * bucket root (never inside `apps/`), or the source app's tenant id = its `apps/<tenant>/`
 * folder. Always named by the caller from what it controls (the Hub's move), never by the data
 * the source sent.
 */
export type CopySourceScope = 'root' | { tenant: string }

/**
 * The full source key of a server-side copy, checked against its scope: no `..` / `.` segment,
 * no leading `/`, no `\`, NUL or other control character; `apps/<tenant>/<key>` for a tenant
 * scope, a key outside `apps/` for the root. Throws BAD_KEY otherwise.
 */
export function assertCopySource(raw: unknown, scope: CopySourceScope | null | undefined): string {
  const bad = () => new AppScopeError('BAD_KEY', 'That copy source is not allowed.')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
  if (typeof raw !== 'string' || /[\u0000-\u001f\u007f]/.test(raw)) throw bad()
  try {
    assertScopableKey(raw)
  } catch {
    throw bad()
  }
  if (scope === 'root') {
    if (raw === APP_SCOPE_ROOT.slice(0, -1) || raw.startsWith(APP_SCOPE_ROOT)) throw bad()
    return raw
  }
  if (!scope || typeof scope !== 'object') throw bad()
  let prefix: string
  try {
    prefix = appScopePrefix(scope.tenant)
  } catch {
    throw bad()
  }
  if (!raw.startsWith(prefix) || raw.length === prefix.length) throw bad()
  return raw
}

// Methods whose first argument is an object key. Async ones refuse with a rejection (callers
// chain `.catch()`); sync ones throw. `size` is the optional stat a provider may add (M9).
const ASYNC_KEYED = new Set([
  'put',
  'putFile',
  'get',
  'delete',
  'exists',
  'getUploadUrl',
  'size',
  // R6-M-3: a saved-settings driver's streamed read
  'openStream'
])
const SYNC_KEYED = new Set(['resolveKey'])
/** Methods that take no key at all (0.3.215: the store's identity hash for a move). */
const NO_KEY = new Set(['storeId'])

/**
 * Wrap `base` (an env storage provider, or a saved-settings S3/Azure driver — anything whose
 * key methods take the key first) so every key lands under `apps/<tenantId()>/`. `list()` takes a prefix inside the
 * scope and gives keys back without the scope prefix. `getUrl` keeps the local provider's
 * `/api/files/raw/<key>` shape (the raw route then resolves the key inside the caller's scope);
 * a presigning provider signs the scoped key.
 */
export function scopedStorage<T extends StorageProvider | object>(
  base: T,
  tenantId: () => string | null
): T {
  const local = base instanceof LocalStorage
  return new Proxy(base, {
    get(target, prop) {
      const value = Reflect.get(target, prop)
      if (typeof prop !== 'string' || typeof value !== 'function') return value
      if (ASYNC_KEYED.has(prop)) {
        return (key: unknown, ...rest: unknown[]) => {
          let scoped: string
          try {
            scoped = appScopedKey(key, tenantId())
          } catch (err) {
            return Promise.reject(err)
          }
          return Reflect.apply(value, target, [scoped, ...rest])
        }
      }
      if (SYNC_KEYED.has(prop)) {
        return (key: unknown, ...rest: unknown[]) =>
          Reflect.apply(value, target, [appScopedKey(key, tenantId()), ...rest])
      }
      if (NO_KEY.has(prop)) return (...args: unknown[]) => Reflect.apply(value, target, args)
      if (prop === 'copyFrom') {
        // 0.3.215: a move's server-side copy. The destination is scoped like every key; the
        // source must be inside THIS app's own folder (its scope named by the caller and checked
        // here): a shared bucket's root and every other app's folder are refused.
        return (key: unknown, raw: unknown, mime: unknown, opts: unknown) => {
          try {
            const own = tenantId()
            const scoped = appScopedKey(key, own)
            const scope = (opts as { sourceScope?: CopySourceScope } | null)?.sourceScope
            if (!scope || scope === 'root' || scope.tenant !== own)
              throw new AppScopeError('BAD_KEY', 'That copy source is not allowed.')
            return Reflect.apply(value, target, [scoped, assertCopySource(raw, scope), mime, opts])
          } catch (err) {
            return Promise.reject(err)
          }
        }
      }
      if (prop === 'getUrl') {
        return (key: unknown) => {
          const scoped = appScopedKey(key, tenantId())
          return Reflect.apply(value, target, [local ? assertScopableKey(key) : scoped])
        }
      }
      if (prop === 'list') {
        return async (prefix: unknown = '') => {
          const scope = appScopePrefix(tenantId())
          const full = scope + assertScopableKey(prefix, { allowEmpty: true })
          const keys = (await Reflect.apply(value, target, [full])) as string[]
          return keys.filter((k) => k.startsWith(full)).map((k) => k.slice(scope.length))
        }
      }
      // Object.prototype methods (toString…) are harmless; anything else may take a key.
      if (prop in Object.prototype) return value
      return () => {
        throw new AppScopeError('BAD_KEY', `Storage call ${prop} is not available here.`)
      }
    }
  })
}
