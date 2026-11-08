/**
 * Which GETs may ride `POST /api/batch-get`: small JSON configuration and
 * side-panel reads a record page asks for in mount waves. The server runs each one as the
 * caller through the real route, so batching changes the transport only.
 *
 * Twin: BATCHABLE_GET in api/src/services/batch-get.ts — keep the two patterns
 * byte-identical (an api test compares them). Never list a stream, a file, an identity read
 * (`/auth/*`, `/users/me`), a record read (`/items/<c>` rides `/items/batch-read`) or a slow
 * read: one slow part holds the whole batch's answer. Left out on purpose because they take
 * 0.5–3 s on a cold record: the pipeline instance and its owners, provenance (3 s budget),
 * related comments, the record chat room, lineage, integration preflights, extension routes.
 */
export const BATCHABLE_GET =
  /^\/(settings|roles|pinned|users|tasks|custom-actions|field-rules|notification-subscriptions|my-jobs|announcements\/active|notifications\/unread-count|session-recordings\/enabled|help-videos\/for|presence\/online|chaos\/(armed|status|gamedays\/active)|chat\/(rooms|room-types)|collection-layouts(\/active|\/why|\/summary\/[^/]+|\/\d+)?|field-config\/[^/]+|field-defaults\/mine|data-model\/(relations\/for\/[^/]+|resolve-cascade)|bulk-actions\/available|ai-settings\/[^/]+|item-actions\/registered|revisions(\/latest|\/field-touch|\/o2m-cell-provenance)?|comments(\/counts|\/machine-markers)?|(last-touch|drafts|addendums|erp-submissions|access-explain)\/[^/]+\/[^/]+|config-conformance\/record\/[^/]+\/[^/]+|integration-obligations\/record\/[^/]+\/[^/]+|record-views\/[^/]+\/[^/]+\/viewers|sla\/status\/[^/]+\/[^/]+|legal-holds\/check\/[^/]+\/[^/]+|layout-collab\/\d+\/whats-new|pipelines\/instances\/[^/]+|widgets-internal\/\d+|items\/[^/]+(\/[^/]+)?\/resolve-paths)$/

/** The most reads one `POST /batch-get` carries (the server's cap). */
export const BATCH_GET_LIMIT = 20
/** How long the client collects GETs before it sends a batch. */
export const BATCH_GET_WINDOW_MS = 10

/** Whether a GET path (under /api, no query string) may be batched. */
export function isBatchableGetPath(path: string): boolean {
  return BATCHABLE_GET.test(path)
}

/** One part of a `POST /batch-get` answer. */
export interface BatchGetPart {
  key?: string
  status?: number
  /** The part's JSON body, exactly as its GET answers it (absent when it was not JSON). */
  body?: unknown
  request_id?: string
  retry_after?: string
}

export interface GetBatcherOptions {
  /**
   * Send `POST /api/batch-get {reads}` and resolve its parsed answer. Throw an error carrying
   * the HTTP `status` when the batch itself is refused (no status = no network).
   */
  post: (reads: Array<{ key: string; path: string }>) => Promise<unknown>
}

export interface BatchedGet<T> {
  /** The read on its own — its plain GET, with that transport's own errors. */
  alone: () => Promise<T>
  /** The error its plain GET would have thrown for this part's refusal. */
  error: (part: BatchGetPart & { status: number }) => unknown
}

/** What createGetBatcher returns: queue one GET for the next batch. */
export type GetLoader = <T>(path: string, read: BatchedGet<T>) => Promise<T>

let hostLoader: GetLoader | null = null

/**
 * A host whose own fetch helper also batches small GETs (efp-new's apiFetch) hands its loader
 * here, and the shared client queues its GETs on that same loader: the reads both transports
 * ask in one moment ride ONE request instead of one per transport. The host's loader must post
 * as the very caller its shared client signs in as (same token / session). `null` takes it back.
 */
export function shareGetLoader(loader: GetLoader | null): void {
  hostLoader = loader
}

/** The loader a host shared (shareGetLoader), else null. */
export function sharedGetLoader(): GetLoader | null {
  return hostLoader
}

interface PendingGet {
  path: string
  read: BatchedGet<unknown>
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

/**
 * A loader for any transport (the shared client, a host's own fetch helper): GETs whose path
 * isBatchableGetPath names, asked within BATCH_GET_WINDOW_MS, ride one `POST /batch-get`
 * (chunks of BATCH_GET_LIMIT). The server runs each through its own route as the caller, so a
 * caller resolves with exactly the body its GET answers, or rejects with `error(part)` — what
 * its GET would have thrown. A part the server could not answer as JSON, and every part of a
 * batch refused as a whole with a 4xx (a signed-out tab, an access-pending account, a
 * malformed body), is re-sent on its own, so a route that answers some callers without
 * signing in still does. A busy or failing server (429, 5xx, no network) fails the batch's
 * callers with that error: re-sending each alone would only add load. A server without the
 * route (404/405) switches the loader off for good. `path` is the wire path under /api with
 * its query string.
 */
export function createGetBatcher(opts: GetBatcherOptions): GetLoader {
  let supported = true
  let pending: PendingGet[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const alone = (p: PendingGet) => p.read.alone().then(p.resolve, p.reject)
  const send = async (group: PendingGet[]) => {
    if (group.length === 1 || !supported) {
      for (const p of group) void alone(p)
      return
    }
    let answer: { results?: unknown } | undefined
    try {
      answer = (await opts.post(group.map((p, i) => ({ key: String(i), path: p.path })))) as
        | { results?: unknown }
        | undefined
    } catch (err) {
      const status = (err as { status?: number })?.status
      if (status === 404 || status === 405) supported = false
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
        for (const p of group) void alone(p)
        return
      }
      for (const p of group) p.reject(err)
      return
    }
    const results = Array.isArray(answer?.results) ? (answer.results as BatchGetPart[]) : null
    if (!results) {
      for (const p of group) void alone(p)
      return
    }
    group.forEach((p, i) => {
      const r = results[i]
      const status = r?.status
      if (!r || r.key !== String(i) || typeof status !== 'number' || !('body' in r)) {
        void alone(p)
        return
      }
      if (status >= 200 && status < 300) p.resolve(r.body)
      else if (status >= 400) p.reject(p.read.error({ ...r, status }))
      else void alone(p)
    })
  }
  const flush = () => {
    timer = undefined
    const all = pending
    pending = []
    for (let i = 0; i < all.length; i += BATCH_GET_LIMIT)
      void send(all.slice(i, i + BATCH_GET_LIMIT))
  }
  return <T>(path: string, read: BatchedGet<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      pending.push({
        path,
        read: read as BatchedGet<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject
      })
      if (timer === undefined) timer = setTimeout(flush, BATCH_GET_WINDOW_MS)
    })
}
