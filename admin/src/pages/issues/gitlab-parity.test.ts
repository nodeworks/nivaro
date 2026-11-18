import path from 'node:path'
import { OP_WORDS } from '@nivaro/shared'
import { describe, expect, it } from 'vitest'
import { OP_LABELS } from '../issue-trackers/api'
import { connectionLabelsFor } from './gitlab'

// The create form shows the labels the connection adds as fixed (connectionLabelsFor); the
// server adds them from labels.ts labelsFor + mappedLabelsFor. One evaluator, two sides: this
// runs both on the same cases so they cannot drift. Loaded by path (vitest only) so the admin
// type check never follows it into api/.
const serverPath = path.join(import.meta.dirname, '../../../../api/src/services/trackers/labels.ts')
type ServerLabels = {
  labelsFor: (i: { severity: string; source: string }, o: unknown) => string[]
  mappedLabelsFor: (i: { severity: string; status: string }, s: unknown) => string[]
  mergeLabels: (...l: Array<string[] | undefined>) => string[]
}
const server = (await import(/* @vite-ignore */ serverPath)) as ServerLabels

const SYNC = {
  labels: {
    always: ['nivaro', 'Bug'],
    by_severity: {
      low: ['sev::4'],
      medium: ['sev::3'],
      high: ['bug', 'sev::2'],
      critical: ['sev::1']
    },
    by_source: { server: ['backend'], crash: ['crash'] },
    on_example: ['more-examples']
  },
  priority_map: { low: 'p::low', medium: 'p::med', high: 'p::high', critical: 'p::crit' },
  lane_map: { open: 'lane::todo', in_progress: 'lane::doing', resolved: 'lane::done' }
}

const CASES = [
  { severity: 'high', status: 'open', source: 'server' },
  { severity: 'error', status: 'in_progress', source: 'Server' },
  { severity: ' Critical ', status: 'resolved', source: 'crash' },
  { severity: 'info', status: 'closed', source: 'browser' },
  { severity: 'warning', status: 'open', source: '' },
  { severity: 'nonsense', status: 'open', source: 'server' },
  { severity: 'toString', status: 'constructor', source: '__proto__' }
]

describe('label twin: connectionLabelsFor (admin) = labelsFor + mappedLabelsFor (server)', () => {
  for (const c of CASES)
    it(`${JSON.stringify(c)}`, () => {
      const serverSide = server.mergeLabels(
        server.labelsFor({ severity: c.severity, source: c.source }, SYNC.labels),
        server.mappedLabelsFor({ severity: c.severity, status: c.status }, SYNC)
      )
      expect(connectionLabelsFor(c, SYNC)).toEqual(serverSide)
    })

  it('no settings: nothing on either side', () => {
    const c = CASES[0]
    expect(connectionLabelsFor(c, undefined)).toEqual(
      server.mergeLabels(server.labelsFor(c, undefined), server.mappedLabelsFor(c, undefined))
    )
  })
})

describe('outbox op words', () => {
  it('every op the admin outbox names has words on the shared panel too', () => {
    for (const op of Object.keys(OP_LABELS)) expect(OP_WORDS[op], op).toBeTruthy()
  })
})
