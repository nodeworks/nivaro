import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { hubBootMoveId } from '../../../services/hub-boot-move.js'

// Review C1 (Hub placement): the new stack of a Hub move (HUB_BOOT_MAINTENANCE=<move id>) says so
// on /api/version as `move_target`, which a move between two stacks of one environment needs to
// tell the new stack from the old one; any other app says nothing.

const { healthRoutes } = await import('../../../routes/health.js')
const saved = process.env.HUB_BOOT_MAINTENANCE

afterEach(() => {
  if (saved === undefined) delete process.env.HUB_BOOT_MAINTENANCE
  else process.env.HUB_BOOT_MAINTENANCE = saved
})

async function version() {
  const app = Fastify()
  await app.register(healthRoutes, { prefix: '/api' })
  const r = await app.inject({ method: 'GET', url: '/api/version' })
  await app.close()
  expect(r.headers['cache-control']).toBe('no-store')
  return r.json() as Record<string, unknown>
}

describe('/api/version move_target', () => {
  it('names the move whose new stack answers', async () => {
    process.env.HUB_BOOT_MAINTENANCE = '42'
    expect((await version()).move_target).toBe(42)
  })

  it('says nothing without a move (or with a value that is not a move id)', async () => {
    delete process.env.HUB_BOOT_MAINTENANCE
    expect(await version()).not.toHaveProperty('move_target')
    process.env.HUB_BOOT_MAINTENANCE = 'yes'
    expect(await version()).not.toHaveProperty('move_target')
  })

  it('is never a stack setting (review 2 L4)', async () => {
    const { reservedSettingKey } = await import('../../../services/hub/docker/stack-env.js')
    expect(reservedSettingKey('HUB_BOOT_MAINTENANCE', 'bundled')).toBe(true)
  })

  it('parses only a positive whole move id', () => {
    expect(hubBootMoveId({ HUB_BOOT_MAINTENANCE: ' 7 ' } as never)).toBe(7)
    expect(hubBootMoveId({ HUB_BOOT_MAINTENANCE: '0' } as never)).toBeNull()
    expect(hubBootMoveId({} as never)).toBeNull()
  })
})
