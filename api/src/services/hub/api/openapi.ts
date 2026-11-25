import { HUB_ROUTES, type HubField, type HubRoute } from './catalog.js'

/**
 * OpenAPI for the Hub's own routes (/api/hub/*), built from the route catalog.
 *
 * Two readers: the instance's GET /api/dev-tools/openapi.json adds them only when this install
 * is a Hub (hubModeEnabled), and the public www/openapi.json (scripts) always adds them, every
 * entry in its own "Hub mode only" group so nobody reads them as a regular install's API.
 */

const OBJ = { type: 'object', additionalProperties: true }

export const HUB_SCHEMAS: Record<string, unknown> = {
  HubApp: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      key: { type: 'string' },
      name: { type: 'string' },
      signin_mode: { type: 'string', enum: ['direct', 'hub'] },
      adopted: { type: 'boolean' },
      extensions: { type: 'array', items: { type: 'string' } }
    },
    required: ['id', 'key', 'name']
  },
  HubEnvironment: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      app_id: { type: 'integer' },
      key: { type: 'string' },
      position: { type: 'integer' },
      status: { type: 'string' },
      base_url: { type: 'string' },
      hostnames: { type: 'array', items: { type: 'string' } },
      placement_id: { type: ['integer', 'null'] },
      version_pin: { type: ['string', 'null'] },
      hub_token: {
        type: ['string', 'null'],
        description: 'Masked (••••••) when one is stored, else null. Never the value.'
      },
      hub_managed: { type: 'boolean' },
      on_shared: { type: 'boolean' }
    }
  },
  HubOwner: {
    type: 'object',
    properties: { user_id: { type: 'string' }, name: { type: 'string' } }
  },
  HubAppDetail: {
    allOf: [
      { $ref: '#/components/schemas/HubApp' },
      {
        type: 'object',
        properties: {
          environments: {
            type: 'array',
            items: { $ref: '#/components/schemas/HubEnvironment' }
          },
          owners: { type: 'array', items: { $ref: '#/components/schemas/HubOwner' } }
        }
      }
    ]
  },
  HubDriver: {
    type: 'object',
    description: 'A GitLab or Docker driver. The token is never answered (`secret` is masked).',
    properties: {
      id: { type: 'integer' },
      kind: { type: 'string', enum: ['gitlab', 'docker'] },
      name: { type: 'string' },
      config: OBJ,
      secret: { type: ['string', 'null'], description: 'Masked (••••••) or null' }
    }
  },
  HubEnvStatus: {
    type: 'object',
    properties: {
      state: { type: 'string', enum: ['ok', 'degraded', 'unreachable', 'link_refused'] },
      version: { type: ['string', 'null'] },
      preflight: { type: ['string', 'null'] },
      checked_at: { type: 'string', format: 'date-time' },
      source: { type: 'string', enum: ['hub-link', 'public', 'shared'] },
      error: { type: 'string' },
      failing: { type: 'array', items: { type: 'string' } }
    }
  },
  HubDeploy: {
    type: 'object',
    properties: {
      pipeline_id: { type: 'integer' },
      ref: { type: 'string' },
      sha: { type: 'string' },
      status: { type: 'string' },
      started_at: { type: ['string', 'null'] },
      finished_at: { type: ['string', 'null'] },
      web_url: { type: 'string' },
      version: { type: ['string', 'null'] }
    }
  },
  HubRun: {
    type: 'object',
    description:
      'A promotion, move, shared upgrade or app creation run: id, status, timing, plan and (for one run) its log.',
    properties: {
      id: { type: 'integer' },
      status: { type: 'string' },
      created_at: { type: ['string', 'null'] },
      started_at: { type: ['string', 'null'] },
      finished_at: { type: ['string', 'null'] },
      plan: OBJ,
      log: { type: 'array', items: OBJ }
    },
    additionalProperties: true
  },
  HubPlan: {
    type: 'object',
    description:
      'A plan: what would happen, refusals and warnings, and `plan_hash` — the start call must send the same hash.',
    properties: { plan_hash: { type: 'string' } },
    additionalProperties: true
  },
  HubShared: {
    type: 'object',
    description: 'A shared deployment. Its token and secrets are never answered.',
    properties: {
      id: { type: 'integer' },
      key: { type: 'string' },
      mode: { type: 'string', enum: ['docker', 'registered'] },
      status: { type: 'string' },
      apps: { type: 'integer' },
      live_replicas: { type: ['integer', 'null'] }
    },
    additionalProperties: true
  },
  HubError: {
    type: 'object',
    properties: { error: { type: 'string' }, code: { type: 'string' } },
    required: ['error']
  }
}

function fieldSchema(f: HubField): Record<string, unknown> {
  const out: Record<string, unknown> = { type: f.type }
  if (f.type === 'array') out.items = { type: f.items ?? 'string' }
  if (f.type === 'object') out.additionalProperties = true
  if (f.enum) out.enum = f.enum
  const desc = [f.description, f.secret ? 'Write-only: never answered back.' : null]
    .filter(Boolean)
    .join(' ')
  if (desc) out.description = desc
  if (f.secret) out.writeOnly = true
  return out
}

function dataSchema(name: string | undefined): Record<string, unknown> {
  if (!name) return { type: 'object', properties: { data: OBJ } }
  const many = name.endsWith('[]')
  const ref = { $ref: `#/components/schemas/${name.replace(/\[\]$/, '')}` }
  return {
    type: 'object',
    properties: { data: many ? { type: 'array', items: ref } : ref }
  }
}

const AUTH_WORDS: Record<HubRoute['auth'], string> = {
  admin: 'Hub administrators.',
  owner: 'Hub administrators, or the app’s owners (an app you do not own answers 404).',
  machine: 'A machine bearer the route checks itself (no person, no API key).',
  public: 'OpenID endpoint.'
}

export interface HubOpenApiOptions {
  /** Public artefact (www/openapi.json): every tag says "Hub mode only". */
  publicArtefact?: boolean
}

export function hubTagName(group: string, opts: HubOpenApiOptions = {}): string {
  return opts.publicArtefact ? `Hub mode only · ${group}` : `Hub · ${group}`
}

function operation(e: HubRoute, opts: HubOpenApiOptions): Record<string, unknown> {
  const scope = e.access === 'write' ? 'hub:write' : 'hub:read'
  const lines = [
    `**Hub mode only** — mounted only on a Nivaro Hub (HUB=on); a regular install answers 404.`,
    `Who: ${AUTH_WORDS[e.auth]}`,
    e.auth === 'admin' || e.auth === 'owner'
      ? `API key scope: \`${scope}\`${e.access === 'plan' ? ' (a plan writes nothing)' : ''}.`
      : null,
    e.access === 'write' && (e.auth === 'admin' || e.auth === 'owner')
      ? 'Refused (403) to connected apps / MCP tool calls, View-as and run-as-key.'
      : null,
    e.sensitive ? 'Sensitive: changes or stops something people rely on.' : null,
    e.notes ?? null
  ].filter(Boolean)
  const params: Array<Record<string, unknown>> = []
  for (const m of e.path.matchAll(/:([A-Za-z]+)/g))
    params.push({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: m[1] === 'key' || m[1] === 'kid' ? 'string' : 'integer' }
    })
  for (const [name, f] of Object.entries(e.query ?? {}))
    params.push({ name, in: 'query', schema: fieldSchema(f) })
  const op: Record<string, unknown> = {
    tags: [hubTagName(e.group, opts)],
    summary: e.summary,
    description: lines.join('\n\n'),
    operationId: `hub_${e.method.toLowerCase()}_${e.path
      .replace(/[/:-]+/g, '_')
      .replace(/^_|_$/g, '')}`,
    ...(params.length ? { parameters: params } : {}),
    responses: {
      [e.accepted ? '202' : '200']: {
        description: e.accepted ? 'Started in the background' : 'OK',
        content: { 'application/json': { schema: dataSchema(e.response) } }
      },
      '403': {
        description: 'Not allowed for this caller (ADMIN_ONLY, HUB_SCOPE_MISSING, …)',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/HubError' } } }
      },
      '404': { description: 'Not found, not yours, or not a Hub' }
    },
    'x-hub-mode-only': true,
    'x-hub-access': e.access,
    ...(e.sensitive ? { 'x-hub-sensitive': true } : {})
  }
  if (e.body) {
    const required = Object.entries(e.body)
      .filter(([, f]) => f.required)
      .map(([k]) => k)
    op.requestBody = {
      required: required.length > 0,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: Object.fromEntries(
              Object.entries(e.body).map(([k, f]) => [k, fieldSchema(f)])
            ),
            ...(required.length ? { required } : {})
          }
        }
      }
    }
  }
  if (e.auth === 'admin' || e.auth === 'owner')
    op.security = [{ hubApiKey: [] }, { sessionCookie: [] }]
  else if (e.auth === 'machine') op.security = [{ hubMachineBearer: [] }]
  else op.security = []
  return op
}

export interface HubOpenApiParts {
  paths: Record<string, Record<string, unknown>>
  schemas: Record<string, unknown>
  securitySchemes: Record<string, unknown>
  tags: Array<{ name: string; description: string }>
  tagGroup: { name: string; tags: string[] }
}

/** The Hub's paths (relative to the `/api` server), schemas, security schemes and tags. */
export function hubOpenApiParts(opts: HubOpenApiOptions = {}): HubOpenApiParts {
  const paths: HubOpenApiParts['paths'] = {}
  for (const e of HUB_ROUTES) {
    const p = `/hub${e.path.replace(/:([A-Za-z]+)/g, '{$1}')}`
    paths[p] ??= {}
    paths[p][e.method.toLowerCase()] = operation(e, opts)
  }
  const groups = [...new Set(HUB_ROUTES.map((e) => e.group))]
  const tags = groups.map((g) => ({
    name: hubTagName(g, opts),
    description: `Hub mode only (HUB=on). ${g} of the Nivaro Hub — not part of a regular install's API.`
  }))
  return {
    paths,
    schemas: HUB_SCHEMAS,
    securitySchemes: {
      hubApiKey: {
        type: 'http',
        scheme: 'bearer',
        description:
          'A named API key (nvk_…) with the hub:read or hub:write scope (Hub mode only). `*` does not include the Hub.'
      },
      sessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'sessionId',
        description: 'Browser session cookie'
      },
      hubMachineBearer: {
        type: 'http',
        scheme: 'bearer',
        description:
          'A machine credential the route checks itself: a shared deployment’s token, an environment’s hub token or an OpenID client’s credentials'
      }
    },
    tags,
    tagGroup: {
      name: opts.publicArtefact ? 'Hub mode only' : 'Nivaro Hub',
      tags: tags.map((t) => t.name)
    }
  }
}

/** `spec` with the Hub's part merged in (paths, schemas, security schemes, tags, x-tagGroups). */
export function withHubOpenApi<T extends Record<string, unknown>>(
  spec: T,
  opts: HubOpenApiOptions = {}
): T {
  const parts = hubOpenApiParts(opts)
  const components = { ...((spec.components as Record<string, unknown> | undefined) ?? {}) }
  components.schemas = {
    ...((components.schemas as Record<string, unknown> | undefined) ?? {}),
    ...parts.schemas
  }
  components.securitySchemes = {
    ...((components.securitySchemes as Record<string, unknown> | undefined) ?? {}),
    ...parts.securitySchemes
  }
  const groups = ((spec['x-tagGroups'] as Array<{ name: string; tags: string[] }>) ?? []).filter(
    (g) => g.name !== parts.tagGroup.name
  )
  return {
    ...spec,
    paths: { ...((spec.paths as Record<string, unknown> | undefined) ?? {}), ...parts.paths },
    components,
    tags: [
      ...((spec.tags as Array<{ name: string }> | undefined) ?? []).filter(
        (t) => !parts.tags.some((h) => h.name === t.name)
      ),
      ...parts.tags
    ],
    'x-tagGroups': [...groups, parts.tagGroup]
  }
}
