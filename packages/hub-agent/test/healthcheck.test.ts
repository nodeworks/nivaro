import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { healthTarget, probe } from '../src/healthcheck.js'

describe('healthcheck', () => {
  it('connects to the loopback twin of a wildcard bind', () => {
    expect(healthTarget({})).toEqual({ host: '127.0.0.1', port: 7480 })
    expect(healthTarget({ HUB_AGENT_LISTEN: '0.0.0.0:9000' })).toEqual({
      host: '127.0.0.1',
      port: 9000
    })
    expect(healthTarget({ HUB_AGENT_LISTEN: '[::]:9000' })).toEqual({ host: '::1', port: 9000 })
    expect(healthTarget({ HUB_AGENT_LISTEN: '10.0.0.5:9000' })).toEqual({
      host: '10.0.0.5',
      port: 9000
    })
  })

  it('is true for an open port and false for a closed one', async () => {
    const server = net.createServer((s) => s.destroy())
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    expect(await probe({ host: '127.0.0.1', port })).toBe(true)
    await new Promise<void>((r) => server.close(() => r()))
    expect(await probe({ host: '127.0.0.1', port })).toBe(false)
  })
})
