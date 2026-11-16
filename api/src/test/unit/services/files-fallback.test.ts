import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  existingFallback,
  fallbackPath,
  filesFallbackDir,
  readFallback
} from '../../../services/storage/fallback.js'

describe('FILES_FALLBACK_DIR — the source environment’s uploads, read-only', () => {
  const saved = { dir: process.env.FILES_FALLBACK_DIR, cloud: process.env.CLOUD_META_DB_URL }
  afterEach(() => {
    process.env.FILES_FALLBACK_DIR = saved.dir
    if (saved.dir === undefined) delete process.env.FILES_FALLBACK_DIR
    process.env.CLOUD_META_DB_URL = saved.cloud
    if (saved.cloud === undefined) delete process.env.CLOUD_META_DB_URL
  })

  it('is off when unset, relative, or in cloud mode', () => {
    expect(filesFallbackDir({})).toBeNull()
    expect(filesFallbackDir({ FILES_FALLBACK_DIR: 'uploads' })).toBeNull()
    expect(
      filesFallbackDir({ FILES_FALLBACK_DIR: '/srv/prod-uploads', CLOUD_META_DB_URL: 'x' })
    ).toBeNull()
    expect(filesFallbackDir({ FILES_FALLBACK_DIR: '/srv/prod-uploads' })).toBe('/srv/prod-uploads')
  })

  it('never resolves a key outside the folder', () => {
    const env = { FILES_FALLBACK_DIR: '/srv/prod-uploads' }
    expect(fallbackPath('ab/cd.pdf', env)).toBe('/srv/prod-uploads/ab/cd.pdf')
    expect(fallbackPath('../etc/passwd', env)).toBeNull()
    expect(fallbackPath('a/../../x', env)).toBeNull()
    expect(fallbackPath('/etc/passwd', env)).toBeNull()
    expect(fallbackPath('', env)).toBeNull()
    expect(fallbackPath('a\0b', env)).toBeNull()
  })

  it('reads a file the source has; folders and missing files are not files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nvr-fallback-'))
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'a.txt'), 'from production')
    process.env.FILES_FALLBACK_DIR = root
    delete process.env.CLOUD_META_DB_URL
    expect((await readFallback('sub/a.txt'))?.toString()).toBe('from production')
    expect(await existingFallback('sub')).toBeNull()
    expect(await readFallback('missing.txt')).toBeNull()
    expect((await existingFallback('sub/a.txt'))?.size).toBe(15)
  })
})
