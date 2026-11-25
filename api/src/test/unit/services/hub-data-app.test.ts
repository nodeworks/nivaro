import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { _setAppCallFetchForTests, bearerCall } from '../../../services/hub/data/app-calls.js'
import {
  _resetFilesBackupForTests,
  copyAll,
  deleteFilesBackupSet,
  dirAllowed,
  filesBackupDeps,
  type Run,
  writerFor
} from '../../../services/hub-data-app/files-backup.js'

// Hub data care, APP side: the files backup the app runs on the Hub's request, and the Hub's
// bearer call to the app. The folder rule is the app's own (HUB_FILES_BACKUP_DIRS): the Hub can
// never make an app write outside a folder its operator allowed.

let root: string
const env = () => ({ HUB_FILES_BACKUP_DIRS: `${root}, relative/ignored` }) as NodeJS.ProcessEnv

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'hub-files-backup-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  _setAppCallFetchForTests(null)
})
beforeEach(() => _resetFilesBackupForTests())

describe('files backup target rules', () => {
  it('allows only folders under HUB_FILES_BACKUP_DIRS', () => {
    expect(dirAllowed(join(root, 'hub'), env())).toBe(true)
    expect(dirAllowed('/etc', env())).toBe(false)
    expect(dirAllowed(join(root, '..', 'elsewhere'), env())).toBe(false)
    expect(() => writerFor({ set: 's1', target: { kind: 'dir', path: '/etc' } }, env())).toThrow(
      /does not allow/
    )
    expect(() =>
      writerFor({ set: 'BAD SET', target: { kind: 'dir', path: root } }, env())
    ).toThrow()
    expect(() => writerFor({ set: 's1', target: { kind: 's3', bucket: 'b' } }, env())).toThrow(
      /key pair/
    )
  })

  it('copies every stored file under the set, writes a manifest, and deletes the set', async () => {
    const rows = [
      { id: 'a', filename_disk: 'one.txt', storage: 'local', filesize: 3 },
      { id: 'b', filename_disk: 'sub/two.txt', storage: 'local', filesize: 3 },
      { id: 'c', filename_disk: 'big.bin', storage: 'local', filesize: 5 * 1024 * 1024 * 1024 },
      { id: 'd', filename_disk: 'gone.txt', storage: 's3', filesize: 1 },
      { id: 'e', filename_disk: 'streamed.bin', storage: 'local', filesize: 3 * 1024 * 1024 }
    ]
    const saved = { ...filesBackupDeps }
    filesBackupDeps.listRows = async (after) => (after === null ? rows : [])
    // Objects are streamed: a source with no stream (big.bin) is read whole only when small.
    filesBackupDeps.open = async (_s, key) => {
      if (key === 'gone.txt') throw new Error('missing')
      if (key === 'big.bin') return null
      if (key === 'streamed.bin')
        return Readable.from(
          (function* () {
            for (let i = 0; i < 3; i++) yield Buffer.alloc(1024 * 1024, i)
          })()
        )
      return Readable.from([Buffer.from(key.slice(0, 3))])
    }
    filesBackupDeps.read = async () => {
      throw new Error('a whole read was not expected')
    }
    try {
      const { writer } = writerFor(
        { set: 'nivaro-efp-staging-1', target: { kind: 'dir', path: root } },
        env()
      )
      const run: Run = {
        id: 'r1',
        status: {
          state: 'running',
          total: 0,
          copied: 0,
          failed: 0,
          too_large: 0,
          bytes: 0,
          error: null
        }
      }
      await copyAll(run, writer)
      expect(run.status).toMatchObject({
        state: 'done',
        total: 5,
        copied: 3,
        failed: 1,
        too_large: 1
      })
      const setDir = join(root, 'nivaro-efp-staging-1')
      expect(await readFile(join(setDir, 'sub', 'two.txt'), 'utf8')).toBe('sub')
      const manifest = JSON.parse(await readFile(join(setDir, 'manifest.json'), 'utf8'))
      expect(manifest.files.map((f: { key: string }) => f.key).sort()).toEqual([
        'one.txt',
        'streamed.bin',
        'sub/two.txt'
      ])
      expect((await stat(join(setDir, 'streamed.bin'))).size).toBe(3 * 1024 * 1024)
      const prev = process.env.HUB_FILES_BACKUP_DIRS
      process.env.HUB_FILES_BACKUP_DIRS = root
      try {
        const del = await deleteFilesBackupSet({
          set: 'nivaro-efp-staging-1',
          target: { kind: 'dir', path: root }
        })
        expect(del.deleted).toBe(3)
      } finally {
        if (prev === undefined) delete process.env.HUB_FILES_BACKUP_DIRS
        else process.env.HUB_FILES_BACKUP_DIRS = prev
      }
      await expect(stat(setDir)).rejects.toThrow()
    } finally {
      Object.assign(filesBackupDeps, saved)
    }
  })

  it('refuses a key that would leave the set folder', async () => {
    const { writer } = writerFor({ set: 's2', target: { kind: 'dir', path: root } }, env())
    await expect(writer.put('../escape.txt', Buffer.from('x'))).rejects.toThrow(/Bad storage key/)
  })
})

describe('the Hub’s bearer call to an app', () => {
  it('sends the bearer, refuses redirects and passes the app’s refusal code through', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    _setAppCallFetchForTests(async (url, init) => {
      seen.push({ url: String(url), init: init as RequestInit })
      if (String(url).endsWith('/missing')) return new Response('', { status: 404 })
      if (String(url).endsWith('/busy'))
        return new Response(JSON.stringify({ code: 'FILES_BACKUP_RUNNING' }), { status: 409 })
      return new Response(JSON.stringify({ run_id: 'x' }), { status: 202 })
    })
    expect(
      await bearerCall('https://app.test/api/hub-link/data/files-backup', 'tok', 'POST', { a: 1 })
    ).toEqual({
      run_id: 'x'
    })
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(seen[0].init.redirect).toBe('error')
    await expect(bearerCall('https://app.test/missing', 'tok', 'GET')).rejects.toMatchObject({
      reason: 'LINK_MISSING'
    })
    await expect(bearerCall('https://app.test/busy', 'tok', 'GET')).rejects.toMatchObject({
      reason: 'FILES_BACKUP_RUNNING',
      status: 409
    })
  })
})
