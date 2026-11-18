import { describe, expect, it, vi } from 'vitest'

vi.mock('../config.js', () => ({ config: { STORAGE_LOCAL_ROOT: '/app/uploads/directus-uploads' } }))

const { judgeUploadStorage } = await import('./storage-readiness.js')

describe('upload-storage readiness', () => {
  it('passes when a probe file can be written, and removes it', async () => {
    const remove = vi.fn(async (_p: string) => {})
    const r = await judgeUploadStorage({
      provider: 'local',
      root: '/u',
      write: async () => {},
      remove
    })
    expect(r.status).toBe('pass')
    expect(remove).toHaveBeenCalledTimes(1)
    expect(String(remove.mock.calls[0]?.[0])).toMatch(/^\/u\/\.nivaro-write-probe-/)
  })

  it('fails with the error code when the folder cannot be written', async () => {
    const r = await judgeUploadStorage({
      provider: 'local',
      root: '/u',
      write: async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      },
      remove: async () => {}
    })
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('EACCES')
    expect(r.blockers?.length).toBe(1)
  })

  it('passes object storage without touching a folder', async () => {
    const write = vi.fn(async () => {})
    const r = await judgeUploadStorage({
      provider: 's3',
      root: '/u',
      write,
      remove: async () => {}
    })
    expect(r.status).toBe('pass')
    expect(write).not.toHaveBeenCalled()
  })

  it('still passes when the probe cannot be removed afterwards', async () => {
    const r = await judgeUploadStorage({
      provider: 'local',
      root: '/u',
      write: async () => {},
      remove: async () => {
        throw new Error('EBUSY')
      }
    })
    expect(r.status).toBe('pass')
  })
})
