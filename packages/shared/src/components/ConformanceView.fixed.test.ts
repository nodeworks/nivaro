import { describe, expect, it } from 'vitest'
import { fixedConformanceFindings } from './ConformanceView'

type Client = Parameters<typeof fixedConformanceFindings>[0]

const refs = [
  { key: '1', collection: 'wf', itemId: 'a' },
  { key: '2', collection: 'wf', itemId: 'a' },
  { key: '3', collection: 'wf', itemId: 'b' },
  { key: '4', collection: 'wf', itemId: 'c' },
  { key: '5', collection: 'wf', itemId: 'd' }
]
const byKey = new Map([
  ['1', { field: 'title', rule: 'required' }],
  ['2', { field: 'status', rule: 'cascade' }],
  ['3', { field: 'title', rule: 'required' }],
  ['4', { field: 'title', rule: 'required' }],
  ['5', { field: 'title', rule: 'required' }]
])

describe('fixedConformanceFindings', () => {
  it('a finding is fixed when the live check no longer reports that field + rule', async () => {
    const answers: Record<string, unknown> = {
      a: { data: { enabled: true, findings: [{ field: 'status', rule: 'cascade' }] } }, // title fixed, status not
      b: { data: { enabled: true, findings: [] } },
      d: { data: { enabled: false } } // the collection switched its integrity check off: say nothing
    }
    const client = {
      request: async (cmd: { _path: string }) => {
        const id = decodeURIComponent(cmd._path.split('/').slice(-2)[0])
        if (id === 'c') throw Object.assign(new Error('nope'), { status: 404 })
        return answers[id]
      }
    } as unknown as Client
    const fixed = await fixedConformanceFindings(client, 'wf', refs, byKey)
    expect(fixed.sort()).toEqual(['1', '3', '4']) // 4: the record is gone
  })

  it('a check that fails for any other reason fixes nothing', async () => {
    const client = {
      request: async () => {
        throw Object.assign(new Error('boom'), { status: 500 })
      }
    } as unknown as Client
    expect(await fixedConformanceFindings(client, 'wf', refs, byKey)).toEqual([])
  })
})
