// Live "data changed since run" chip: every custom query (cached or not) names the registered
// collections it reads, inferred once per definition.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const counts = { registry: 0, procText: 0 }
vi.mock('../../../db/index.js', () => ({
  db: Object.assign(
    (table: string) => ({
      select: async () => {
        if (table === 'nivaro_collections') {
          counts.registry++
          return [{ collection: 'Invoices' }, { collection: 'projects' }]
        }
        return []
      }
    }),
    {
      raw: async () => {
        counts.procText++
        return [{ definition: 'SELECT * FROM projects p JOIN zz_scratch z ON 1=1' }]
      }
    }
  )
}))

import {
  __resetLiveSources,
  definitionHash,
  liveReadSources
} from '../../../services/query-freshness.js'

beforeEach(() => {
  __resetLiveSources()
  counts.registry = 0
  counts.procText = 0
})

describe('liveReadSources', () => {
  it('maps the query tables to registered collections (case-insensitive), nothing else', async () => {
    const s = await liveReadSources({
      id: 1,
      sql_text: 'SELECT * FROM dbo.invoices i JOIN not_a_collection n ON 1=1'
    })
    expect(s.map((x) => x.table)).toEqual(['Invoices'])
  })

  it('reads one level into an EXEC procedure; scratch tables stay out', async () => {
    const s = await liveReadSources({ id: 2, sql_text: 'EXEC rpt_spend' })
    expect(s.map((x) => x.table)).toEqual(['projects'])
  })

  it('declared sources win over inference', async () => {
    const s = await liveReadSources({
      id: 3,
      sql_text: 'SELECT * FROM invoices',
      freshness_sources: JSON.stringify([{ table: 'projects', column: 'changed' }])
    })
    expect(s.map((x) => x.table)).toEqual(['projects'])
  })

  it('infers once per definition: a second run never re-reads procedure text', async () => {
    const q = { id: 4, sql_text: 'EXEC rpt_spend' }
    await liveReadSources(q)
    await liveReadSources(q)
    await liveReadSources(q)
    expect(counts.procText).toBe(1)
  })

  it('an edited definition re-infers', async () => {
    await liveReadSources({ id: 5, sql_text: 'EXEC rpt_spend' })
    await liveReadSources({ id: 5, sql_text: 'EXEC rpt_spend -- v2' })
    expect(counts.procText).toBe(2)
    expect(definitionHash({ sql_text: 'a' })).not.toBe(definitionHash({ sql_text: 'b' }))
  })

  it('a query that reads no registered collection gives none (no chip)', async () => {
    expect(await liveReadSources({ id: 6, sql_text: 'SELECT 1' })).toEqual([])
  })
})
