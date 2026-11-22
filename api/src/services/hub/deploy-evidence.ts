import { createHash } from 'node:crypto'
import { fetchJson, type GitCtx, gitlabApi } from '../gitlab-client.js'
import { getApp } from '../io-holder.js'
import { componentTargetBranch, listComponents } from './components.js'
import {
  driverCtx,
  type GitlabDriverRow,
  getDriver,
  getPlacement,
  repositoryIdentity
} from './drivers.js'
import { GitlabWriteError } from './gitlab-write.js'

/**
 * GitLab evidence that an environment ran a version (phase 2, P26/P31): the versions its own
 * successful deploy jobs ran — each API component's deploy job on its target branch, and the
 * driver's pin file at each job's commit — so a staging deployed by the release chain that has
 * moved on still counts an older version it ran.
 *
 * Cached (P31), keys never carry a token — they are the repository identity, so an edited driver
 * misses:
 *  - the version a pin file names at one commit never changes: in-process LRU
 *    (identity, pin file, sha), PIN_CACHE_MAX entries, no expiry — except a missing file (404),
 *    kept MISSING_PIN_TTL_MS only;
 *  - the successful-job list per (identity, branch, job): JOBS_TTL_MS, in Redis when the Hub has
 *    it (nvr:hub:evidence:jobs:<sha1>, bounded to 300 ms, fail-open) and in-process.
 * Concurrent askers share one GitLab read (single-flight). One gitlabDeployedVersions call spends
 * at most EVIDENCE_BUDGET_MS: at the deadline its reads in flight are aborted (the signal reaches
 * fetch), no new read starts, and it answers what it has (the rest counts as no evidence).
 */

/** How many of an environment's newest successful deploy jobs count as GitLab evidence. */
export const GITLAB_DEPLOY_EVIDENCE = 50
const JOB_PAGES = 5
const PIN_READS_AT_ONCE = 5
export const EVIDENCE_BUDGET_MS = 5000
export const JOBS_TTL_MS = 60_000
export const PIN_CACHE_MAX = 5000
/** A pin file missing at a commit (404) is asked again after this (a read error never stays). */
export const MISSING_PIN_TTL_MS = 60_000
const CACHE_BOUND_MS = 300
const VERSION_RE = /^\d+\.\d+\.\d+$/

/** version, and until when (null = for good; a 404 has a deadline). */
const pinCache = new Map<string, { v: string | null; until: number | null }>()
const jobsCache = new Map<string, { until: number; shas: string[] }>()
const inflight = new Map<string, Promise<unknown>>()

/** Drops every cached answer (tests). */
export function forgetDeployEvidence(): void {
  pinCache.clear()
  jobsCache.clear()
  inflight.clear()
}

/** One shared read per key while it runs. */
function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined
  if (running) return running
  const p = fn().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

function remember(key: string, entry: { v: string | null; until: number | null }): void {
  pinCache.delete(key)
  pinCache.set(key, entry)
  while (pinCache.size > PIN_CACHE_MAX) {
    const oldest = pinCache.keys().next().value
    if (oldest === undefined) break
    pinCache.delete(oldest)
  }
}

type EvidenceRedis = {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>
}

const TIMED_OUT = Symbol('timed-out')

/** `p()`, or TIMED_OUT after `ms` or on a rejection (a cache never fails or holds a read). */
async function boundedCall<T>(p: () => Promise<T>, ms = CACHE_BOUND_MS) {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(p),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms)
        timer.unref?.()
      })
    ])
  } catch {
    return TIMED_OUT
  } finally {
    clearTimeout(timer)
  }
}

const jobsKey = (k: string) => `nvr:hub:evidence:jobs:${createHash('sha1').update(k).digest('hex')}`

/**
 * The commits of a project's newest successful `job` runs on `branch` (at most `max`, from at
 * most JOB_PAGES pages of GitLab's job list). Token in the PRIVATE-TOKEN header only, redirects
 * refused; errors never carry GitLab's answer.
 */
export async function successfulDeployCommits(
  ctx: GitCtx,
  branch: string,
  job: string,
  max = GITLAB_DEPLOY_EVIDENCE,
  signal?: AbortSignal
): Promise<string[]> {
  const step = 'successfulDeployCommits'
  if (!ctx.token)
    throw new GitlabWriteError('GITLAB_NO_TOKEN', 'The deploy repository has no GitLab token', {
      step
    })
  const out: string[] = []
  for (let page = 1; page <= JOB_PAGES && out.length < max; page++) {
    if (signal?.aborted)
      throw new GitlabWriteError('ABORTED', 'Stopped before GitLab finished', { step })
    let res: { ok: boolean; status: number; body: unknown }
    try {
      res = await fetchJson(
        gitlabApi(ctx, `/jobs?scope[]=success&per_page=100&page=${page}`),
        { 'PRIVATE-TOKEN': ctx.token },
        15_000,
        { redirect: 'error', signal }
      )
    } catch {
      throw new GitlabWriteError('GITLAB_UNREACHABLE', `GitLab did not answer ${step}`, { step })
    }
    if (!res.ok)
      throw new GitlabWriteError('GITLAB_REFUSED', `GitLab refused ${step} (${res.status})`, {
        status: res.status,
        step
      })
    const list = Array.isArray(res.body) ? (res.body as Array<Record<string, unknown>>) : []
    for (const j of list) {
      if (out.length >= max) break
      if (j.name !== job || j.ref !== branch || j.status !== 'success') continue
      const commit = (j.commit as { id?: unknown } | null)?.id
      const sha =
        typeof commit === 'string' ? commit : (j.pipeline as { sha?: unknown } | null)?.sha
      if (typeof sha === 'string' && sha) out.push(sha)
    }
    if (list.length < 100) break
  }
  return out
}

/**
 * A file's text at `ref` (a commit), or null when GitLab has no such file (404). Token in the
 * PRIVATE-TOKEN header only, redirects refused, `signal` aborts the request; errors never carry
 * GitLab's answer.
 */
export async function readPinFile(
  ctx: GitCtx,
  path: string,
  ref: string,
  signal?: AbortSignal
): Promise<string | null> {
  const step = 'readPinFile'
  if (!ctx.token)
    throw new GitlabWriteError('GITLAB_NO_TOKEN', 'The deploy repository has no GitLab token', {
      step
    })
  let res: { ok: boolean; status: number; body: unknown }
  try {
    res = await fetchJson(
      gitlabApi(
        ctx,
        `/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`
      ),
      { 'PRIVATE-TOKEN': ctx.token },
      15_000,
      { redirect: 'error', signal }
    )
  } catch {
    throw new GitlabWriteError('GITLAB_UNREACHABLE', `GitLab did not answer ${step}`, { step })
  }
  if (res.status === 404) return null
  if (!res.ok)
    throw new GitlabWriteError('GITLAB_REFUSED', `GitLab refused ${step} (${res.status})`, {
      status: res.status,
      step
    })
  const f = (res.body ?? {}) as { content?: unknown; encoding?: unknown }
  const content = typeof f.content === 'string' ? f.content : ''
  return f.encoding === 'base64' ? Buffer.from(content, 'base64').toString('utf8') : content
}

/** The version a pin file names (its first line), or null. */
export function pinVersion(pin: string | null): string | null {
  const first = (pin ?? '').split('\n')[0]?.trim() ?? ''
  return VERSION_RE.test(first) ? first : null
}

export interface EvidenceOptions {
  budgetMs?: number
  now?: () => number
  /** GitLab readers (tests replace them); each takes the call's deadline signal. */
  readFile?: typeof readPinFile
  listCommits?: typeof successfulDeployCommits
  redis?: EvidenceRedis | null
}

/** The successful deploy commits, cached JOBS_TTL_MS per repository + branch + job. */
async function deployCommits(
  ctx: GitCtx,
  identity: string,
  branch: string,
  job: string,
  o: Required<Pick<EvidenceOptions, 'now' | 'listCommits'>> & {
    redis: EvidenceRedis | null
    signal: AbortSignal
  }
): Promise<string[]> {
  const key = `${identity}\n${branch}\n${job}`
  const hit = jobsCache.get(key)
  if (hit && hit.until > o.now()) return hit.shas
  return singleFlight(`jobs:${key}`, async () => {
    const redis = o.redis
    if (redis) {
      const raw = await boundedCall(() => redis.get(jobsKey(key)))
      if (typeof raw === 'string') {
        try {
          const shas = JSON.parse(raw) as unknown
          if (Array.isArray(shas) && shas.every((x) => typeof x === 'string')) {
            jobsCache.set(key, { until: o.now() + JOBS_TTL_MS, shas })
            return shas as string[]
          }
        } catch {
          /* unreadable: read GitLab */
        }
      }
    }
    const shas = await o.listCommits(ctx, branch, job, GITLAB_DEPLOY_EVIDENCE, o.signal)
    jobsCache.set(key, { until: o.now() + JOBS_TTL_MS, shas })
    if (redis)
      void boundedCall(() =>
        redis.set(jobsKey(key), JSON.stringify(shas), 'EX', Math.ceil(JOBS_TTL_MS / 1000))
      )
    return shas
  })
}

/**
 * The version the pin file names at `sha`: cached for good once read (a commit never changes);
 * a missing file (404) only MISSING_PIN_TTL_MS; a failed read never.
 */
async function pinAt(
  ctx: GitCtx,
  identity: string,
  pinFile: string,
  sha: string,
  read: typeof readPinFile,
  now: () => number,
  signal: AbortSignal
): Promise<string | null> {
  const key = `${identity}\n${pinFile}\n${sha}`
  const hit = pinCache.get(key)
  if (hit && (hit.until == null || hit.until > now())) {
    remember(key, hit)
    return hit.v
  }
  return singleFlight(`pin:${key}`, async () => {
    const text = await read(ctx, pinFile, sha, signal)
    const v = pinVersion(text)
    remember(key, { v, until: text == null ? now() + MISSING_PIN_TTL_MS : null })
    return v
  })
}

/**
 * Versions an environment's successful GitLab deploy jobs ran, read through the same drivers the
 * Hub deploys it with: each API component's deploy job on its target branch, and the pin file at
 * each job's commit (newest GITLAB_DEPLOY_EVIDENCE jobs per component). Within the budget only.
 */
export async function gitlabDeployedVersions(
  env: { placement_id: number | null },
  ctxFor: (driver: GitlabDriverRow) => GitCtx = driverCtx,
  opts: EvidenceOptions = {}
): Promise<string[]> {
  if (!env.placement_id) return []
  const now = opts.now ?? Date.now
  // The deadline: aborts the reads in flight (fetch sees the signal) and stops the loops.
  const stop = new AbortController()
  const budget = setTimeout(() => stop.abort(), opts.budgetMs ?? EVIDENCE_BUDGET_MS)
  budget.unref?.()
  const o = {
    now,
    listCommits: opts.listCommits ?? successfulDeployCommits,
    signal: stop.signal,
    redis:
      opts.redis !== undefined
        ? opts.redis
        : ((getApp()?.redis as EvidenceRedis | undefined) ?? null)
  }
  const read = opts.readFile ?? readPinFile
  const CUT = Symbol('cut')
  const atDeadline = new Promise<typeof CUT>((resolve) => {
    if (stop.signal.aborted) resolve(CUT)
    else stop.signal.addEventListener('abort', () => resolve(CUT), { once: true })
  })
  /** `p`, or CUT at the deadline (or when `p` failed: no evidence). */
  const within = async <T>(p: Promise<T>): Promise<T | typeof CUT> => {
    try {
      return await Promise.race([p, atDeadline])
    } catch {
      return CUT
    } finally {
      p.catch(() => undefined)
    }
  }
  try {
    return await collect()
  } finally {
    clearTimeout(budget)
    stop.abort()
  }

  async function collect(): Promise<string[]> {
    const [components, placement] = await Promise.all([
      listComponents(env.placement_id as number),
      getPlacement(env.placement_id as number)
    ])
    const versions = new Set<string>()
    for (const c of components) {
      if (stop.signal.aborted) break
      if (c.kind !== 'api') continue
      const driver = await getDriver(c.driver_id)
      if (driver?.kind !== 'gitlab' || !driver.config.pin_file) continue
      const ctx = ctxFor(driver)
      const identity = repositoryIdentity(ctx.base, ctx.project)
      const branch = componentTargetBranch(c, placement, driver.config.branch)
      if (!branch) continue
      const listed = await within(
        deployCommits(ctx, identity, branch, c.deploy_job ?? driver.config.deploy_job, o)
      )
      if (listed === CUT) continue
      const shas = [...new Set(listed)]
      for (let i = 0; i < shas.length; i += PIN_READS_AT_ONCE) {
        // Past the deadline no new read starts.
        if (stop.signal.aborted) break
        const pins = await Promise.all(
          shas
            .slice(i, i + PIN_READS_AT_ONCE)
            .map((sha) =>
              within(pinAt(ctx, identity, driver.config.pin_file, sha, read, now, stop.signal))
            )
        )
        for (const v of pins) if (typeof v === 'string') versions.add(v)
      }
    }
    return [...versions]
  }
}
