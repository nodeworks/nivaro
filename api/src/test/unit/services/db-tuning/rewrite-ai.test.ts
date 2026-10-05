import { describe, expect, it } from 'vitest'
import {
  aiRewriteCandidate,
  extractSqlBlock,
  sameSignature
} from '../../../../services/db-tuning/rewrites/ai.js'

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
