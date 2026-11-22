import { type DataTag, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * Nivaro Hub phase 7: what the sign-in screens read from /api/hub/signin/*. Own query keys
 * (`['hub','signin',…]`) and types. A client secret is NEVER read through a query: create and
 * rotate answer it once, and the screens keep it in component state only.
 */

export interface SigningKey {
  kid: string
  alg: string
  created_at: string
  /** For the signing key during a hand-over: when the next key takes over (still to come). */
  retired_at: string | null
  /** Signs now. */
  active: boolean
  /**
   * signing = signs now; next = published, signs from `signs_from`; live = published, older than
   * the signing key, not signing; retiring = published until `published_until`; retired = no
   * longer published.
   */
  status?: SigningKeyStatus
  signs_from?: string | null
  published_until?: string | null
  /** The server would allow removing it (not the only key that can sign). */
  removable?: boolean
}

export type SigningKeyStatus = 'signing' | 'next' | 'live' | 'retiring' | 'retired'

/** What removing a key answers: who signs now, and a warning when that key is brand new. */
export interface RemovedKey {
  kid: string
  signing_kid: string | null
  warning: string | null
}

export interface SigninSettings {
  issuer: string
  idp_audience: string | null
  /** Administrators only; null for anyone else. */
  keys: SigningKey[] | null
}

export interface SigninOverviewEnv {
  id: number
  key: string
  has_client: boolean
  active: boolean
  signins_30d: number
}

export interface SigninOverviewApp {
  id: number
  key: string
  name: string
  signin_mode: 'direct' | 'hub'
  signins_30d: number
  environments: SigninOverviewEnv[]
}

export interface EnvClient {
  client_id: string
  active: boolean
  /** Always the mask, never the secret. */
  secret: string
  redirect_uris: string[]
  post_logout_uris: string[]
  created_at: string | null
  secret_rotated_at: string | null
}

export interface EnvLines {
  HUB_URL: string
  HUB_CLIENT_ID: string | null
  HUB_IDP_AUDIENCE: string | null
}

export interface EnvClientRead {
  client: EnvClient | null
  redirect_uris: string[]
  env_lines: EnvLines
  signins_30d: number
}

/** What create and rotate answer, once. */
export interface MintedSecret {
  client_id: string
  client_secret: string
  env_lines: EnvLines
}

type Tagged<K extends readonly unknown[], T> = DataTag<K, T>
const tag = <T, K extends readonly unknown[]>(k: K) => k as unknown as Tagged<K, T>

export const signinKeys: {
  settings: () => Tagged<readonly ['hub', 'signin', 'settings'], SigninSettings>
  overview: () => Tagged<readonly ['hub', 'signin', 'overview'], SigninOverviewApp[]>
  env: (envId: number) => Tagged<readonly ['hub', 'signin', 'env', number], EnvClientRead>
} = {
  settings: () =>
    tag<SigninSettings, readonly ['hub', 'signin', 'settings']>(['hub', 'signin', 'settings']),
  overview: () =>
    tag<SigninOverviewApp[], readonly ['hub', 'signin', 'overview']>(['hub', 'signin', 'overview']),
  env: (envId) =>
    tag<EnvClientRead, readonly ['hub', 'signin', 'env', number]>(['hub', 'signin', 'env', envId])
}

export const fetchSigninSettings = () =>
  api.get<{ data: SigninSettings }>('/hub/signin/settings').then((r) => r.data.data)

export const fetchSigninOverview = () =>
  api.get<{ data: SigninOverviewApp[] }>('/hub/signin/overview').then((r) => r.data.data ?? [])

export const fetchEnvClient = (envId: number) =>
  api
    .get<{ data: EnvClientRead }>(`/hub/signin/environments/${envId}/client`)
    .then((r) => r.data.data)

export const useSigninSettings = () =>
  useQuery({ queryKey: signinKeys.settings(), queryFn: fetchSigninSettings })

export const useSigninOverview = () =>
  useQuery({ queryKey: signinKeys.overview(), queryFn: fetchSigninOverview })

export const useEnvClient = (envId: number) =>
  useQuery({ queryKey: signinKeys.env(envId), queryFn: () => fetchEnvClient(envId) })

// ─── Writes (plain calls: a secret in an answer must not land in the mutation cache) ──────────

export const setAppMode = (appId: number, mode: 'direct' | 'hub') =>
  api.patch(`/hub/signin/apps/${appId}/mode`, { signin_mode: mode })

export const createEnvClient = (envId: number) =>
  api
    .post<{ data: MintedSecret }>(`/hub/signin/environments/${envId}/client`)
    .then((r) => r.data.data)

export const rotateEnvSecret = (envId: number) =>
  api
    .post<{ data: { client_secret: string } }>(`/hub/signin/environments/${envId}/client/rotate`)
    .then((r) => r.data.data.client_secret)

export const setClientActive = (envId: number, active: boolean) =>
  api.patch(`/hub/signin/environments/${envId}/client`, { active })

export const rotateSigningKey = () =>
  api
    .post<{ data: { kid: string; signs_from?: string } }>('/hub/signin/keys/rotate')
    .then((r) => r.data?.data)

export const removeSigningKey = (kid: string) =>
  api
    .delete<{ data: RemovedKey }>(`/hub/signin/keys/${encodeURIComponent(kid)}`)
    .then((r) => r.data.data)

/** The env lines an app sets, one per row (the secret line is added by the one-time block). */
export function envLinesText(lines: EnvLines, secret: string): string {
  return [
    `HUB_URL=${lines.HUB_URL}`,
    `HUB_CLIENT_ID=${lines.HUB_CLIENT_ID ?? ''}`,
    `HUB_CLIENT_SECRET=${secret}`,
    `HUB_IDP_AUDIENCE=${lines.HUB_IDP_AUDIENCE ?? ''}`
  ].join('\n')
}
