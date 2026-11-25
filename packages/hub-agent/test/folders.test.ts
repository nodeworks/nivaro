import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StackError } from '../src/errors.js'
import { defaultFolderFs, ensureUploadsFolder, MARKER, markerText } from '../src/folders.js'
import { uploadsVolumePlan } from '../src/volumes.js'

// The real file system under the agent's checks (security review 2026-11-24): links are refused
// by the kernel (O_NOFOLLOW), not only by the agent's own lstat walk.

const NFS = { type: 'nfs', o: 'addr=nas', device: ':/export' }
const cfg = { volumeDriver: 'local', volumeOpts: NFS }
const ctx = { clusterId: 'c1', stack: 's' }

let root: string
let other: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hub-agent-export-'))
  other = mkdtempSync(join(tmpdir(), 'hub-agent-elsewhere-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(other, { recursive: true, force: true })
})

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    if (err instanceof StackError) return err.code
    throw err
  }
  return 'NO_ERROR'
}

describe('ensureUploadsFolder on a real file system', () => {
  it('creates <stack> 0755 with its marker and <stack>/uploads (handed over or refused)', async () => {
    const r = await codeOf(
      ensureUploadsFolder(root, uploadsVolumePlan('s', {}, cfg), undefined, ctx)
    )
    // A test run is not uid 1000 and has no CAP_CHOWN: the hand-over is refused, never faked.
    const me = process.getuid?.() ?? -1
    expect(me === 1000 ? r === 'NO_ERROR' : r === 'UPLOADS_FOLDER_NOT_WRITABLE').toBe(true)
    expect(lstatSync(join(root, 's')).mode & 0o777).toBe(0o755)
    expect(lstatSync(join(root, 's/uploads')).isDirectory()).toBe(true)
    expect(readFileSync(join(root, 's', MARKER), 'utf8')).toBe(markerText('c1', 's'))
  })

  it('a real symlink at <stack> is refused and nothing is made through it', async () => {
    symlinkSync(other, join(root, 's'))
    expect(
      await codeOf(ensureUploadsFolder(root, uploadsVolumePlan('s', {}, cfg), undefined, ctx))
    ).toBe('UPLOADS_FOLDER_LINK')
    expect(() => lstatSync(join(other, 'uploads'))).toThrow()
    expect(() => lstatSync(join(other, MARKER))).toThrow()
  })

  it('the kernel refuses to open a link as a folder, and to write a marker through one', async () => {
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'link'))
    await expect(defaultFolderFs.openDir(join(root, 'link'))).rejects.toMatchObject({
      code: expect.stringMatching(/ELOOP|ENOTDIR/)
    })
    symlinkSync(join(other, 'target'), join(root, 'marker-link'))
    await expect(defaultFolderFs.writeMarker(join(root, 'marker-link'), 'x')).rejects.toBeTruthy()
    expect(() => lstatSync(join(other, 'target'))).toThrow()
  })

  it('an existing <stack> without the marker is not used', async () => {
    mkdirSync(join(root, 's'), { mode: 0o755 })
    expect(
      await codeOf(ensureUploadsFolder(root, uploadsVolumePlan('s', {}, cfg), undefined, ctx))
    ).toBe('UPLOADS_FOLDER_NOT_OURS')
  })
})
