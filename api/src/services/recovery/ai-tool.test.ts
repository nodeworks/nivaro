import { describe, expect, it, vi } from 'vitest'

vi.mock('./status.js', () => ({ recoveryForAi: async () => ({ verdict: 'warn', rows: [] }) }))

describe('recovery_status telemetry tool', () => {
  it('is offered to Ask AI and answers without the telemetry store', async () => {
    delete process.env.TELEMETRY_STORE_URL
    const { ASK_TOOL_NAMES, executeTelemetryTool } = await import('../telemetry-ai.js')
    expect(ASK_TOOL_NAMES.has('recovery_status')).toBe(true)
    await expect(executeTelemetryTool('recovery_status', {})).resolves.toEqual({
      verdict: 'warn',
      rows: []
    })
  })
})
