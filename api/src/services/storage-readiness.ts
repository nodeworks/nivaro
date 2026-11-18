import { randomBytes } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ReadinessResult } from '@nivaro/extension-kit'
import { config } from '../config.js'
import { registerReadinessCheck } from './readiness.js'
import { getStorageProviderName } from './storage/index.js'

/**
 * Readiness check `upload-storage`: can this process write to local file storage?
 *
 * 2026-11-18 prod: after a host patch reboot the NFS upload share refused writes for two hours
 * and nothing said so until people's uploads failed. The check writes and deletes one small probe
 * file under STORAGE_LOCAL_ROOT — the only honest test on NFS, where mode bits and access(W_OK)
 * can say yes while the server says no. Cloud and object storage (s3 / azure) pass: there is no
 * local folder to judge.
 */
export async function judgeUploadStorage(deps: {
  provider: string
  root: string
  write: (path: string, data: string) => Promise<void>
  remove: (path: string) => Promise<void>
}): Promise<ReadinessResult> {
  if (deps.provider !== 'local')
    return {
      status: 'pass',
      detail: `Files are kept in ${deps.provider} storage, not on a local folder.`
    }
  const probe = join(deps.root, `.nivaro-write-probe-${randomBytes(6).toString('hex')}`)
  try {
    await deps.write(probe, 'ok')
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'error'
    return {
      status: 'fail',
      detail: `Uploads cannot be saved: writing to ${deps.root} failed (${code}).`,
      blockers: [
        `Check the upload folder is mounted and writable by the app's user (${code}). On NFS, check the share after a host reboot.`
      ]
    }
  }
  await deps.remove(probe).catch(() => null)
  return { status: 'pass', detail: `Uploads can be saved to ${deps.root}.` }
}

let registered = false

export function registerStorageReadinessCheck(): void {
  if (registered) return
  registered = true
  registerReadinessCheck({
    id: 'upload-storage',
    label: 'Uploads can be saved',
    group: 'Deploy',
    description:
      'Writes and deletes one small probe file in the local upload folder (STORAGE_LOCAL_ROOT). Fails when the folder cannot be written — a missing mount, or an NFS share that refuses writes after a host reboot. Passes for s3 / azure storage.',
    run: () =>
      judgeUploadStorage({
        provider: getStorageProviderName(),
        root: resolve(config.STORAGE_LOCAL_ROOT),
        write: (p, d) => writeFile(p, d),
        remove: (p) => unlink(p)
      })
  })
}
