/**
 * MCP tool annotations. Clients use them to decide when to ask the person
 * before a call: a read never changes anything, a write does, a destructive
 * write removes something. Every tool talks only to the configured instance,
 * so none is open-world.
 */
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

/** Reads: nothing on the instance changes. */
export const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false }

/** Adds or changes something; running it twice does it twice. */
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
}

/** Changes something; running it again with the same input changes nothing more. */
export const WRITE_IDEMPOTENT: ToolAnnotations = { ...WRITE, idempotentHint: true }

/** Removes something. */
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false
}
