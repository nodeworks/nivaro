/**
 * Chaos tools (#2860) — `chaos_what_if`: what breaks if one dependency dies, from the resilience
 * scorecard, the Traffic Map blast radius and the last drills, plus a DRAFT experiment and a link
 * that opens the chaos builder pre-filled. Read-only: it never arms a fault. Rides
 * GET /api/chaos/what-if, which the app gates to administrators.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { chaosWhatIf, type NivaroClient } from '@nivaro/sdk'
import { z } from 'zod'
import { READ } from '../annotations.js'
import { fail, ok } from '../result.js'

export function registerChaosTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'chaos_what_if',
    {
      title: 'What if a dependency died?',
      description:
        'What happens if one dependency dies: the degradation claims about it and when each was last proven by a chaos drill, the blast radius from recorded traffic (routes, screens, jobs), the last drills against it, and a DRAFT experiment with a link that opens the chaos experiment builder pre-filled. Read-only — it never starts a drill; a person opens the link, checks pre-flight and presses Run. Admin only.',
      inputSchema: {
        dependency: z
          .string()
          .min(1)
          .max(80)
          .describe(
            'database, redis, files, mail, ai, signin, partners, sockets or replica (aliases like sql, smtp, oidc work), or ext:<external API id>.'
          )
      },
      annotations: READ
    },
    async (args: { dependency: string }) => {
      try {
        const res = await client.request(chaosWhatIf(args.dependency))
        return ok(res.data)
      } catch (err) {
        return fail(err)
      }
    }
  )
}
