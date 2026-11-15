import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { agentNameRefusal, reservedAgentWord } from '../../../services/agent-name-guard.js'

describe('agent names that may not be used', () => {
  it('finds reserved words as whole words, any case', () => {
    expect(reservedAgentWord('Administrator')).toBe('administrator')
    expect(reservedAgentWord('nivaro helper')).toBe('nivaro')
    expect(reservedAgentWord('System-Bot')).toBe('system')
    expect(reservedAgentWord('Service Desk')).toBe('service desk')
    expect(reservedAgentWord('Supporter')).toBeNull()
    expect(reservedAgentWord('Ops bot')).toBeNull()
  })

  it("refuses a person's name and fails closed when the directory cannot answer", async () => {
    const people = { isPersonName: async (n: string) => n.toLowerCase() === 'beth ortiz' }
    expect(await agentNameRefusal('Beth Ortiz', people)).toMatch(/name of a person/)
    expect(await agentNameRefusal('Ops bot', people)).toBeNull()
    const down = {
      isPersonName: async () => {
        throw new Error('db down')
      }
    }
    expect(await agentNameRefusal('Ops bot', down)).toMatch(/name of a person/)
  })
})
