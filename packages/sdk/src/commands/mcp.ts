/**
 * MCP server support: which optional tool sets a credential gets.
 */
import { type Command, cmd } from '../command.js'

export interface McpCapabilities {
  /** The read-only admin/ops and layout tools (an administrator not on a collection-scoped key). */
  admin_tools: boolean
  /** Chat tools (#2492): none, reading only, or reading and posting. */
  chat: 'none' | 'read' | 'post'
}

/** What the MCP server may offer this credential (GET /api/mcp/capabilities). */
export function readMcpCapabilities(): Command<{ data: McpCapabilities }> {
  return cmd('GET', '/mcp/capabilities')
}
