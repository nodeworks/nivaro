import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6 Task 9 fix round 2 (re-review Minor B): a publish-only process (no cron
// ticks, no VIDEO_RENDER=on) renders only its own publishes. Retire parks them instead of
// dropping them, and un-retire resumes them, so they render without a new publish.

const st = vi.hoisted(() => ({
  slots: [] as string[],
  updates: [] as Array<Record<string, unknown>>
}))

vi.mock('../../../services/ffmpeg.js', async (orig) => ({
  ...(await orig<object>()),
  hasFfmpeg: async () => true
}))
vi.mock('../../../services/io-holder.js', () => ({
  getApp: () => ({
    log: { warn: () => {}, info: () => {} },
    cron: {
      withHeavySlot: async (name: string) => {
        st.slots.push(name)
      }
    }
  }),
  getIo: () => null
}))
vi.mock('../../../db/index.js', () => {
  const chain: Record<string, unknown> = {}
  chain.where = () => chain
  chain.orderBy = () => chain
  chain.first = async () => undefined
  chain.update = async (patch: Record<string, unknown>) => {
    st.updates.push(patch)
    return 1
  }
  const db = () => chain
  return { db, _backgroundDb: null, _staticDb: null, resolveDb: () => db }
})

const render = await import('../../../services/help-video-render.js')
const retire = await import('../../../services/hub-link/retire.js')

const saved = { ...process.env }
beforeEach(() => {
  st.slots = []
  st.updates = []
  retire._resetRetiredForTests('no')
  process.env.CRON_TICKS = 'off'
  delete process.env.VIDEO_RENDER
  delete process.env.NIVARO_ROLE
  delete process.env.NIVARO_IMAGE_VARIANT
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_DEPLOYMENT
})
afterEach(() => {
  retire._resetRetiredForTests('no')
  process.env = { ...saved }
})

describe('help-video renders across a retire', () => {
  it('a publish made while retired is parked, then rendered once the app is back', async () => {
    retire._resetRetiredForTests('yes')
    await render.queueRender('V-1')
    await render.whenRendererIdle()
    expect(st.slots).toEqual([])

    retire._resetRetiredForTests('no')
    render.resumeRendersAfterRetire()
    await render.whenRendererIdle()
    expect(st.slots).toEqual(['help-video render'])

    // Nothing parked any more: a second resume renders nothing new.
    render.resumeRendersAfterRetire()
    await render.whenRendererIdle()
    expect(st.slots).toEqual(['help-video render'])
  })
})
