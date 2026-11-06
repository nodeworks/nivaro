import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Army 5 b10 (2026-11-06): an access-pending socket (auth:ok access_pending:true)
// received the tenant-wide presence:changed stream with other people's ids,
// because self-hosted it went out with io.emit to EVERY socket.

const io = vi.hoisted(() => ({
  sent: [] as Array<{ to: string | null; event: string }>
}))
vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../db/owner-signal.js', () => ({ onOwnersChanged: () => {} }))
vi.mock('../../../services/realtime.js', () => ({ broadcastCollectionUpdate: () => {} }))
vi.mock('../../../services/request-trace.js', () => ({ noteRealtimeEmit: () => {} }))
vi.mock('../../../services/io-holder.js', () => ({
  getIo: () => ({
    emit: (event: string) => io.sent.push({ to: null, event }),
    to: (room: string) => ({ emit: (event: string) => io.sent.push({ to: room, event }) })
  })
}))

import { emitToSignedIn, emitToTenant, TENANT_ALL_ROOM } from '../../../services/record-events.js'

afterEach(() => {
  io.sent = []
  vi.unstubAllEnvs()
})

describe('emitToSignedIn', () => {
  it('self-hosted: only the signed-in room, never io.emit', () => {
    vi.stubEnv('CLOUD_META_DB_URL', '')
    emitToSignedIn('', 'presence:changed', { user_id: '7' })
    expect(io.sent).toEqual([{ to: TENANT_ALL_ROOM, event: 'presence:changed' }])
    // emitToTenant (payload-free notices) keeps its old reach.
    emitToTenant('', 'config:update', {})
    expect(io.sent[1]).toEqual({ to: null, event: 'config:update' })
  })

  it("cloud: the tenant's all room; no tenant = nowhere", () => {
    vi.stubEnv('CLOUD_META_DB_URL', 'postgres://meta')
    emitToSignedIn('T-A', 'presence:changed', {})
    emitToSignedIn('', 'presence:changed', {})
    expect(io.sent).toHaveLength(1)
    expect(io.sent[0].to).toMatch(/T-A/)
    expect(io.sent[0].to).toMatch(/all$/)
  })
})

describe('the socket server (source guard)', () => {
  const src = readFileSync(new URL('../../../plugins/socketio.ts', import.meta.url), 'utf8')
  it('sends presence:changed to signed-in sockets only', () => {
    expect(src).toMatch(/emitToSignedIn\(tenant, 'presence:changed'/)
    expect(src).not.toMatch(/emitToTenant\(tenant, 'presence:changed'/)
  })
  it('joins the signed-in room self-hosted, and only after the pending branch returned', () => {
    const join = src.indexOf('const joinTenantAllRoom = async')
    expect(src.slice(join, join + 300)).toMatch(/socket\.join\(TENANT_ALL_ROOM\)/)
    const signIn = src.slice(src.indexOf('const signIn = (user: User'))
    const pendingReturn = signIn.indexOf('access_pending: true })\n        return')
    const joinCall = signIn.indexOf('void joinTenantAllRoom()')
    expect(pendingReturn).toBeGreaterThan(0)
    expect(joinCall).toBeGreaterThan(pendingReturn)
  })
})
