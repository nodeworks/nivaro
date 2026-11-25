/**
 * A stack's uploads folder on the NFS export (agent 0.2.3), checked through the export root the
 * agent's own container mounts (HUB_AGENT_VOLUME_EXPORT_MOUNT) before the stack's volume is made.
 * Docker's local NFS driver never creates the folder a `device` names: a missing one fails every
 * task at mount time, so the agent makes sure first.
 *
 * The agent is privileged and the app writes inside its uploads folder, so app-made links must
 * never steer what the agent does (security reviews 2026-11-24):
 * - Every segment from the export mount down is read with lstat (never followed): a link, or
 *   anything that is not a directory, refuses UPLOADS_FOLDER_LINK.
 * - Every folder ABOVE the uploads folder (the export root included) must not be group- or
 *   other-writable (UPLOADS_FOLDER_PARENT_WRITABLE): whoever can write there could swap a
 *   segment for a link later, and Docker resolves the device again at every task start.
 * - The agent creates only `<stack>` (0755) and `<stack>/uploads`, one segment at a time with a
 *   non-recursive mkdir under a parent it just checked, and claims `<stack>` with a marker file
 *   naming its swarm and the stack. A `<stack>` folder without the agent's marker is never used
 *   (UPLOADS_FOLDER_NOT_OURS): another system's folder, or another agent's (two swarms on one
 *   export). Only an explicit `uploads_folder` adopts a folder the agent did not make.
 * - Ownership is handed to uid 1000 only for a `<stack>/uploads` this run created, through a
 *   handle opened with O_NOFOLLOW|O_DIRECTORY whose inode is the one just checked and whose real
 *   path is `<real export>/<folder>` (fchown on the handle, never a path). An existing folder is
 *   never chowned, an adopted one never touched.
 * - The files sub-folder is only checked: an adopted folder's must exist (else
 *   UPLOADS_FOLDER_MISSING); in the stack's own folder a missing one is left to the app, which
 *   creates its storage root itself.
 *
 * These checks hold at APPLY time. Docker resolves the device again whenever a task starts, on
 * every node: keep the export root and `<stack>` writable by nobody but the file server's
 * administrators (no app or service mounts the export root itself).
 *
 * The agent never deletes a folder or a file on the export, and never removes an uploads volume
 * on the export (remove keeps it: its object holds nothing, its files stay on the share).
 */
import { constants } from 'node:fs'
import { lstat, mkdir, open, readlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { StackError } from './errors.js'
import { APP_GID, APP_UID, appCanWrite, folderOk, type VolumePlan } from './volumes.js'

export type FolderStat = {
  dev: number
  ino: number
  uid: number
  gid: number
  mode: number
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/** A folder opened with O_NOFOLLOW|O_DIRECTORY: what it is stays fixed while it is open. */
export type DirHandle = {
  stat(): Promise<FolderStat>
  /** Where the open folder really is (Linux: /proc/self/fd), or null where that cannot be read. */
  where(): Promise<string | null>
  chown(uid: number, gid: number): Promise<void>
  chmod(mode: number): Promise<void>
  close(): Promise<void>
}

export type FolderFs = {
  /** Never follows a link. */
  lstat(p: string): Promise<FolderStat>
  /** One segment, never recursive. */
  mkdir(p: string, mode: number): Promise<unknown>
  realpath(p: string): Promise<string>
  /** O_RDONLY|O_DIRECTORY|O_NOFOLLOW: a link or a file at `p` throws. */
  openDir(p: string): Promise<DirHandle>
  /** The marker's text (O_NOFOLLOW), or null when there is none. */
  readMarker(p: string): Promise<string | null>
  /** A new marker (O_CREAT|O_EXCL|O_NOFOLLOW): never writes through a link or over a file. */
  writeMarker(p: string, text: string): Promise<void>
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const DIRECTORY = constants.O_DIRECTORY ?? 0

export const defaultFolderFs: FolderFs = {
  lstat,
  mkdir: (p, mode) => mkdir(p, { mode }),
  realpath,
  async openDir(p) {
    const fh = await open(p, constants.O_RDONLY | DIRECTORY | NOFOLLOW)
    return {
      stat: () => fh.stat(),
      async where() {
        try {
          return await readlink(`/proc/self/fd/${fh.fd}`)
        } catch {
          return null
        }
      },
      chown: (uid, gid) => fh.chown(uid, gid),
      chmod: (mode) => fh.chmod(mode),
      close: () => fh.close()
    }
  },
  async readMarker(p) {
    let fh: Awaited<ReturnType<typeof open>>
    try {
      fh = await open(p, constants.O_RDONLY | NOFOLLOW)
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') return null
      throw err
    }
    try {
      const st = await fh.stat()
      if (!st.isFile() || st.size > 4096) return ''
      return await fh.readFile('utf8')
    } finally {
      await fh.close()
    }
  },
  async writeMarker(p, text) {
    const fh = await open(
      p,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o644
    )
    try {
      await fh.writeFile(text, 'utf8')
    } finally {
      await fh.close()
    }
  }
}

/** The marker in `<stack>` that says this agent's swarm made the folder for this stack. */
export const MARKER = '.nivaro-hub-agent'

export function markerText(clusterId: string, stack: string): string {
  return `${JSON.stringify({ cluster: clusterId, stack })}\n`
}

function markerMatches(text: string | null, clusterId: string, stack: string): boolean {
  if (!text) return false
  try {
    const m = JSON.parse(text) as { cluster?: unknown; stack?: unknown }
    return m.cluster === clusterId && m.stack === stack
  } catch {
    return false
  }
}

const code = (err: unknown) => (err as { code?: unknown } | null)?.code

const refusal = (c: string, message: string, field: string) =>
  new StackError(409, c, message, [{ field, code: c }])

const missing = (folder: string, field: string) =>
  refusal(
    'UPLOADS_FOLDER_MISSING',
    field === 'uploads'
      ? `The agent could not create ${folder} on the NFS export: create it there, owned by uid ${APP_UID}:${APP_GID}`
      : `The folder ${folder} is not on the NFS export: create it (writable by uid ${APP_UID}) or fix the stack's folder settings`,
    field
  )

const notWritable = (folder: string, field: string) =>
  refusal(
    'UPLOADS_FOLDER_NOT_WRITABLE',
    `uid ${APP_UID} cannot write ${folder} on the NFS export: run chown -R ${APP_UID}:${APP_GID} on it on the file server (or export the share with anonuid=${APP_UID})`,
    field
  )

const unchecked = (folder: string, field: string) =>
  refusal(
    'UPLOADS_FOLDER_UNCHECKED',
    `The agent cannot look into ${folder} through its export mount (permissions): it does not deploy a stack whose files it cannot check`,
    field
  )

const linked = (folder: string, field: string) =>
  refusal(
    'UPLOADS_FOLDER_LINK',
    `${folder} on the NFS export is (or passes through) a link or a file, not a plain folder: the agent never follows links there`,
    field
  )

const parentWritable = (folder: string, parent: string, field: string) =>
  refusal(
    'UPLOADS_FOLDER_PARENT_WRITABLE',
    `${parent} above ${folder} on the NFS export is writable by its group or by everyone: anyone who can write there could swap the folder for a link. Remove group and other write (chmod go-w) on the file server`,
    field
  )

const notOurs = (stack: string) =>
  refusal(
    'UPLOADS_FOLDER_NOT_OURS',
    `${stack} already exists on the NFS export and this agent did not make it (no marker of this swarm and stack): adopt the folder you mean with the stack's uploads folder setting, or remove ${stack} on the file server`,
    'uploads'
  )

/** lstat that answers null for "not there"; any other failure refuses. */
async function lstatOrNull(
  fs: FolderFs,
  p: string,
  folder: string,
  field: string
): Promise<FolderStat | null> {
  try {
    return await fs.lstat(p)
  } catch (err) {
    if (code(err) === 'ENOENT') return null
    if (code(err) === 'ENOTDIR') throw linked(folder, field)
    throw unchecked(folder, field)
  }
}

/** A plain directory (not a link, not a file), or a refusal. */
function plainDir(st: FolderStat, folder: string, field: string): FolderStat {
  if (st.isSymbolicLink() || !st.isDirectory()) throw linked(folder, field)
  return st
}

const groupOrOtherWritable = (st: FolderStat) => (st.mode & 0o022) !== 0

/** The folder's real path must be exactly `<real export>/<rel>`: nothing outside, no detour. */
async function assertRealPath(
  fs: FolderFs,
  realRoot: string,
  exportMount: string,
  rel: string,
  folder: string,
  field: string
): Promise<void> {
  let realDir: string
  try {
    realDir = await fs.realpath(join(exportMount, rel))
  } catch {
    throw unchecked(folder, field)
  }
  if (realDir !== join(realRoot, rel)) throw linked(folder, field)
}

/**
 * Opens `path` without following a link and proves it is the folder just checked: same inode
 * (`expect`), and (where the platform tells) really at `want`. Answers the open handle.
 */
async function openChecked(
  fs: FolderFs,
  path: string,
  expect: FolderStat,
  want: string,
  folder: string,
  field: string
): Promise<DirHandle> {
  let h: DirHandle
  try {
    h = await fs.openDir(path)
  } catch (err) {
    if (code(err) === 'ELOOP' || code(err) === 'ENOTDIR') throw linked(folder, field)
    throw unchecked(folder, field)
  }
  try {
    const st = await h.stat()
    if (st.dev !== expect.dev || st.ino !== expect.ino || !st.isDirectory())
      throw linked(folder, field)
    const where = await h.where()
    if (where !== null && where !== want) throw linked(folder, field)
    return h
  } catch (err) {
    await h.close().catch(() => {})
    throw err
  }
}

export type FolderContext = {
  /** The swarm's cluster id (GET /info Swarm.Cluster.ID): the marker names it. */
  clusterId: string
  /** The stack the folder is for. */
  stack: string
}

/**
 * Makes sure the stack's uploads folder is there and uid 1000 can write it, and that its files
 * sub-folder (when named) is a plain folder. A plan without a folder (no NFS export) needs
 * nothing.
 */
export async function ensureUploadsFolder(
  exportMount: string | null,
  plan: VolumePlan,
  filesSubfolder: string | undefined,
  ctx: FolderContext,
  fs: FolderFs = defaultFolderFs
): Promise<void> {
  if (plan.folder === null) return
  if (exportMount === null) {
    throw new StackError(
      409,
      'EXPORT_MOUNT_MISSING',
      'The agent keeps uploads on an NFS export but does not see the export (HUB_AGENT_VOLUME_EXPORT_MOUNT is not set), so it cannot check the stack folder'
    )
  }
  const folder = plan.folder
  const field = plan.adopted ? 'uploads_folder' : 'uploads'
  if (!folderOk(folder)) throw linked(folder, field)
  const segments = folder.split('/')
  // The stack's own folder is exactly <stack>/uploads; anything else is adopted.
  if (!plan.adopted && (segments.length !== 2 || segments[0] !== ctx.stack))
    throw linked(folder, field)

  // The export mount itself: a plain folder nobody but its owner can write.
  const root = await lstatOrNull(fs, exportMount, folder, field)
  if (root === null) throw unchecked(folder, field)
  plainDir(root, folder, field)
  if (groupOrOtherWritable(root)) throw parentWritable(folder, 'The export root', field)
  let realRoot: string
  try {
    realRoot = await fs.realpath(exportMount)
  } catch {
    throw unchecked(folder, field)
  }

  // Walk down, one segment at a time, never following a link.
  let path = exportMount
  let st: FolderStat | null = null
  let createdLeaf = false
  for (let i = 0; i < segments.length; i++) {
    const rel = segments.slice(0, i + 1).join('/')
    path = join(path, segments[i])
    st = await lstatOrNull(fs, path, folder, field)
    let created = false
    if (st === null) {
      if (plan.adopted) throw missing(folder, field)
      try {
        await fs.mkdir(path, 0o755)
        created = true
      } catch (err) {
        if (code(err) !== 'EEXIST') throw missing(folder, field)
      }
      st = await lstatOrNull(fs, path, folder, field)
      if (st === null) throw missing(folder, field)
    }
    plainDir(st, folder, field)
    const isLeaf = i === segments.length - 1
    if (!plan.adopted && i === 0) {
      // <stack>: made 0755 by this agent and claimed with its marker, or claimed already.
      const marker = join(path, MARKER)
      if (created) {
        const h = await openChecked(fs, path, st, join(realRoot, rel), folder, field)
        try {
          await h.chmod(0o755)
          st = await h.stat()
        } finally {
          await h.close()
        }
        try {
          await fs.writeMarker(marker, markerText(ctx.clusterId, ctx.stack))
        } catch {
          throw missing(folder, field)
        }
      } else {
        let text: string | null
        try {
          text = await fs.readMarker(marker)
        } catch {
          throw notOurs(ctx.stack)
        }
        if (!markerMatches(text, ctx.clusterId, ctx.stack)) throw notOurs(ctx.stack)
      }
    }
    if (!isLeaf && groupOrOtherWritable(st)) throw parentWritable(folder, rel, field)
    if (isLeaf) createdLeaf = created
  }
  if (st === null) throw missing(folder, field)
  await assertRealPath(fs, realRoot, exportMount, folder, folder, field)

  if (!appCanWrite(st)) {
    // Only a <stack>/uploads this run created is handed over, through a no-follow handle on the
    // very inode just checked. An existing folder is the operator's to fix; an adopted one is
    // never touched.
    if (plan.adopted || !createdLeaf) throw notWritable(folder, field)
    const h = await openChecked(fs, path, st, join(realRoot, folder), folder, field)
    try {
      try {
        await h.chown(APP_UID, APP_GID)
      } catch {
        // No CAP_CHOWN, or root squash: the operator fixes it on the file server.
      }
      const after = await h.stat()
      if (!appCanWrite(after)) throw notWritable(folder, field)
    } finally {
      await h.close()
    }
  }

  if (filesSubfolder === undefined) return
  // The files sub-folder: inside what the app can write, so only ever checked, never made or
  // handed over.
  const sub = `${folder}/${filesSubfolder}`
  const subField = 'files_subfolder'
  if (!folderOk(filesSubfolder)) throw linked(sub, subField)
  let subPath = join(exportMount, folder)
  let subSt: FolderStat | null = null
  for (const seg of filesSubfolder.split('/')) {
    subPath = join(subPath, seg)
    subSt = await lstatOrNull(fs, subPath, sub, subField)
    if (subSt === null) break
    plainDir(subSt, sub, subField)
  }
  if (subSt === null) {
    // The app creates its storage root itself; an adopted layout must already hold it.
    if (plan.adopted) throw missing(sub, subField)
    return
  }
  await assertRealPath(fs, realRoot, exportMount, sub, sub, subField)
  if (!appCanWrite(subSt)) throw notWritable(sub, subField)
}
