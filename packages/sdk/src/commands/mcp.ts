/**
 * MCP server support: which optional tool sets a credential gets.
 */
import { type Command, cmd } from '../command.js'

export interface McpCapabilities {
  /** The read-only admin/ops and layout tools (an administrator not on a collection-scoped key). */
  admin_tools: boolean
  /** Chat tools (#2492): none, reading only, or reading and posting. */
  chat: 'none' | 'read' | 'post'
  /** PATCH /items/:collection/:id?dry_run=1 rehearses an update (#3222); absent on older instances. */
  update_preview?: boolean
}

/** What the MCP server may offer this credential (GET /api/mcp/capabilities). */
export function readMcpCapabilities(): Command<{ data: McpCapabilities }> {
  return cmd('GET', '/mcp/capabilities')
}
