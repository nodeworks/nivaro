import { describe, expect, it, vi } from 'vitest'

// R6-M-5 (ruling P6-33): the shared-stack router's converge wait ends with the route step's own
// deadline (R2-M-8), and keeps its 30-minute cap without one. A small fake: the deployment's
// recorded run, driver, token, secrets and tenants; the renderer and the agent.

vi.mock('../../../db/index.js', () => {
  const rows = [
    { plan: JSON.stringify({ image: `nodeworks/nivaro@sha256:${'a'.repeat(64)}`, extensions: {} }) }
  ]
  const chain = {
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    select: async () => rows
  }
  return { db: () => chain }
})
vi.mock('../../../services/deployment-mode.js', () => ({
  hubPublicOrigin: () => 'https://hub.example.com'
}))
vi.mock('../../../services/hub/drivers.js', () => ({
  getDriver: async () => ({ id: 1, kind: 'docker', name: 'Docker east', config: {} })
}))
vi.mock('../../../services/hub/shared/store.js', () => ({ openSharedToken: async () => 't' }))
vi.mock('../../../services/hub/shared/tenants.js', () => ({ tenantsOf: async () => [] }))
vi.mock('../../../services/hub/shared/upgrade-run.js', () => ({
  ensureSharedSecrets: async () => ({})
}))
const rendered = vi.hoisted(() => ({ roles: [] as unknown[] }))
vi.mock('../../../services/hub/shared/stack-render.js', () => ({
  SharedRenderError: class extends Error {},
  renderSharedSpec: (o: { explicitHosts: string[]; roles?: unknown }) => {
    rendered.roles.push(o.roles)
    return { hostnames: o.explicitHosts }
  }
}))
// Ruling I2 (Task 14): the stack runs one `all` service ×2 (recorded before the split).
const RUNNING = [{ role: 'all', replicas: 2, cpus: 2, memory_mb: 4096 }]
vi.mock('../../../services/hub/shared/upgrade-plan.js', () => ({
  deployedSharedRoles: async () => ({ never: false, roles: RUNNING })
}))

const { sharedStackRouter } = await import('../../../services/hub/move/shared-route.js')

const shared = {
  id: 7,
  key: 'pool-a',
  mode: 'docker',
  stack: 'pool-a',
  driver_id: 1,
  version_pin: '0.3.210',
  extension_pins: {}
} as never

function world() {
  let t = Date.parse('2026-11-22T10:00:00Z')
  const router = sharedStackRouter({
    now: () => t,
    sleep: async (ms) => {
      t += ms
    },
    agent: {
      agentHealth: (async () => ({ edge: 'traefik' })) as never,
      agentApply: (async () => ({ spec_hash: 'b'.repeat(64) })) as never,
      // swarm never converges
      agentStack: (async () => ({ state: 'updating' })) as never
    }
  })
  return { router, now: () => t }
}

describe('sharedStackRouter deadline (R2-M-8 / R6-M-5)', () => {
  it('stops at the route deadline with ROUTE_TIMEOUT, not after 30 minutes', async () => {
    const w = world()
    const start = w.now()
    const err = await w
      .router(shared, {
        op: 'add_host',
        host: 'shop.example.com',
        moveId: 9,
        deadline: start + 10 * 60_000
      })
      .catch((e) => e)
    expect(err?.code).toBe('ROUTE_TIMEOUT')
    expect(w.now() - start).toBeLessThan(11 * 60_000)
  })

  it('without a deadline it keeps the 30-minute cap (STACK_DEPLOY_TIMEOUT)', async () => {
    const w = world()
    const start = w.now()
    const err = await w
      .router(shared, { op: 'add_host', host: 'shop.example.com', moveId: 9 })
      .catch((e) => e)
    expect(err?.code).toBe('STACK_DEPLOY_TIMEOUT')
    expect(w.now() - start).toBeGreaterThanOrEqual(30 * 60_000)
  })

  it('Task 14 ruling I2: a name change renders the roles the stack runs, never a new shape', async () => {
    rendered.roles.length = 0
    const w = world()
    await w
      .router(shared, { op: 'add_host', host: 'shop.example.com', moveId: 9, deadline: w.now() })
      .catch(() => undefined)
    expect(rendered.roles).toEqual([RUNNING])
  })
})
