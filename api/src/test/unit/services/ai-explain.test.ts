import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => null }))
vi.mock('../../../services/ai-client.js', () => ({
  getAiClient: vi.fn(async () => null),
  getAiModelSettings: vi.fn(async () => ({ model: 'm', summarizeModel: 'sum-model' }))
}))

import {
  capFacts,
  clearExplainCacheForTests,
  ExplainError,
  explainFacts,
  parseModelAnswer,
  redactForModel,
  scrubText,
  tablesOf
} from '../../../services/ai-explain.js'
import { isMonday } from '../../../services/ai-explain-weekly.js'
import { clusterByVectors, normalizeForGrouping } from '../../../services/issue-groups.js'

const facts = (extra: Record<string, unknown> = {}) => ({
  title: 'Subject',
  facts: { a: 1, ...extra },
  instructions: 'Explain.'
})

function stub(reply: string) {
  const create = vi.fn(async () => ({ content: [{ type: 'text', text: reply }] }))
  return { client: { messages: { create } }, create }
}

describe('redaction', () => {
  it('masks credential-looking keys and omits bodies', () => {
    const out = redactForModel({
      api_key: 'abc',
      nested: { Authorization: 'Bearer abcdefghijkl', ok: 'fine' },
      request_body: { customer: 'x', ssn: '1' },
      response_body: '<html>big</html>'
    }) as Record<string, any>
    expect(out.api_key).toBe('••••••')
    expect(out.nested.Authorization).toBe('••••••')
    expect(out.nested.ok).toBe('fine')
    expect(out.request_body).toMatch(/omitted/)
    expect(out.request_body).not.toMatch(/customer/)
    expect(out.response_body).toMatch(/omitted: 16 characters/)
  })

  it('scrubs tokens, query strings and secrets in free text', () => {
    const t = scrubText(
      'Authorization: Bearer abcdefghijklmnop then password=hunter2 at https://x.test/p?token=zzz'
    )
    expect(t).not.toMatch(/abcdefghijklmnop|hunter2|token=zzz/)
    expect(t).toMatch(/https:\/\/x\.test\/p\?…/)
  })

  it('caps size', () => {
    const big = capFacts({ rows: Array.from({ length: 500 }, (_, i) => 'x'.repeat(600) + i) })
    expect(big.length).toBeLessThan(15_000)
  })
})

describe('parseModelAnswer', () => {
  it('reads the JSON reply and trims numbering', () => {
    const a = parseModelAnswer(
      'Sure {"summary":"It broke.","steps":["1. Do a","2) Do b"],"retry_safe":"YES","caution":null}'
    )
    expect(a.summary).toBe('It broke.')
    expect(a.steps).toEqual(['Do a', 'Do b'])
    expect(a.retry_safe).toBe('yes')
  })
  it('falls back to the raw text', () => {
    expect(parseModelAnswer('just words').summary).toBe('just words')
  })
})

describe('explainFacts', () => {
  beforeEach(() => clearExplainCacheForTests())

  it('calls the model once and serves the repeat from cache', async () => {
    const { client, create } = stub(
      '{"summary":"Cause.","steps":["Fix it"],"retry_safe":null,"caution":null}'
    )
    const first = await explainFacts('issue', facts(), { client })
    const again = await explainFacts('issue', facts(), { client })
    expect(first.cached).toBe(false)
    expect(again.cached).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
    expect(first.summary).toBe('Cause.')
  })

  it('answers again when the facts change, or when fresh is asked for', async () => {
    const { client, create } = stub('{"summary":"S","steps":[]}')
    await explainFacts('issue', facts(), { client })
    await explainFacts('issue', facts({ b: 2 }), { client })
    await explainFacts('issue', facts(), { client, fresh: true })
    expect(create).toHaveBeenCalledTimes(3)
  })

  it('never puts secrets or bodies in the prompt', async () => {
    const { client, create } = stub('{"summary":"S","steps":[]}')
    await explainFacts(
      'webhook-delivery',
      facts({ client_secret: 'topsecret', request_body: { pii: 'jane@x.test' } }),
      { client }
    )
    const sent = JSON.stringify((create.mock.calls[0] as unknown[])[0])
    expect(sent).not.toMatch(/topsecret|jane@x\.test/)
  })

  it('503s without a provider and wraps provider failures', async () => {
    await expect(explainFacts('issue', facts(), { client: null })).rejects.toMatchObject({
      statusCode: 503
    })
    const client = { messages: { create: vi.fn(async () => Promise.reject(new Error('boom'))) } }
    await expect(explainFacts('issue', facts({ z: 1 }), { client })).rejects.toBeInstanceOf(
      ExplainError
    )
  })
})

describe('helpers', () => {
  it('finds the tables a statement reads', () => {
    expect(tablesOf('select * from [workflows] w join projects p on 1=1')).toEqual([
      'workflows',
      'projects'
    ])
  })

  it('folds volatile parts of an error message before grouping', () => {
    expect(
      normalizeForGrouping(
        "Invalid column name 'abc' at row 42 for 3F2504E0-4F89-11D3-9A0C-0305E82C3301"
      )
    ).toBe("Invalid column name '<x>' at row <n> for <id>")
  })

  it('clusters close vectors under one lead', () => {
    const items = [
      { id: 1, vec: [1, 0] },
      { id: 2, vec: [0.99, 0.05] },
      { id: 3, vec: [0, 1] }
    ]
    const g = clusterByVectors(items, 0.9)
    expect(g).toHaveLength(2)
    expect(g[0].members.map((m) => m.item.id)).toEqual([2])
  })

  it('knows Mondays', () => {
    expect(isMonday(new Date('2026-10-12T12:00:00'))).toBe(true)
    expect(isMonday(new Date('2026-10-13T12:00:00'))).toBe(false)
  })
})
