import { describe, expect, it } from 'vitest'
import { briefLinesFor, registerBriefLine } from '../../../services/approval-brief-lines.js'

describe('approval brief lines', () => {
  it('returns nothing for a collection nobody registered', async () => {
    expect(await briefLinesFor('nobody_registered_this', '1')).toEqual([])
  })

  it('keeps the lines that answer and drops a provider that throws or says nothing', async () => {
    registerBriefLine('test', 'brief_lines_a', async ({ item }) => ({ label: 'Budget', text: `record ${item} is inside budget`, tone: 'ok' }))
    registerBriefLine('test', 'brief_lines_a', async () => {
      throw new Error('boom')
    })
    registerBriefLine('test', 'brief_lines_a', async () => null)
    registerBriefLine('test', 'brief_lines_a', async () => ({ label: 'Empty', text: '   ' }))
    expect(await briefLinesFor('brief_lines_a', '7')).toEqual([{ label: 'Budget', text: 'record 7 is inside budget', tone: 'ok' }])
  })

  it('defaults the tone and bounds the text', async () => {
    registerBriefLine('test', 'brief_lines_b', async () => ({ label: 'Long', text: 'x'.repeat(900) }))
    const [line] = await briefLinesFor('brief_lines_b', '1')
    expect(line.tone).toBe('neutral')
    expect(line.text.length).toBe(300)
  })
})
