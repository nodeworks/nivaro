import { describe, expect, it } from 'vitest'
import {
  appCanWrite,
  deviceFor,
  folderOk,
  foldersOverlap,
  folderUnderExport,
  nfsExport,
  nfsUploadsName,
  redisConstraint,
  redisVolumeChanged,
  redisVolumeOf,
  uploadsVolumePlan,
  volumeAllowed
} from '../src/volumes.js'

const NFS = { type: 'nfs', o: 'addr=nas', device: ':/export/nivaro' }

describe('volumes (0.2.2)', () => {
  it('reads the export root only from NFS options with a device', () => {
    expect(nfsExport({ volumeOpts: NFS })).toBe(':/export/nivaro')
    expect(nfsExport({ volumeOpts: { ...NFS, type: 'NFS4' } })).toBe(':/export/nivaro')
    expect(nfsExport({ volumeOpts: { type: 'nfs', o: 'addr=nas' } })).toBeNull()
    expect(nfsExport({ volumeOpts: {} })).toBeNull()
    expect(nfsExport({ volumeOpts: null })).toBeNull()
  })

  it('folderOk: relative segments only', () => {
    for (const ok of ['a', 'efp', 'a/b', 'A1._-z/x', 'directus-uploads'])
      expect(folderOk(ok), ok).toBe(true)
    for (const bad of ['', '/', '/a', 'a/', '..', 'a/..', '.', './a', 'a//b', '.x', 'a b', 'ä'])
      expect(folderOk(bad), bad).toBe(false)
  })

  it('joins and splits devices under the export', () => {
    expect(deviceFor(':/export/nivaro', 'a/uploads')).toBe(':/export/nivaro/a/uploads')
    expect(deviceFor(':/export/nivaro/', 'a')).toBe(':/export/nivaro/a')
    expect(deviceFor(':/', 'a')).toBe(':/a')
    expect(folderUnderExport(':/export/nivaro', ':/export/nivaro/a/uploads')).toBe('a/uploads')
    expect(folderUnderExport(':/export/nivaro', ':/export/nivaro')).toBe('')
    expect(folderUnderExport(':/export/nivaro', ':/export/nivaro/')).toBe('')
    expect(folderUnderExport(':/export/nivaro', ':/export/nivaroX/a')).toBeNull()
    expect(folderUnderExport(':/export/nivaro', ':/export/nivaro/../etc')).toBeNull()
    expect(folderUnderExport(':/export/nivaro', 7)).toBeNull()
    expect(folderUnderExport(':/', ':/a/b')).toBe('a/b')
  })

  it('overlap: the same folder, or one inside the other', () => {
    expect(foldersOverlap('a', 'a')).toBe(true)
    expect(foldersOverlap('a', 'a/b')).toBe(true)
    expect(foldersOverlap('a/b', 'a')).toBe(true)
    expect(foldersOverlap('a', 'ab')).toBe(false)
    expect(foldersOverlap('a/b', 'a/c')).toBe(false)
  })

  it('the uploads plan: legacy name without an export, digest name per folder with one', () => {
    expect(uploadsVolumePlan('s', {}, { volumeDriver: 'local', volumeOpts: {} })).toEqual({
      name: 'nvh_s_uploads',
      driver: 'local',
      opts: {},
      folder: null,
      adopted: false
    })
    const own = uploadsVolumePlan('s', {}, { volumeDriver: 'local', volumeOpts: NFS })
    expect(own).toMatchObject({ folder: 's/uploads', adopted: false })
    expect(own.opts.device).toBe(':/export/nivaro/s/uploads')
    expect(own.name).toBe(nfsUploadsName('s', 'local', own.opts))
    const adopted = uploadsVolumePlan(
      's',
      { uploads_folder: 'efp' },
      { volumeDriver: 'local', volumeOpts: NFS }
    )
    expect(adopted).toMatchObject({ folder: 'efp', adopted: true })
    expect(adopted.name).not.toBe(own.name)
  })

  it('Redis: never NFS by default, pinned only by an operator node label', () => {
    expect(redisVolumeOf({ volumeDriver: 'local', volumeOpts: NFS })).toEqual({
      driver: 'local',
      opts: {}
    })
    expect(redisConstraint({ volumeDriver: 'local', volumeOpts: NFS })).toBeNull()
    expect(redisVolumeChanged({ volumeDriver: 'local', volumeOpts: NFS })).toBe(true)
    const plain = { volumeDriver: 'local', volumeOpts: {} }
    expect(redisConstraint(plain)).toBeNull()
    expect(redisVolumeChanged(plain)).toBe(false)
    expect(
      redisConstraint({ ...plain, redisPinLabel: { key: 'nivaro.redis', value: 'yes' } })
    ).toBe('node.labels.nivaro.redis==yes')
    expect(redisConstraint({ ...plain, redisPinLabel: { key: 'a b', value: 'x' } })).toBeNull()
  })

  it('L2: the guard takes only the folder the stack is bound to', () => {
    const cfgN = { volumeDriver: 'local', volumeOpts: NFS }
    const own = uploadsVolumePlan('s', {}, cfgN)
    expect(volumeAllowed(cfgN, 's', own.name, 'local', own.opts)).toBe(true)
    const other = uploadsVolumePlan('t', {}, cfgN)
    const otherUnderS = { ...other, name: nfsUploadsName('s', 'local', other.opts) }
    expect(volumeAllowed(cfgN, 's', otherUnderS.name, 'local', other.opts)).toBe(false)
    const adopted = uploadsVolumePlan('s', { uploads_folder: 'efp' }, cfgN)
    expect(volumeAllowed(cfgN, 's', adopted.name, 'local', adopted.opts)).toBe(false)
    expect(volumeAllowed(cfgN, 's', adopted.name, 'local', adopted.opts, 'efp')).toBe(true)
    expect(volumeAllowed(cfgN, 's', adopted.name, 'local', adopted.opts, 'other')).toBe(false)
  })

  it('appCanWrite judges uid 1000 by mode bits like the image entrypoint', () => {
    expect(appCanWrite({ uid: 1000, gid: 1000, mode: 0o755 })).toBe(true)
    expect(appCanWrite({ uid: 1000, gid: 1000, mode: 0o555 })).toBe(false)
    expect(appCanWrite({ uid: 0, gid: 1000, mode: 0o775 })).toBe(true)
    expect(appCanWrite({ uid: 0, gid: 1000, mode: 0o755 })).toBe(false)
    expect(appCanWrite({ uid: 0, gid: 0, mode: 0o777 })).toBe(true)
    expect(appCanWrite({ uid: 0, gid: 0, mode: 0o755 })).toBe(false)
  })
})
