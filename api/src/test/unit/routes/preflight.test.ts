import { describe, expect, it } from 'vitest'
import { diffMigrations, judgeRender } from '../../../routes/preflight.js'

/**
 * The fail case here is the one that took a staging deploy down twice: the ledger
 * naming a migration the running build does not contain. It cannot be exercised
 * against a real database without inflicting that exact outage on it (knex
 * refuses to boot in that state), so it is pinned here instead.
 */
describe('diffMigrations', () => {
  const files = ['001_a.ts', '002_b.ts', '003_c.ts']

  it('reports ok when the ledger and the build agree', () => {
    const check = diffMigrations(files, ['001_a.ts', '002_b.ts', '003_c.ts'])
    expect(check.status).toBe('ok')
    expect(check.detail?.applied_count).toBe(3)
  })

  it('fails when the database is ahead of the build', () => {
    const check = diffMigrations(files, [...files, '004_shipped_later.ts'])
    expect(check.status).toBe('fail')
    expect(check.detail?.missing_files).toEqual(['004_shipped_later.ts'])
    expect(check.summary).toMatch(/will not survive a restart/)
  })

  it('warns — never fails — when the build is ahead of the database', () => {
    // Migrations run at boot, but MIGRATION_SAFE_MODE makes replicas wait on an
    // advisory lock, so a replica answering mid-window is not itself broken.
    const check = diffMigrations(files, ['001_a.ts'])
    expect(check.status).toBe('warn')
    expect(check.detail?.pending).toEqual(['002_b.ts', '003_c.ts'])
  })

  it('prefers the fail when the deploy is inconsistent in both directions', () => {
    const check = diffMigrations(files, ['001_a.ts', '099_gone.ts'])
    expect(check.status).toBe('fail')
    expect(check.detail?.missing_files).toEqual(['099_gone.ts'])
    // The pending list still rides along so one call shows the whole picture.
    expect(check.detail?.pending).toEqual(['002_b.ts', '003_c.ts'])
  })

  it('treats a fresh database as pending, not corrupt', () => {
    const check = diffMigrations(files, [])
    expect(check.status).toBe('warn')
    expect(check.detail?.pending).toEqual(files)
  })

  it('is order-independent — the ledger is not sorted by name', () => {
    const check = diffMigrations(files, ['003_c.ts', '001_a.ts', '002_b.ts'])
    expect(check.status).toBe('ok')
  })
})

// Slim parity: the slim image with nowhere to send PDFs and video work is a
// config error a deploy gate must stop (503 from /api/preflight), not a warn.
describe('judgeRender', () => {
  const none = { chromium: false, ffmpeg: false }
  const up = { configured: true, ok: true, url: 'http://w', chromium: true, ffmpeg: true, ms: 3 }

  it('passes with the binaries here, or a render server that has them', () => {
    expect(
      judgeRender(
        { chromium: true, ffmpeg: true },
        { configured: false, ok: false, url: null },
        'full'
      ).status
    ).toBe('ok')
    expect(judgeRender(none, up, 'slim').status).toBe('ok')
  })

  it('FAILS on the slim image without RENDER_URL; only warns on a dev box', () => {
    const unset = { configured: false, ok: false, url: null }
    expect(judgeRender(none, unset, 'slim').status).toBe('fail')
    expect(judgeRender(none, unset, null).status).toBe('warn')
  })

  it('fails when the render server is needed and does not answer or lacks a binary', () => {
    expect(judgeRender(none, { ...up, ok: false, error: 'ECONNREFUSED' }, 'slim').status).toBe(
      'fail'
    )
    expect(judgeRender(none, { ...up, chromium: false }, 'slim').status).toBe('fail')
  })
})
