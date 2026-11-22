/**
 * Extensions are OCI images with the compiled extension at /extension
 * (Decision 9). Swarm has no image mounts, so the agent:
 *   1. pulls the image by digest (registry auth only for a matching registry),
 *   2. creates — never starts — a labelled container from it with no HostConfig,
 *   3. reads ONLY /extension through the archive endpoint,
 *   4. unpacks it into `<extensionsRoot>/<stack>/.tmp-<id>-<rand>`, refusing
 *      links, devices, fifos, absolute paths, `..`, anything outside
 *      `extension/`, more than 200 MB or too many entries,
 *   5. renames it to `<id>@<digest12>` and answers the HOST path of that
 *      folder (under extensionsHostRoot), which the services bind read-only.
 * The container is deleted in `finally`; a failed unpack leaves no folder.
 * A folder that already exists is complete (it only ever appears by rename)
 * and is reused.
 */
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, posix, resolve, sep } from 'node:path'
import { pipeline, type Readable, Transform } from 'node:stream'
import { pipeline as pipelineP } from 'node:stream/promises'
import { extract, type Headers } from 'tar-stream'
import type { AgentConfig } from './config.js'
import { type Engine, HUB_UNPACK_NAME_RE, LABEL_UNPACK } from './engine.js'
import { engineFailed, StackError } from './errors.js'
import type { Log } from './log.js'
import { isStackName, LABEL_MANAGED } from './names.js'
import { EXTENSION_ID_RE } from './spec.js'

export const EXTENSION_MAX_BYTES = 200 * 1024 * 1024
export const EXTENSION_MAX_ENTRIES = 20_000
/** Headers, pax records and padding on top of the file bytes. */
const ARCHIVE_OVERHEAD_BYTES = 16 * 1024 * 1024
const PULL_TIMEOUT_MS = 10 * 60_000
const ARCHIVE_TIMEOUT_MS = 5 * 60_000
const PINNED_RE = /^(.+)@sha256:([a-f0-9]{64})$/
/** How long a failed unpack waits for the entry being written before giving up on it. */
const INFLIGHT_WAIT_MS = 5000

export type ExtensionDeps = {
  maxBytes?: number
  maxEntries?: number
  random?: () => string
}

/** Anything about the archive the agent will not unpack. */
class InvalidArchive extends Error {}

const FS_INVALID = new Set(['EEXIST', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY'])

function invalid(id: string): StackError {
  return new StackError(422, 'EXTENSION_INVALID', 'The extension image cannot be used', [
    { field: `extensions.${id}`, code: 'EXTENSION_INVALID' }
  ])
}

function inside(root: string, p: string): boolean {
  return p.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/**
 * A folder the agent writes into must be a real directory, never a symlink
 * (lstat). Missing is fine (null); anything else refuses.
 */
async function assertRealDirOrMissing(p: string): Promise<'dir' | 'missing'> {
  let st: Awaited<ReturnType<typeof lstat>>
  try {
    st = await lstat(p)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw err
  }
  if (!st.isDirectory()) {
    throw new StackError(
      500,
      'EXTENSION_ROOT_UNSAFE',
      'The extension folder is not a real directory'
    )
  }
  return 'dir'
}

async function isDir(p: string): Promise<boolean> {
  try {
    const s = await lstat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

/** The registry host of a repository: `registry.example.com/acme/x` → that host, else Docker Hub. */
export function registryOf(repo: string): string {
  const first = repo.split('/')[0]
  if (repo.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost'))
    return first.toLowerCase()
  return 'docker.io'
}

/**
 * The X-Registry-Auth header for a repository, from the docker config.json
 * `auths` the agent was given — only when that registry matches. Never logged.
 */
export function registryAuthHeader(cfg: AgentConfig, repo: string): string | undefined {
  if (!cfg.registryAuth) return undefined
  const registry = registryOf(repo)
  const hub = registry === 'docker.io'
  const names = hub ? ['docker.io', 'index.docker.io', 'registry-1.docker.io'] : [registry]
  for (const [key, auth] of Object.entries(cfg.registryAuth)) {
    const host = key
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .toLowerCase()
    if (!names.includes(host)) continue
    const decoded = Buffer.from(auth, 'base64').toString('utf8')
    const colon = decoded.indexOf(':')
    if (colon < 1) continue
    return Buffer.from(
      JSON.stringify({
        username: decoded.slice(0, colon),
        password: decoded.slice(colon + 1),
        serveraddress: hub ? 'https://index.docker.io/v1/' : registry
      })
    ).toString('base64url')
  }
  return undefined
}

/** A pull answers 200 and then streams JSON lines; a failure is a line with `error`. */
function pullFailed(status: number, body: unknown): boolean {
  if (status !== 200) return true
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '')
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t)
      if (o && typeof o === 'object' && ('error' in o || 'errorDetail' in o)) return true
    } catch {
      // Not a JSON line: ignore it.
    }
  }
  return false
}

/** Pull `<repo>@sha256:<hex>` and make sure the Engine has it. */
export async function pullImage(engine: Engine, cfg: AgentConfig, ref: string): Promise<void> {
  const m = PINNED_RE.exec(ref)
  if (!m) throw new Error('pullImage: image not pinned')
  const [, repo, hex] = m
  const auth = registryAuthHeader(cfg, repo)
  const pulled = await engine.call('POST', '/images/create', {
    query: { fromImage: repo, tag: `sha256:${hex}` },
    ...(auth ? { headers: { 'X-Registry-Auth': auth } } : {}),
    timeoutMs: PULL_TIMEOUT_MS
  })
  if (pullFailed(pulled.status, pulled.body)) {
    throw new StackError(422, 'IMAGE_PULL_FAILED', 'The image could not be pulled')
  }
  const seen = await engine.call('GET', `/images/${ref}/json`)
  if (seen.status !== 200) {
    throw new StackError(422, 'IMAGE_PULL_FAILED', 'The image could not be pulled')
  }
}

type Limits = { maxBytes: number; maxEntries: number }

/** One archive entry, relative to `extension/`; null for the folder itself. */
function entryPath(h: Headers): string[] | null {
  const name = h.name
  if (typeof name !== 'string' || name === '') throw new InvalidArchive()
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/')) throw new InvalidArchive()
  const parts = name.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) throw new InvalidArchive()
  if (parts[0] !== 'extension') throw new InvalidArchive()
  const rel = parts.slice(1)
  return rel.length === 0 ? null : rel
}

/** Unpack a Docker archive of /extension into `dest` (an empty folder). */
function unpack(source: Readable, dest: string, limits: Limits): Promise<void> {
  const ex = extract()
  let entries = 0
  let total = 0
  let raw = 0
  const rawLimit = limits.maxBytes + ARCHIVE_OVERHEAD_BYTES + limits.maxEntries * 1536
  /** Set once the unpack failed: an entry still working stops at its next step. */
  let done = false

  /**
   * After every await: if the unpack already failed, stop here. tar-stream's
   * destroy() closes only the entry it is on, so a write attached to an entry
   * after that would wait forever.
   */
  function stopIfDone(stream: Readable): void {
    if (!done) return
    stream.resume()
    throw new InvalidArchive()
  }

  async function onEntry(h: Headers, stream: Readable): Promise<void> {
    entries += 1
    if (entries > limits.maxEntries) throw new InvalidArchive()
    const rel = entryPath(h)
    if (h.type === 'directory') {
      stream.resume()
      if (rel) {
        const dir = join(dest, ...rel)
        if (!inside(dest, dir)) throw new InvalidArchive()
        await mkdir(dir, { recursive: true, mode: 0o755 })
        stopIfDone(stream)
      }
      return
    }
    // Only plain files: no symlink, hardlink, device, fifo or anything unknown.
    if (h.type !== 'file' && h.type !== 'contiguous-file') throw new InvalidArchive()
    if (!rel) throw new InvalidArchive()
    const size = h.size ?? 0
    if (!Number.isSafeInteger(size) || size < 0) throw new InvalidArchive()
    total += size
    if (total > limits.maxBytes) throw new InvalidArchive()
    const target = join(dest, ...rel)
    if (!inside(dest, target)) throw new InvalidArchive()
    await mkdir(dirname(target), { recursive: true, mode: 0o755 })
    stopIfDone(stream)
    // Never setuid/setgid/sticky; readable by the app's uid; executable stays executable.
    const mode = (h.mode ?? 0o644) & 0o111 ? 0o755 : 0o644
    let written = 0
    const count = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length
        if (written > size) cb(new InvalidArchive())
        else cb(null, chunk)
      }
    })
    await pipelineP(stream, count, createWriteStream(target, { flags: 'wx', mode }))
    if (written !== size) throw new InvalidArchive()
  }

  return new Promise((resolveP, reject) => {
    /**
     * The entry being written: a failure waits for it, so no file lands after
     * the cleanup — but never longer than INFLIGHT_WAIT_MS.
     */
    let inflight: Promise<void> = Promise.resolve()
    const fail = (err: unknown) => {
      if (done) return
      done = true
      source.destroy()
      ex.destroy()
      let timer: NodeJS.Timeout | undefined
      const cap = new Promise<void>((r) => {
        timer = setTimeout(r, INFLIGHT_WAIT_MS)
        timer.unref?.()
      })
      Promise.race([inflight.catch(() => {}), cap]).then(() => {
        clearTimeout(timer)
        reject(err)
      })
    }
    ex.on('entry', (h, stream, next) => {
      const run = onEntry(h, stream)
      inflight = run
      run.then(
        () => next(),
        (err) => {
          stream.resume()
          fail(err)
        }
      )
    })
    // A corrupt header, an early end: tar-stream reports and would carry on.
    ex.on('error', () => fail(new InvalidArchive()))
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        raw += chunk.length
        if (raw > rawLimit) cb(new InvalidArchive())
        else cb(null, chunk)
      }
    })
    pipeline(source, counter, ex, (err) => {
      if (err) fail(err instanceof InvalidArchive ? err : new InvalidArchive())
      else if (!done) {
        done = true
        resolveP()
      }
    })
  })
}

/**
 * The host path of the unpacked extension `id` pinned at `ref`, for `stack`.
 * Throws StackError IMAGE_PULL_FAILED / EXTENSION_INVALID (422) or
 * ENGINE_ERROR (502).
 */
type FolderPaths = { stackDir: string; finalDir: string; hostPath: string }

/** Where extension `id` pinned at `ref` lives for `stack`: agent-side folders and the host path. */
function folderPaths(cfg: AgentConfig, stack: string, id: string, ref: string): FolderPaths {
  if (!isStackName(stack)) throw new Error('extension: bad stack name')
  if (!EXTENSION_ID_RE.test(id)) throw new Error('extension: bad extension id')
  const m = PINNED_RE.exec(ref)
  if (!m) throw new Error('extension: image not pinned')
  const folder = `${id}@${m[2].slice(0, 12)}`
  const root = resolve(cfg.extensionsRoot)
  const stackDir = join(root, stack)
  const finalDir = join(stackDir, folder)
  if (!inside(root, finalDir)) throw new Error('extension: path outside the root')
  const hostRoot = posix.normalize(cfg.extensionsHostRoot).replace(/\/+$/, '')
  const hostPath = posix.join(hostRoot, stack, folder)
  if (!hostPath.startsWith(`${hostRoot}/`)) throw new Error('extension: host path outside the root')
  return { stackDir, finalDir, hostPath }
}

/**
 * The host path of an already unpacked extension, or null when its folder is
 * not there. Pulls nothing, creates nothing (restart uses it). A symlinked
 * stack or target folder refuses.
 */
export async function existingExtension(
  cfg: AgentConfig,
  stack: string,
  id: string,
  ref: string
): Promise<string | null> {
  const { stackDir, finalDir, hostPath } = folderPaths(cfg, stack, id, ref)
  if ((await assertRealDirOrMissing(stackDir)) === 'missing') return null
  return (await assertRealDirOrMissing(finalDir)) === 'dir' ? hostPath : null
}

export async function ensureExtension(
  engine: Engine,
  cfg: AgentConfig,
  stack: string,
  id: string,
  ref: string,
  deps: ExtensionDeps = {}
): Promise<string> {
  const { stackDir, finalDir, hostPath } = folderPaths(cfg, stack, id, ref)

  // The stack folder and the target are real directories or absent: never a symlink.
  await assertRealDirOrMissing(stackDir)
  if ((await assertRealDirOrMissing(finalDir)) === 'dir') return hostPath

  const random = deps.random ?? (() => randomBytes(8).toString('hex'))
  const limits: Limits = {
    maxBytes: deps.maxBytes ?? EXTENSION_MAX_BYTES,
    maxEntries: deps.maxEntries ?? EXTENSION_MAX_ENTRIES
  }

  await pullImage(engine, cfg, ref)

  const container = `nvh_${stack}_unpack_${random()}`
  let tmp: string | null = null
  try {
    const created = await engine.call('POST', '/containers/create', {
      query: { name: container },
      body: {
        Image: ref,
        Cmd: ['/bin/true'],
        Labels: { 'nivaro.hub.managed': '1', 'nivaro.hub.unpack': stack },
        HostConfig: {}
      }
    })
    if (created.status < 200 || created.status >= 300) throw engineFailed()

    // The folders first: once the archive is open, nothing awaits before the unpack reads it.
    await mkdir(stackDir, { recursive: true, mode: 0o755 })
    if ((await assertRealDirOrMissing(stackDir)) !== 'dir') throw engineFailed()
    tmp = join(stackDir, `.tmp-${id}-${random()}`)
    await mkdir(tmp, { mode: 0o755 })
    const archive = await engine.stream('GET', `/containers/${container}/archive`, {
      query: { path: '/extension' },
      timeoutMs: ARCHIVE_TIMEOUT_MS
    })
    // A socket error before a reader is attached must not become an uncaught 'error' event;
    // pipeline still sees the stream as failed.
    archive.stream.on('error', () => {})
    if (archive.status !== 200) {
      archive.stream.resume()
      // 404: the image has no /extension.
      throw archive.status === 404 ? invalid(id) : engineFailed()
    }
    try {
      await unpack(archive.stream, tmp, limits)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code
      if (err instanceof InvalidArchive || (code && FS_INVALID.has(code))) throw invalid(id)
      throw err
    }
    try {
      await rename(tmp, finalDir)
    } catch (err) {
      // Another apply finished the same folder first: use that one.
      if (!(await isDir(finalDir))) throw err
      await rm(tmp, { recursive: true, force: true })
    }
    tmp = null
    return hostPath
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {})
    await engine
      .call('DELETE', `/containers/${container}`, { query: { force: true } })
      .catch(() => {})
  }
}

/** Delete every extension folder of a stack (its services are gone). */
export async function removeExtensionFolders(cfg: AgentConfig, stack: string): Promise<void> {
  if (!isStackName(stack)) throw new Error('removeExtensionFolders: bad stack name')
  const root = resolve(cfg.extensionsRoot)
  const dir = join(root, stack)
  if (!inside(root, dir)) throw new Error('removeExtensionFolders: path outside the root')
  await rm(dir, { recursive: true, force: true })
}

/**
 * At agent start: delete unpack containers a crash left behind. Listed by the
 * unpack label; each one goes only when its name is `nvh_<stack>_unpack_<hex>`
 * and its labels name that stack (the engine guard reads the labels again,
 * live, before the delete). A container younger than the unpack timeout is
 * spared (an unpack may still be reading it). Answers the names removed; never throws.
 */
export async function sweepUnpackContainers(
  engine: Engine,
  log?: Log,
  now: () => number = Date.now
): Promise<string[]> {
  const removed: string[] = []
  try {
    const r = await engine.call<unknown>('GET', '/containers/json', {
      query: { all: true, filters: JSON.stringify({ label: ['nivaro.hub.unpack'] }) }
    })
    if (r.status !== 200 || !Array.isArray(r.body)) return removed
    for (const c of r.body as Array<{ Names?: unknown; Labels?: Record<string, string> }>) {
      const names = Array.isArray(c?.Names) ? c.Names : []
      const name = typeof names[0] === 'string' ? names[0].replace(/^\//, '') : ''
      const m = HUB_UNPACK_NAME_RE.exec(name)
      if (!m || c.Labels?.[LABEL_MANAGED] !== '1' || c.Labels?.[LABEL_UNPACK] !== m[1]) continue
      // A concurrent ensureExtension may still be reading this one: only old ones go.
      const created = (c as { Created?: unknown }).Created
      if (typeof created !== 'number' || now() - created * 1000 < ARCHIVE_TIMEOUT_MS) continue
      try {
        const d = await engine.call('DELETE', `/containers/${name}`, {
          query: { force: true, v: true }
        })
        if (d.status >= 200 && d.status < 300) removed.push(name)
      } catch (err) {
        log?.({
          t: new Date().toISOString(),
          level: 'warn',
          op: 'sweep-unpack',
          code: (err as { code?: string } | null)?.code ?? 'ERROR'
        })
      }
    }
  } catch (err) {
    log?.({
      t: new Date().toISOString(),
      level: 'warn',
      op: 'sweep-unpack',
      code: (err as { code?: string } | null)?.code ?? 'ERROR'
    })
  }
  if (removed.length) {
    log?.({
      t: new Date().toISOString(),
      level: 'info',
      op: 'sweep-unpack',
      removed: removed.length
    })
  }
  return removed
}

/**
 * At agent start: delete `.tmp-*` unpack folders a crash left under
 * `<root>/<stack>/`, only those older than the unpack timeout (a live unpack
 * may own a younger one). lstat everywhere, a symlink is never entered or
 * removed through, and nothing outside the extensions root is touched.
 * Answers `<stack>/<folder>` per folder removed; never throws.
 */
export async function sweepUnpackFolders(
  cfg: AgentConfig,
  log?: Log,
  now: () => number = Date.now
): Promise<string[]> {
  const removed: string[] = []
  const root = resolve(cfg.extensionsRoot)
  try {
    if (!(await isDir(root))) return removed
    for (const stack of await readdir(root)) {
      if (!isStackName(stack)) continue
      const stackDir = join(root, stack)
      if (!inside(root, stackDir) || !(await isDir(stackDir))) continue
      for (const name of await readdir(stackDir)) {
        if (!name.startsWith('.tmp-')) continue
        const dir = join(stackDir, name)
        try {
          if (!inside(stackDir, dir)) continue
          const st = await lstat(dir)
          if (!st.isDirectory() || now() - st.mtimeMs < ARCHIVE_TIMEOUT_MS) continue
          await rm(dir, { recursive: true, force: true })
          removed.push(`${stack}/${name}`)
        } catch (err) {
          log?.({
            t: new Date().toISOString(),
            level: 'warn',
            op: 'sweep-unpack-folders',
            code: (err as { code?: string } | null)?.code ?? 'ERROR'
          })
        }
      }
    }
  } catch (err) {
    log?.({
      t: new Date().toISOString(),
      level: 'warn',
      op: 'sweep-unpack-folders',
      code: (err as { code?: string } | null)?.code ?? 'ERROR'
    })
  }
  if (removed.length) {
    log?.({
      t: new Date().toISOString(),
      level: 'info',
      op: 'sweep-unpack-folders',
      removed: removed.length
    })
  }
  return removed
}
