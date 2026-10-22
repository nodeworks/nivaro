import type Anthropic from '@anthropic-ai/sdk'
import { DEPENDENCIES } from './what-if.js'

/**
 * `chaos_what_if` (#2860): the assistant tool for "what breaks if Redis dies?". Read-only and
 * administrators only — offered to Ask AI (admins), the Telemetry page's Ask and the ops
 * assistant in admin-only channels; the MCP tool of the same name rides GET /api/chaos/what-if.
 * It returns a DRAFT experiment and a builder link; it never arms a fault.
 */

export const CHAOS_WHAT_IF_TOOL: Anthropic.Tool = {
  name: 'chaos_what_if',
  description: `What happens if one dependency dies: the degradation claims about it and when each was last proven by a chaos drill, the blast radius worked out from recorded traffic (routes, screens, jobs that fail or degrade), the last drills against it, and a DRAFT experiment with a link that opens the chaos experiment builder pre-filled. Read-only: it never starts or arms anything — tell the person to open the link, check pre-flight and press Run themselves. Administrators only. Dependencies: ${DEPENDENCIES.map((d) => d.key).join(', ')}, or ext:<partner id>.`,
  input_schema: {
    type: 'object' as const,
    properties: {
      dependency: {
        type: 'string',
        description: `One of ${DEPENDENCIES.map((d) => d.key).join(', ')} (aliases like "sql", "smtp", "oidc" work), or ext:<external API id>.`
      }
    },
    required: ['dependency']
  }
}

export const CHAOS_TOOLS: Anthropic.Tool[] = [CHAOS_WHAT_IF_TOOL]
export const CHAOS_TOOL_NAMES = new Set(CHAOS_TOOLS.map((t) => t.name))

/** One sentence for the system prompts that offer the tool. */
export const CHAOS_TOOL_PROMPT =
  'For "what if X died / went down / what breaks without X" questions call chaos_what_if: answer from its claims (say when each was last proven, or that it never was), its blast radius and last runs, and offer its builder link as a draft experiment — never say a drill was started.'

/** Run the tool (the caller has already checked the asker is an administrator). */
export async function executeChaosTool(
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  if (name !== CHAOS_WHAT_IF_TOOL.name) throw new Error(`Unknown chaos tool ${name}`)
  const { whatIf } = await import('./what-if.js')
  return whatIf(input.dependency)
}
