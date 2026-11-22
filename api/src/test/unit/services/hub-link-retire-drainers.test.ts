import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6 Task 9 fix round 1: a retired process (moved away by the Hub) never drains
// work that lives in the database or Redis it shares with the app's new home — even where a
// switch turns the drainer on explicitly (VIDEO_RENDER=on, MEDIA_WORKER=on, IMPORT_WORKER=on,
// NIVARO_ROLE=importer/exporter). Each decision is read on every tick, not only at boot.

vi.mock('../../../services/io-holder.js', () => ({ getApp: () => null, getIo: () => null }))

const retire = await import('../../../services/hub-link/retire.js')
const { ownsRenderQueue } = await import('../../../services/help-video-render.js')
const { mediaWorkerEnabled } = await import('../../../services/media-handoff.js')
const { importDrainMode } = await import('../../../services/import-handoff.js')
const { exportDrainMode } = await import('../../../services/export-handoff.js')
const { cronTicksEnabled } = await import('../../../services/cron-ticks.js')

const saved = { ...process.env }
beforeEach(() => {
  retire._resetRetiredForTests('no')
  process.env.VIDEO_RENDER = 'on'
  process.env.MEDIA_WORKER = 'on'
  process.env.CRON_TICKS = 'on'
  delete process.env.NIVARO_ROLE
  delete process.env.NIVARO_IMAGE_VARIANT
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_DEPLOYMENT
})
afterEach(() => {
  retire._resetRetiredForTests('no')
  process.env = { ...saved }
})

describe('retired drainers', () => {
  it('render queue, media worker, imports, exports and crons all stop while retired', () => {
    const importer = { ...process.env, NIVARO_ROLE: 'importer' } as NodeJS.ProcessEnv
    const exporter = { ...process.env, NIVARO_ROLE: 'exporter', EXPORT_WORKER: 'on' } as never
    expect(ownsRenderQueue()).toBe(true)
    expect(mediaWorkerEnabled()).toBe(true)
    expect(importDrainMode(importer)).toBe('importer')
    expect(cronTicksEnabled()).toBe(true)
    const exportBefore = exportDrainMode(exporter)

    retire._resetRetiredForTests('yes')
    expect(ownsRenderQueue()).toBe(false)
    expect(mediaWorkerEnabled()).toBe(false)
    expect(importDrainMode(importer)).toBe('off')
    expect(exportDrainMode(exporter)).toBe('off')
    expect(cronTicksEnabled()).toBe(false)

    // Unknown (Redis never answered since boot) fails closed the same way.
    retire._resetRetiredForTests('unknown')
    expect(ownsRenderQueue()).toBe(false)
    expect(importDrainMode(importer)).toBe('off')

    retire._resetRetiredForTests('no')
    expect(exportDrainMode(exporter)).toBe(exportBefore)
  })
})
