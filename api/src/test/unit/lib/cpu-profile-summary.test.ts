import { describe, expect, it } from 'vitest'
import { frameSource, summarizeCpuProfile } from '../../../lib/cpu-profile-summary.js'

const frame = (functionName: string, url = '', lineNumber = 0) => ({
  functionName,
  url,
  lineNumber
})

describe('frameSource', () => {
  it('labels packages, app files and native frames', () => {
    expect(
      frameSource('file:///app/node_modules/.pnpm/knex@3.1.0/node_modules/knex/lib/q.js')
    ).toBe('pkg:knex')
    expect(frameSource('file:///app/node_modules/@fastify/compress/index.js')).toBe(
      'pkg:@fastify/compress'
    )
    expect(frameSource('file:///app/api/dist/services/sla.js')).toBe('dist/services/sla.js')
    expect(frameSource('node:events')).toBe('node:events')
    expect(frameSource('')).toBe('(native)')
  })
})

describe('summarizeCpuProfile', () => {
  // root → handler (ours) → knex (package); plus idle and gc samples.
  const profile = {
    nodes: [
      { id: 1, callFrame: frame('(root)'), children: [2, 4, 5] },
      { id: 2, callFrame: frame('handler', 'file:///app/api/dist/routes/x.js', 10), children: [3] },
      { id: 3, callFrame: frame('query', 'file:///app/node_modules/knex/lib/q.js', 5) },
      { id: 4, callFrame: frame('(idle)') },
      { id: 5, callFrame: frame('(garbage collector)') }
    ],
    samples: [3, 3, 2, 4, 4, 4, 4, 5, 3, 2],
    timeDeltas: new Array(10).fill(1000),
    startTime: 0,
    endTime: 10_000
  }

  it('splits busy, idle and gc time', () => {
    const s = summarizeCpuProfile(profile)
    expect(s.busy_ms).toBe(6)
    expect(s.idle_ms).toBe(4)
    expect(s.gc_ms).toBe(1)
  })

  it('ranks self time by function and inclusive time by file and by our functions', () => {
    const s = summarizeCpuProfile(profile)
    expect(s.self[0]).toEqual({ fn: 'query', where: 'pkg:knex', ms: 3 })
    expect(s.files.find((f) => f.where === 'dist/routes/x.js')?.ms).toBe(5)
    expect(s.files.find((f) => f.where === 'pkg:knex')?.ms).toBe(3)
    expect(s.ours).toEqual([{ fn: 'handler', where: 'dist/routes/x.js', ms: 5 }])
  })
})
