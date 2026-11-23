import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import { wsEntryMintedForTenant } from '../../../plugins/socketio.js'
import { encodeBoundToken } from '../../../services/socket-access.js'
import { currentTenantKey } from '../../../services/tenant-rooms.js'

// Hub phase 6 parked wave (T12): the socket `auth` handler's ws-token / View-as reader was a
// closure in plugins/socketio.ts, untested on the hub source. Its tenant rule is now
// wsEntryMintedForTenant: on a Hub shared deployment an entry signs a socket in only on the app it
// was minted in, and one that names no app is refused (P5-16). Nivaro Cloud keeps accepting an
// untagged entry; self-hosted accepts every entry.

const A = 'app-a-e1'
const B = 'app-b-e2'
const USER = '11111111-2222-4333-8444-555555555555'

const savedEnv = { ...process.env }
afterEach(() => {
  process.env = { ...savedEnv }
})

function hub() {
  delete process.env.CLOUD_META_DB_URL
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
  process.env.HUB_URL = 'https://hub.example'
  process.env.HUB_DEPLOYMENT_TOKEN = 't'.repeat(40)
}
function cloud() {
  delete process.env.HUB_SHARED_DEPLOYMENT
  process.env.CLOUD_META_DB_URL = 'postgres://meta@127.0.0.1:1/meta'
}

function inApp<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) =>
    runWithTenantDb(
      {} as never,
      id,
      () => void Promise.resolve().then(fn).then(resolve, reject),
      id
    )
  )
}

/** The socket's own tenant, as socketTenant resolves it from the host. */
const socketOn = (id: string | null) =>
  vi.fn(async () => (id ? { tenantId: id, slug: id.replace(/-e\d+$/, '') } : null))

describe('Hub shared deployment', () => {
  it('a token minted in A signs in on A, never on B', async () => {
    hub()
    const raw = await inApp(A, () =>
      encodeBoundToken(USER, { kind: 'session', sid: 's1' } as never, currentTenantKey())
    )
    expect(await wsEntryMintedForTenant(raw, true, socketOn(A))).toBe(true)
    expect(await wsEntryMintedForTenant(raw, true, socketOn(B))).toBe(false)
  })

  it('an entry that names no app is refused (its databases cannot tell apps apart)', async () => {
    hub()
    const tenant = socketOn(A)
    expect(await wsEntryMintedForTenant(JSON.stringify({ u: USER }), true, tenant)).toBe(false)
    expect(await wsEntryMintedForTenant(JSON.stringify({ t: '' }), true, tenant)).toBe(false)
    expect(await wsEntryMintedForTenant('not json', true, tenant)).toBe(false)
    // nothing named: the socket's tenant is never read
    expect(tenant).not.toHaveBeenCalled()
  })

  it('a socket whose host resolved to no ready app signs nothing in', async () => {
    hub()
    expect(await wsEntryMintedForTenant(JSON.stringify({ t: A }), true, socketOn(null))).toBe(false)
  })

  it('the View-as entry form (`tenant`) and the slug both count', async () => {
    hub()
    expect(await wsEntryMintedForTenant(JSON.stringify({ tenant: A }), true, socketOn(A))).toBe(
      true
    )
    expect(await wsEntryMintedForTenant(JSON.stringify({ t: 'app-a' }), true, socketOn(A))).toBe(
      true
    )
  })
})

describe('Nivaro Cloud (unchanged)', () => {
  it('an untagged or unreadable entry is accepted; one tagged for another tenant is not', async () => {
    cloud()
    expect(await wsEntryMintedForTenant(JSON.stringify({ u: USER }), true, socketOn(A))).toBe(true)
    expect(await wsEntryMintedForTenant('not json', true, socketOn(A))).toBe(true)
    expect(await wsEntryMintedForTenant(JSON.stringify({ t: B }), true, socketOn(A))).toBe(false)
    expect(await wsEntryMintedForTenant(JSON.stringify({ t: A }), true, socketOn(A))).toBe(true)
  })
})

describe('self-hosted', () => {
  it('every entry (one process, one app)', async () => {
    delete process.env.CLOUD_META_DB_URL
    delete process.env.HUB_SHARED_DEPLOYMENT
    const tenant = socketOn(null)
    expect(await wsEntryMintedForTenant(JSON.stringify({ t: B }), false, tenant)).toBe(true)
    expect(await wsEntryMintedForTenant('x', false, tenant)).toBe(true)
    expect(tenant).not.toHaveBeenCalled()
  })
})

describe('socketio.ts wiring', () => {
  it('the auth handler reads entries through wsEntryMintedForTenant with the socket tenant', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../../plugins/socketio.ts', import.meta.url), 'utf8')
    expect(src).toContain('wsEntryMintedForTenant(raw, cloud, () => socketTenant(socket))')
    expect(src.match(/mintedForThisTenant\(/g)?.length).toBe(2)
  })
})
