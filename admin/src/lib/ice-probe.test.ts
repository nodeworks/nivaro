import { describe, expect, it } from 'vitest'
import { summarizeCandidates } from './ice-probe'

describe('summarizeCandidates', () => {
  it('reports the first relay and server-reflexive addresses', () => {
    const r = summarizeCandidates(
      [
        { type: 'host', address: '10.30.1.2', port: 50000 },
        { type: 'srflx', address: '10.30.1.2', port: 50001 },
        { type: 'relay', address: '10.163.156.157', port: 49160 },
        { type: 'relay', address: '10.163.156.157', port: 49161 }
      ],
      420
    )
    expect(r).toEqual({
      relay: '10.163.156.157:49160',
      srflx: '10.30.1.2:50001',
      hostOnly: false,
      ms: 420,
      error: null
    })
  })

  it('flags a probe that only found local addresses', () => {
    const r = summarizeCandidates([{ type: 'host', address: '192.168.1.4', port: 1 }], 8000)
    expect(r.relay).toBeNull()
    expect(r.srflx).toBeNull()
    expect(r.hostOnly).toBe(true)
  })

  it('keeps an error', () => {
    expect(summarizeCandidates([], 0, 'no WebRTC').error).toBe('no WebRTC')
  })
})
