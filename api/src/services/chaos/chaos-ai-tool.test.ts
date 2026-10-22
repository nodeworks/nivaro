import { describe, expect, it } from 'vitest'
import { CHAOS_WHAT_IF_TOOL, executeChaosTool } from './chaos-ai-tool.js'

describe('chaos_what_if tool (#2860)', () => {
  it('is offered once to Ask AI and to the Telemetry Ask, read-only by its words', async () => {
    const { CHAT_TOOLS } = await import('../ai-chat.js')
    const { ASK_TOOLS } = await import('../telemetry-ai.js')
    expect(CHAT_TOOLS.filter((t) => t.name === 'chaos_what_if')).toHaveLength(1)
    expect(ASK_TOOLS.filter((t) => t.name === 'chaos_what_if')).toHaveLength(1)
    expect(CHAOS_WHAT_IF_TOOL.description).toMatch(/never starts or arms anything/)
  })

  it('runs through the telemetry executor without a telemetry store', async () => {
    delete process.env.TELEMETRY_STORE_URL
    const { executeTelemetryTool } = await import('../telemetry-ai.js')
    await expect(executeTelemetryTool('chaos_what_if', { dependency: 'moon' })).rejects.toThrow(
      /Unknown dependency/
    )
    await expect(executeChaosTool('other', {})).rejects.toThrow(/Unknown chaos tool/)
  })
})
