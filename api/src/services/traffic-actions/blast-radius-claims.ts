// api/src/services/traffic-actions/blast-radius-claims.ts
/**
 * Blast-radius claims (#2841): what the CODE does when a dependency goes away, for the Traffic
 * Map's "Simulate down". Recorded traffic says what calls a node; it cannot say whether a caller
 * fails or carries on degraded — these rows do. Each row names the file that makes the behaviour
 * true, so a change there is a change here. Plain sentences, shown as written.
 *
 * effect: 'fails'    = stops working while the node is down
 *         'degrades' = keeps working, worse (slower, this replica only, a fallback)
 *         'keeps'    = unaffected, said out loud because people assume otherwise
 * area:   'feature' | 'job' | 'channel' | 'session'
 */

export type ClaimEffect = 'fails' | 'degrades' | 'keeps'
export type ClaimArea = 'feature' | 'job' | 'channel' | 'session'

export interface BlastClaim {
  effect: ClaimEffect
  area: ClaimArea
  text: string
  /** The file whose code makes this true. */
  source: string
}

/** Dependency nodes with claims (keys are Traffic Map down ids; `ai` covers every `ai:*`). */
export const BLAST_CLAIMS: Record<string, BlastClaim[]> = {
  db: [
    {
      effect: 'fails',
      area: 'feature',
      text: 'Every data read and write, sign-in lookups and permission checks fail.',
      source: 'api/src/routes/ops-runtime.ts' // subsystem table: Database impact_when_down
    },
    {
      effect: 'fails',
      area: 'job',
      text: 'Scheduled jobs still fire but cannot read or write anything, so their runs fail.',
      source: 'api/src/services/job-runs.ts' // every run starts by writing its nivaro_job_runs row
    },
    {
      effect: 'fails',
      area: 'channel',
      text: 'In-app notifications stop: the inbox rows live in the database.',
      source: 'api/src/services/notification-channels.ts'
    },
    {
      effect: 'degrades',
      area: 'feature',
      text: 'Custom-query and widget results already cached in Redis keep answering until they expire.',
      source: 'api/src/services/traffic-map.ts' // a cache hit is served from Redis, not SQL
    },
    {
      effect: 'keeps',
      area: 'feature',
      text: 'The API process stays up and the health check answers, reporting the database down.',
      source: 'api/src/routes/ops-runtime.ts'
    }
  ],
  redis: [
    {
      effect: 'fails',
      area: 'session',
      text: 'Browser sign-in sessions are stored in Redis, so requests signed in by session fail; if Redis comes back empty everyone signs in again.',
      source: 'api/src/auth/session.ts' // buildRedisStore; plugins/redis.ts maxRetriesPerRequest 3
    },
    {
      effect: 'fails',
      area: 'job',
      text: 'Scheduled jobs stop firing on the clock (the scheduler lease fails closed). Run now still works, except jobs marked unsafe to run twice, which refuse.',
      source: 'api/src/plugins/cron.ts' // CronLeader + JobBusyError
    },
    {
      effect: 'fails',
      area: 'session',
      text: 'Socket sign-in tokens and masquerade (View as) tokens stop working.',
      source: 'api/src/routes/ops-runtime.ts' // subsystem table: Redis impact_when_down
    },
    {
      effect: 'degrades',
      area: 'channel',
      text: 'Live updates stop crossing replicas: each server pushes only to its own sockets until Redis is back.',
      source: 'api/src/server.ts' // event stream + journal fail open
    },
    {
      effect: 'degrades',
      area: 'feature',
      text: 'Custom-query result caching is off, so every dashboard and query read goes to the database.',
      source: 'api/src/services/custom-query-cache.ts'
    },
    {
      effect: 'degrades',
      area: 'feature',
      text: 'The shared metadata cache and the permission cache are skipped; answers are built from the database each time.',
      source: 'api/src/db/metadata-l2.ts' // and services/permission-cache.ts
    },
    {
      effect: 'degrades',
      area: 'feature',
      text: 'Rate limits and Traffic Map circuit breakers fail open: nothing is refused.',
      source: 'api/src/plugins/rate-limit.ts' // and services/traffic-breaker.ts
    },
    {
      effect: 'degrades',
      area: 'job',
      text: 'The heavy-job slot fails open, so heavy jobs on different servers may overlap.',
      source: 'api/src/plugins/cron.ts'
    },
    {
      effect: 'degrades',
      area: 'feature',
      text: 'Presence (who is online) answers unavailable; chat sends fall back to this server’s own duplicate check.',
      source: 'api/src/routes/presence.ts' // and services/chat-send.ts
    },
    {
      effect: 'keeps',
      area: 'feature',
      text: 'Saves and reads made with API keys or bearer tokens keep working against the database.',
      source: 'api/src/routes/ops-runtime.ts'
    }
  ],
  store: [
    {
      effect: 'fails',
      area: 'feature',
      text: 'File uploads, downloads and previews fail.',
      source: 'api/src/services/traffic-entities.ts' // files lane classified onto `store`
    },
    {
      effect: 'keeps',
      area: 'feature',
      text: 'Records keep working; their file links show but do not open.',
      source: 'api/src/routes/files.ts'
    }
  ],
  mail: [
    {
      effect: 'fails',
      area: 'channel',
      text: 'Outgoing email fails; each send is logged as failed on the delivery board.',
      source: 'api/src/services/mail.ts' // MailOutcome 'failed'
    },
    {
      effect: 'keeps',
      area: 'channel',
      text: 'In-app notifications, live updates and browser push keep arriving.',
      source: 'api/src/services/notification-channels.ts'
    }
  ],
  sms: [
    {
      effect: 'fails',
      area: 'channel',
      text: 'Text messages fail.',
      source: 'api/src/services/sms.ts'
    },
    {
      effect: 'keeps',
      area: 'channel',
      text: 'In-app notifications and email keep arriving.',
      source: 'api/src/services/notification-channels.ts'
    }
  ],
  push: [
    {
      effect: 'fails',
      area: 'channel',
      text: 'Browser push notifications fail.',
      source: 'api/src/services/notification-channels.ts'
    },
    {
      effect: 'keeps',
      area: 'channel',
      text: 'The in-app inbox and email keep arriving.',
      source: 'api/src/services/notification-channels.ts'
    }
  ],
  ai: [
    {
      effect: 'fails',
      area: 'feature',
      text: 'Ask AI, AI fill, summaries and document autofill answer with an error.',
      source: 'api/src/services/ai-client.ts' // getAiClient is the one factory
    },
    {
      effect: 'keeps',
      area: 'feature',
      text: 'Records, forms and saves do not wait on AI and keep working.',
      source: 'api/src/services/ai-client.ts'
    }
  ],
  partner: [
    {
      effect: 'fails',
      area: 'feature',
      text: 'Calls and pushes to this partner fail; each one is kept in the partner call log.',
      source: 'api/src/services/outbound-recorder.ts'
    },
    {
      effect: 'keeps',
      area: 'feature',
      text: 'The records behind the pushes save normally; only the hand-off fails.',
      source: 'api/src/services/outbound-recorder.ts'
    }
  ],
  signin: [
    {
      effect: 'fails',
      area: 'session',
      text: 'New sign-ins with the identity provider fail.',
      source: 'api/src/auth/oidc.ts' // and routes/auth.ts
    },
    {
      effect: 'keeps',
      area: 'session',
      text: 'People already signed in stay signed in (their sessions are in Redis), and API keys keep working.',
      source: 'api/src/auth/session.ts'
    }
  ]
}

/** The claims for a node id (`ai:gateway-openai` → ai, `ext:4` → partner); [] when none. */
export function claimsFor(node: string): BlastClaim[] {
  if (BLAST_CLAIMS[node]) return BLAST_CLAIMS[node]
  if (node === 'ai' || node.startsWith('ai:')) return BLAST_CLAIMS.ai
  if (node.startsWith('ext:') || node.startsWith('x:')) return BLAST_CLAIMS.partner
  return []
}
