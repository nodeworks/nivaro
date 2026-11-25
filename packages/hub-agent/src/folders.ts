/**
 * A stack's uploads folder on the NFS export (agent 0.2.2), checked through the export root the
 * agent's own container mounts (HUB_AGENT_VOLUME_EXPORT_MOUNT) before the stack's volume is made.
 * Docker's local NFS driver never creates the folder a `device` names: a missing one fails every
 * task at mount time, so the agent makes sure first.
 *
 * The agent is privileged and the app writes inside its uploads folder, so app-made links must
 * never steer what the agent does (security review 2026-11-24):
 * - Every segment from the export mount down is read with lstat (never followed): a link, or
 *   anything that is not a directory, refuses UPLOADS_FOLDER_LINK.
 * - The agent creates only `<stack>` and `<stack>/uploads` (its own folder), one segment at a
 *   time with a non-recursive mkdir under a parent it just checked, then checks again; the
 *   folder's real path (realpath) must be exactly `<real export>/<folder>`.
 * - It hands over (lchown: never follows a link) only `<stack>/uploads`, never an adopted folder,
 *   never the files sub-folder, never anything inside a folder the app can write.
 * - The files sub-folder is only checked: an adopted folder's must exist (else
 *   UPLOADS_FOLDER_MISSING); in the stack's own folder a missing one is left to the app, which
 *   creates its storage root itself.
 * Either way the folder must be one uid 1000 can write (mode bits, as the image's entrypoint
 * judges it), else 409 UPLOADS_FOLDER_NOT_WRITABLE naming the folder and the fix. Answers name
 * the folder relative to the export, never the mount path or an option.
 *
 * The agent never deletes a folder or a file on the export: remove (with volumes) deletes only
 * the Docker volume objects, and Docker's local driver unmounts an NFS volume without touching
 * the files on the share.
 */
import { lchown, lstat, mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { StackError } from './errors.js'
import { APP_GID, APP_UID, appCanWrite, folderOk, type VolumePlan } from './volumes.js'

export type FolderStat = {
  uid: number
  gid: number
  mode: number
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export type FolderFs = {
  /** Never follows a link. */
  lstat(p: string): Promise<FolderStat>
  /** One segment, never recursive. */
  mkdir(p: string, mode: number): Promise<unknown>
  /** Never follows a link. */
  lchown(p: string, uid: number, gid: number): Promise<void>
  realpath(p: string): Promise<string>
}

export const defaultFolderFs: FolderFs = {
  lstat,
  mkdir: (p, mode) => mkdir(p, { mode }),
  lchown,
  realpath
}

const code = (err: unknown) => (err as { code?: unknown } | null)?.code

const refusal = (status: number, c: string, message: string, field: string) =>
  new StackError(status, c, message, [{ field, code: c }])

const missing = (folder: string, field: string) =>
  refusal(
    409,
    'UPLOADS_FOLDER_MISSING',
    field === 'uploads'
      ? `The agent could not create ${folder} on the NFS export: create it there, owned by uid ${APP_UID}:${APP_GID}`
      : `The folder ${folder} is not on the NFS export: create it (writable by uid ${APP_UID}) or fix the stack's folder settings`,
    field
  )

const notWritable = (folder: string, field: string) =>
  refusal(
    409,
    'UPLOADS_FOLDER_NOT_WRITABLE',
    `uid ${APP_UID} cannot write ${folder} on the NFS export: run chown -R ${APP_UID}:${APP_GID} on it on the file server (or export the share with anonuid=${APP_UID})`,
    field
  )

const unchecked = (folder: string, field: string) =>
  refusal(
    409,
    'UPLOADS_FOLDER_UNCHECKED',
    `The agent cannot look into ${folder} through its export mount (permissions): it does not deploy a stack whose files it cannot check`,
    field
  )

const linked = (folder: string, field: string) =>
  refusal(
    409,
    'UPLOADS_FOLDER_LINK',
    `${folder} on the NFS export is (or passes through) a link or a file, not a plain folder: the agent never follows links there`,
    field
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

/**
 * Walks `rel` (already a valid relative folder) segment by segment under `root`, never following
 * a link. `makeTo` = how many leading segments the agent may create when missing (0 = none).
 * Answers the last segment's stat, or null when a segment is missing and may not be made.
 */
async function walk(
  fs: FolderFs,
  root: string,
  rel: string,
  makeTo: number,
  folder: string,
  field: string
): Promise<FolderStat | null> {
  const segments = rel.split('/')
  let path = root
  let st: FolderStat | null = null
  for (let i = 0; i < segments.length; i++) {
    path = join(path, segments[i])
    st = await lstatOrNull(fs, path, folder, field)
    if (st === null) {
      if (i >= makeTo) return null
      try {
        await fs.mkdir(path, 0o775)
      } catch (err) {
        if (code(err) !== 'EEXIST') throw missing(folder, field)
      }
      st = await lstatOrNull(fs, path, folder, field)
      if (st === null) throw missing(folder, field)
    }
    plainDir(st, folder, field)
  }
  return st
}

/** The folder's real path must be exactly `<real export>/<rel>`: nothing outside, no detour. */
async function assertRealPath(
  fs: FolderFs,
  exportMount: string,
  rel: string,
  folder: string,
  field: string
): Promise<void> {
  let realRoot: string
  let realDir: string
  try {
    realRoot = await fs.realpath(exportMount)
    realDir = await fs.realpath(join(exportMount, rel))
  } catch {
    throw unchecked(folder, field)
  }
  if (realDir !== join(realRoot, rel)) throw linked(folder, field)
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
  // The export mount itself must be a plain folder too.
  const root = await lstatOrNull(fs, exportMount, folder, field)
  if (root === null) throw unchecked(folder, field)
  plainDir(root, folder, field)

  // The stack's own folder: the agent may create both its segments (<stack>/uploads).
  const makeTo = plan.adopted ? 0 : folder.split('/').length
  let st = await walk(fs, exportMount, folder, makeTo, folder, field)
  if (st === null) throw missing(folder, field)
  await assertRealPath(fs, exportMount, folder, folder, field)

  if (!appCanWrite(st)) {
    // Only the folder the agent owns the layout of is handed over, by lchown (never a link,
    // checked just above): never an adopted one, never anything the app can write into.
    if (plan.adopted) throw notWritable(folder, field)
    try {
      await fs.lchown(join(exportMount, folder), APP_UID, APP_GID)
    } catch {
      // No CAP_CHOWN, or root squash: the operator fixes it on the file server.
    }
    st = await lstatOrNull(fs, join(exportMount, folder), folder, field)
    if (st === null) throw missing(folder, field)
    plainDir(st, folder, field)
    if (!appCanWrite(st)) throw notWritable(folder, field)
  }

  if (filesSubfolder === undefined) return
  // The files sub-folder: inside what the app can write, so only ever checked, never made or
  // handed over.
  const sub = `${folder}/${filesSubfolder}`
  const subField = 'files_subfolder'
  if (!folderOk(filesSubfolder)) throw linked(sub, subField)
  const subSt = await walk(fs, join(exportMount, folder), filesSubfolder, 0, sub, subField)
  if (subSt === null) {
    // The app creates its storage root itself; an adopted layout must already hold it.
    if (plan.adopted) throw missing(sub, subField)
    return
  }
  await assertRealPath(fs, exportMount, `${folder}/${filesSubfolder}`, sub, subField)
  if (!appCanWrite(subSt)) throw notWritable(sub, subField)
}
