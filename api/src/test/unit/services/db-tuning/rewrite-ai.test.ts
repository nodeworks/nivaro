import { describe, expect, it, vi } from 'vitest'
import { db } from '../../../../db/index.js'
import { featureFromRoute } from '../../../../services/ai-log.js'
import {
  aiBudgetAllows,
  aiRewriteCandidate,
  extractSqlBlock,
  sameSignature
} from '../../../../services/db-tuning/rewrites/ai.js'
import { currentTraceMeta } from '../../../../services/request-trace.js'

const reply = (text: string) => ({
  messages: { create: async () => ({ content: [{ type: 'text', text }] }) }
})
const run = (client: unknown) =>
  aiRewriteCandidate({
    proc: 'p',
    body: 'CREATE PROC p @A INT AS SELECT 1',
    planOps: [],
    hotLines: [],
    client: client as never,
    model: 'm'
  })

describe('ai rewrite hardening', () => {
  it('fails the budget closed when the spend cannot be read', async () => {
    vi.mocked(db).mockImplementation((() => {
      throw new Error('db down')
    }) as never)
    expect(await aiBudgetAllows(5)).toBe(false)
  })
  it('compares every parameter in full', () => {
    const h = (p: string) => `CREATE PROC p ${p} AS SELECT 1`
    expect(sameSignature(h('@A INT = NULL'), h('@A INT = 5'))).toBe(false)
    expect(sameSignature(h('@A INT OUTPUT'), h('@A INT'))).toBe(false)
    expect(sameSignature(h('@A DECIMAL(10,2)'), h('@A DECIMAL(10,4)'))).toBe(false)
    expect(sameSignature(h('@A DECIMAL(10,2), @B INT'), h('@B INT,@A decimal( 10 , 2 )'))).toBe(
      true
    )
    expect(sameSignature(h('@A INT'), 'CREATE PROC [dbo].[p]\n  @A  [INT]\nAS SELECT 1')).toBe(true)
  })
  it('returns null when the client throws', async () => {
    const client = {
      messages: {
        create: async () => {
          throw new Error('boom')
        }
      }
    }
    expect(await run(client)).toBeNull()
  })
  it('returns null when the procedure name differs', async () => {
    expect(await run(reply('```sql\nCREATE PROC other @A INT AS SELECT 2\n```'))).toBeNull()
  })
  it('treats an empty block as no block and accepts a tsql tag', () => {
    expect(extractSqlBlock('```sql\n\n```')).toBeNull()
    expect(extractSqlBlock('```tsql\nSELECT 1\n```')).toBe('SELECT 1')
  })
})

describe('ai rewrite attribution', () => {
  it('every call is logged under the db-tune feature, cron or request', async () => {
    const seen: string[] = []
    const client = {
      messages: {
        create: async () => {
          // what the AI call log (ai-log loggedCreate) reads at call time
          seen.push(featureFromRoute(currentTraceMeta()?.urlHint ?? null))
          return {
            content: [{ type: 'text', text: '```sql\nCREATE PROC p @A INT AS SELECT 2\n```' }]
          }
        }
      }
    }
    await run(client)
    expect(seen).toEqual(['db-tune'])
  })
})

describe('ai rewrite', () => {
  it('extracts the fenced sql block', () => {
    expect(extractSqlBlock('here\n```sql\nSELECT 1\n```\nbye')).toBe('SELECT 1')
    expect(extractSqlBlock('no fence')).toBeNull()
  })
  it('compares procedure signatures by parameter set', () => {
    expect(
      sameSignature(
        'CREATE PROC p @A INT, @B NVARCHAR(10) = NULL AS SELECT 1',
        'CREATE OR ALTER PROCEDURE dbo.p @B NVARCHAR(10) = NULL, @A INT AS SELECT 2'
      )
    ).toBe(true)
    expect(
      sameSignature('CREATE PROC p @A INT AS SELECT 1', 'CREATE PROC p @A INT, @C INT AS SELECT 1')
    ).toBe(false)
  })
  it('returns the body when the model answers with a fenced block of the same signature', async () => {
    const client = {
      messages: {
        create: async () => ({
          content: [
            {
              type: 'text',
              text: '```sql\nCREATE OR ALTER PROCEDURE dbo.p @A INT AS SELECT 2\n```'
            }
          ]
        })
      }
    }
    const r = await aiRewriteCandidate({
      proc: 'p',
      body: 'CREATE PROC p @A INT AS SELECT 1',
      planOps: [],
      hotLines: [],
      client: client as never,
      model: 'm'
    })
    expect(r?.body).toMatch(/SELECT 2/)
    expect(r?.notes).toEqual(['AI-written'])
  })
  it('returns null when the signature changed', async () => {
    const client = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: '```sql\nCREATE PROC p @A INT, @Z INT AS SELECT 2\n```' }]
        })
      }
    }
    expect(
      await aiRewriteCandidate({
        proc: 'p',
        body: 'CREATE PROC p @A INT AS SELECT 1',
        planOps: [],
        hotLines: [],
        client: client as never,
        model: 'm'
      })
    ).toBeNull()
  })
})
