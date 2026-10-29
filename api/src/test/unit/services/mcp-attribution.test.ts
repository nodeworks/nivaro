import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))

const { mcpWriteStampOf } = await import('../../../services/mcp-attribution.js')
const { agentBadgeLabel, MCP_SETTINGS_DEFAULTS, mergeMcpSettings } = await import(
  '../../../services/mcp-calls.js'
)

const GRANT = '0b6a6f0e-3f6c-4d8e-9b1a-2c3d4e5f6a7b'
const USER = 'A1B2C3D4-0000-4000-8000-000000000001'

describe('mcpWriteStampOf', () => {
  it('stamps only the hosted endpoint’s in-process calls', () => {
    const oauth = {
      authMethod: 'oauth',
      oauthGrantId: GRANT,
      oauthClientId: 'c1',
      oauthClientName: 'Claude\u0000 Code',
      user: { id: USER }
    }
    expect(mcpWriteStampOf(oauth as never)).toBeNull()
    expect(mcpWriteStampOf({ ...oauth, mcpInner: true } as never)).toEqual({
      mcp_conn: `o${GRANT}`,
      via_app: 'Claude Code'
    })
  })

  it('names an API key by its name and a token as the assistant', () => {
    expect(
      mcpWriteStampOf({
        mcpInner: true,
        authMethod: 'api_key',
        apiKeyId: 7,
        apiKeyName: 'Ops bot',
        user: { id: USER }
      } as never)
    ).toEqual({ mcp_conn: 'k7', via_app: 'Ops bot' })
    expect(
      mcpWriteStampOf({ mcpInner: true, authMethod: 'token', user: { id: USER } } as never)
    ).toEqual({ mcp_conn: `u${USER.toLowerCase()}`, via_app: 'Assistant' })
    expect(mcpWriteStampOf({ mcpInner: true } as never)).toBeNull()
  })
})

describe('agent badge setting', () => {
  it('names the app by default, else the fixed label', () => {
    expect(agentBadgeLabel('Claude', MCP_SETTINGS_DEFAULTS)).toBe('via Claude')
    expect(agentBadgeLabel(null, MCP_SETTINGS_DEFAULTS)).toBe('via assistant')
    const fixed = mergeMcpSettings(MCP_SETTINGS_DEFAULTS, {
      agent_label_mode: 'fixed',
      agent_label: '  AI\u0007 edit  '
    })
    expect(fixed.agent_label).toBe('AI edit')
    expect(agentBadgeLabel('Claude', fixed)).toBe('AI edit')
  })

  it('validates the setting', () => {
    expect(() => mergeMcpSettings(MCP_SETTINGS_DEFAULTS, { agent_label_mode: 'loud' })).toThrow(
      /name the app/
    )
    expect(() => mergeMcpSettings(MCP_SETTINGS_DEFAULTS, { agent_label: '   ' })).toThrow(
      /cannot be empty/
    )
    expect(
      mergeMcpSettings(MCP_SETTINGS_DEFAULTS, { agent_label: 'x'.repeat(80) }).agent_label
    ).toHaveLength(40)
  })
})
