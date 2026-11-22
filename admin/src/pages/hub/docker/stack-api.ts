import { api } from '@/lib/api'

/**
 * Nivaro Hub (phase 4) — the environment stack routes (hub-docker.ts): what the stack panel
 * reads and writes. Secrets only ever come back as the mask; nothing here stores a value.
 */

export type StackState = 'converged' | 'updating' | 'rolled_back' | 'paused' | 'degraded'

export interface StackServiceStatus {
  name: string
  role: string
  image: string
  replicas: { desired: number; running: number }
  update: string
  message: string | null
}

export interface StackStatus {
  name: string
  image: string | null
  state: StackState
  published_port: number | null
  services: StackServiceStatus[]
}

/** `GET /hub/environments/:id/stack` */
export interface StackInfo {
  stack_name: string | null
  dns_mode: 'automatic' | 'manual'
  name_request: string[] | null
  status: StackStatus | null
  /** 'ok' or the agent's / the Hub's refusal code (STACK_OWNER_MISMATCH, AGENT_UNREACHABLE…). */
  agent: string
}

/** `GET|PUT /hub/environments/:id/stack/settings` */
export interface StackSettings {
  size: 'small' | 'medium' | 'large'
  redis: 'bundled' | 'external'
  publish_port: number | null
  settings: Record<string, string>
  secrets: Record<string, string>
  secrets_error?: string
  saved: boolean
  /** null when the stored pins cannot be read whole. */
  extension_pins: Record<string, string> | null
  extension_pins_error?: string
}

export const stackKeys = {
  stack: (envId: number) => ['hub', 'docker', 'stack', envId] as const,
  settings: (envId: number) => ['hub', 'docker', 'stack-settings', envId] as const
}

export const fetchStack = (envId: number) =>
  api.get<{ data: StackInfo }>(`/hub/environments/${envId}/stack`).then((r) => r.data.data)

export const fetchStackSettings = (envId: number) =>
  api
    .get<{ data: StackSettings }>(`/hub/environments/${envId}/stack/settings`)
    .then((r) => r.data.data)

export const putStackSettings = (envId: number, body: Record<string, unknown>) =>
  api
    .put<{ data: StackSettings }>(`/hub/environments/${envId}/stack/settings`, body)
    .then((r) => r.data.data)

export const restartStack = (envId: number, confirm: string) =>
  api.post(`/hub/environments/${envId}/stack/restart`, { confirm })

export interface RemoveResult {
  removed: boolean | Record<string, string[] | number>
  already_absent?: boolean
}

export const removeStack = (envId: number, name: string, volumes: boolean): Promise<RemoveResult> =>
  api
    .post<{ data: RemoveResult }>(`/hub/environments/${envId}/stack/remove`, {
      confirm: name,
      ...(volumes ? { remove_volumes: true, confirm_volumes: `delete ${name} data` } : {})
    })
    .then((r) => r.data.data)

export const checkStackName = (envId: number) =>
  api
    .post<{ data: { state: string; status: string } }>(
      `/hub/environments/${envId}/stack/check-name`,
      {}
    )
    .then((r) => r.data.data)

/** The API's refusal: code and message (names and fields only, never a value). */
export function refusalOf(err: unknown): {
  code: string | null
  message: string | null
  field: RefusalField | null
} {
  const data = (
    err as { response?: { data?: { code?: unknown; error?: unknown; field?: unknown } } } | null
  )?.response?.data
  const f = data?.field as { kind?: unknown; key?: unknown } | null | undefined
  const kind = typeof f?.kind === 'string' ? f.kind : null
  return {
    code: typeof data?.code === 'string' ? data.code : null,
    message: typeof data?.error === 'string' ? data.error : null,
    field: kind ? { kind, ...(typeof f?.key === 'string' ? { key: f.key } : {}) } : null
  }
}

/** The entry a settings refusal is about (never a value). */
export interface RefusalField {
  kind: string
  key?: string
}

export const STACK_STATE_WORDS: Record<StackState, string> = {
  converged: 'Converged',
  updating: 'Updating',
  rolled_back: 'Rolled back',
  paused: 'Paused',
  degraded: 'Degraded'
}

/** 12 hex characters of an image's sha256 digest, else the tag-less tail. */
export function shortDigest(image: string | null): string | null {
  if (!image) return null
  const m = /@sha256:([0-9a-f]{12})/i.exec(image)
  return m ? m[1] : image.split('/').pop() || image
}

/** How many objects of one kind a remove answered (a list of names or a count). */
export const removedCount = (v: string[] | number | undefined): number =>
  Array.isArray(v) ? v.length : Number(v ?? 0)

/** Secrets the Hub generates on first save: never cleared, replaced only on purpose. */
export const GENERATED_SECRETS: readonly string[] = ['SESSION_SECRET', 'ENCRYPTION_KEY']
