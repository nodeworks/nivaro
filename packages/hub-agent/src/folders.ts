/**
 * A stack's uploads folder on the NFS export (agent 0.2.2), checked through the export root the
 * agent's own container mounts (HUB_AGENT_VOLUME_EXPORT_MOUNT) before the stack's volume is made.
 * Docker's local NFS driver never creates the folder a `device` names: a missing one fails every
 * task at mount time, so the agent makes sure first.
 *
 * - The stack's own folder (`<stack>/uploads`): made when missing, then handed to uid 1000
 *   (chown; refused without CAP_CHOWN or under root squash, which is fine when the export maps
 *   the agent's writes to 1000 already).
 * - An adopted folder (`uploads_folder`) and its files sub-folder: used as they are. Never made,
 *   never chowned, never changed.
 * Either way the folder must be one uid 1000 can write (mode bits, as the image's entrypoint
 * judges it), else 409 UPLOADS_FOLDER_NOT_WRITABLE naming the folder and the fix. Answers name
 * the folder relative to the export, never the mount path or an option.
 *
 * The agent never deletes a folder or a file on the export: remove (with volumes) deletes only
 * the Docker volume objects, and Docker's local driver unmounts an NFS volume without touching
 * the files on the share.
 */
import { chown, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { StackError } from './errors.js'
import { APP_GID, APP_UID, appCanWrite, type VolumePlan } from './volumes.js'

export type FolderStat = { uid: number; gid: number; mode: number; isDirectory(): boolean }

export type FolderFs = {
  stat(p: string): Promise<FolderStat>
  mkdir(p: string, opts: { recursive: true; mode: number }): Promise<unknown>
  chown(p: string, uid: number, gid: number): Promise<void>
}

export const defaultFolderFs: FolderFs = { stat, mkdir, chown }

const code = (err: unknown) => (err as { code?: unknown } | null)?.code

const missing = (folder: string, adopted: boolean) =>
  new StackError(
    409,
    'UPLOADS_FOLDER_MISSING',
    adopted
      ? `The folder ${folder} is not on the NFS export: create it (owned by uid ${APP_UID}) or fix the stack's uploads folder`
      : `The agent could not create ${folder} on the NFS export: create it there, owned by uid ${APP_UID}:${APP_GID}`,
    [{ field: adopted ? 'uploads_folder' : 'uploads', code: 'UPLOADS_FOLDER_MISSING' }]
  )

const notWritable = (folder: string) =>
  new StackError(
    409,
    'UPLOADS_FOLDER_NOT_WRITABLE',
    `uid ${APP_UID} cannot write ${folder} on the NFS export: run chown -R ${APP_UID}:${APP_GID} on it on the file server (or export the share with anonuid=${APP_UID})`,
    [{ field: 'uploads', code: 'UPLOADS_FOLDER_NOT_WRITABLE' }]
  )

const unchecked = (folder: string) =>
  new StackError(
    409,
    'UPLOADS_FOLDER_UNCHECKED',
    `The agent cannot look into ${folder} through its export mount (permissions): it does not deploy a stack whose files it cannot check`,
    [{ field: 'uploads', code: 'UPLOADS_FOLDER_UNCHECKED' }]
  )

async function statOrNull(fs: FolderFs, p: string, folder: string): Promise<FolderStat | null> {
  try {
    return await fs.stat(p)
  } catch (err) {
    if (code(err) === 'ENOENT') return null
    if (code(err) === 'ENOTDIR') return null
    throw unchecked(folder)
  }
}

/** One folder: present (or made when `make`), a directory, writable by uid 1000. */
async function ensureOne(
  fs: FolderFs,
  path: string,
  folder: string,
  make: boolean,
  adopted: boolean
): Promise<void> {
  let st = await statOrNull(fs, path, folder)
  if (st === null) {
    if (!make) throw missing(folder, adopted)
    try {
      await fs.mkdir(path, { recursive: true, mode: 0o775 })
    } catch (err) {
      if (code(err) !== 'EEXIST') throw missing(folder, false)
    }
    st = await statOrNull(fs, path, folder)
    if (st === null) throw missing(folder, false)
  }
  if (!st.isDirectory()) throw missing(folder, adopted)
  if (appCanWrite(st)) return
  if (make) {
    // Only a folder the agent owns the layout of is handed over; an adopted one never.
    try {
      await fs.chown(path, APP_UID, APP_GID)
      const after = await statOrNull(fs, path, folder)
      if (after?.isDirectory() && appCanWrite(after)) return
    } catch {
      // No CAP_CHOWN, or root squash: the operator fixes it on the file server.
    }
  }
  throw notWritable(folder)
}

/**
 * Makes sure the stack's uploads folder (and its files sub-folder) is there and uid 1000 can
 * write it. A plan without a folder (no NFS export) needs nothing.
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
  const base = join(exportMount, plan.folder)
  await ensureOne(fs, base, plan.folder, !plan.adopted, plan.adopted)
  if (filesSubfolder !== undefined) {
    const sub = `${plan.folder}/${filesSubfolder}`
    await ensureOne(fs, join(base, filesSubfolder), sub, !plan.adopted, plan.adopted)
  }
}
