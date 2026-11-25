import { describeError, type ErrorDescription, errorToastOptions } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'

/**
 * Nivaro Hub people directory + "Offboard everywhere" (routes/hub-people.ts): types, query keys,
 * fetchers and the copy for every code the routes answer. Person keys are opaque
 * (u:<hub user id> | k:<sign-in row id>): an email never goes in a URL.
 */

export interface DirectoryEnvironment {
  environment_id: number
  app_id: number
  app_key: string
  app_name: string
  environment_key: string
  via: 'hub' | 'direct'
  last_seen: string | null
}

export interface DirectoryPerson {
  key: string
  name: string | null
  email: string | null
  hub_user_id: string | null
  last_seen: string | null
  environments: DirectoryEnvironment[]
}

export type EnvOutcome =
  | 'pending'
  | 'suspended'
  | 'already'
  | 'none'
  | 'refused'
  | 'no_link'
  | 'failed'

export interface OffboardResult {
  environment_id: number
  app_id: number
  app_key: string
  app_name: string
  environment_key: string
  state: EnvOutcome
  code?: string
  accounts?: number
  attempts: number
  at: string | null
}

export interface OffboardRun {
  id: number
  label: string | null
  person_key: string | null
  identity?: { emails: string[]; entra: Array<{ oid: string; tid: string | null }> }
  status: 'running' | 'done' | 'partial' | 'interrupted'
  results: OffboardResult[]
  hub_account: 'suspended' | 'already' | 'none' | null
  blocked: boolean
  started_at: string | null
  finished_at: string | null
  lifted_at: string | null
}

export interface PersonDetail extends DirectoryPerson {
  /** Exactly what every app is asked to suspend: proven emails and Microsoft ids only. */
  identity: { emails: string[]; entra: Array<{ oid: string; tid: string | null }> }
  identity_hash: string
  offboards: OffboardRun[]
}

export interface PersonAccount {
  user_id: string
  status: string
  role: string | null
  admin: boolean
  matched_by: 'entra' | 'email'
}

export interface EnvAccess {
  environment_id: number
  app_id: number
  app_key: string
  app_name: string
  environment_key: string
  production: boolean
  state: 'account' | 'none' | 'no_link' | 'error'
  code?: string
  accounts: PersonAccount[]
}

export const peopleKeys = {
  list: (q: string) => ['hub-people', q] as const,
  person: (key: string) => ['hub-person', key] as const,
  access: (key: string) => ['hub-person-access', key] as const
}

export const fetchPeople = (q: string) =>
  api
    .get('/hub/people', { params: { q: q || undefined, limit: 200 } })
    .then((r) => r.data as { data: DirectoryPerson[]; total: number })

export const fetchPerson = (key: string) =>
  api.get(`/hub/people/${encodeURIComponent(key)}`).then((r) => r.data.data as PersonDetail)

export const fetchPersonAccess = (key: string) =>
  api.get(`/hub/people/${encodeURIComponent(key)}/access`).then((r) => r.data.data as EnvAccess[])

export const startOffboard = (key: string, confirm: string, identityHash: string) =>
  api
    .post(`/hub/people/${encodeURIComponent(key)}/offboard`, {
      confirm,
      identity_hash: identityHash
    })
    .then((r) => r.data.data as OffboardRun)

export const retryOffboard = (id: number) =>
  api.post(`/hub/offboards/${id}/retry`, {}).then((r) => r.data.data as OffboardRun)

export const liftOffboard = (id: number, confirm: string) =>
  api.post(`/hub/offboards/${id}/lift`, { confirm }).then(
    (r) =>
      r.data.data as OffboardRun & {
        hub_account_reactivated?: boolean
        hub_account_note?: string
      }
  )

export function usePerson(key: string | null) {
  return useQuery({
    queryKey: peopleKeys.person(key ?? ''),
    queryFn: () => fetchPerson(key as string),
    enabled: !!key,
    // While a run is going, its results come in one environment at a time.
    refetchInterval: (q) =>
      q.state.data?.offboards.some((o) => o.status === 'running') ? 2000 : false
  })
}

/** Plain words for what one environment answered (an offboard, or a lookup). */
export const OUTCOME_COPY: Record<EnvOutcome, string> = {
  pending: 'Waiting',
  suspended: 'Suspended',
  already: 'Was suspended',
  none: 'No account',
  refused: 'Refused',
  no_link: 'No link',
  failed: 'Did not answer'
}

/** Plain words for the codes the people routes and the apps answer. */
export const PEOPLE_COPY: Record<string, { title: string; hint?: string }> = {
  CONFIRM_REQUIRED: {
    title: 'Type exactly what the page asks to confirm',
    hint: 'Exactly as shown on this page (case does not matter).'
  },
  OFFBOARD_RUNNING: {
    title: 'An offboard of this person is running',
    hint: 'Wait for it to finish, then retry what did not.'
  },
  OFFBOARD_SELF: {
    title: 'You cannot offboard yourself',
    hint: 'The list names your own Hub account, email or Microsoft id.'
  },
  EMAIL_OFFBOARDED: {
    title: 'This email belongs to an offboarded person',
    hint: 'Lift their block on the People page first if they are coming back.'
  },
  IDENTITY_SHARED: {
    title: 'The list names another person too',
    hint: 'An email or Microsoft id in it belongs to another Hub account (active, suspended or waiting); the apps would suspend them as well. Change that account’s email first.'
  },
  LAST_HUB_ADMIN: {
    title: 'This is the Hub’s last administrator',
    hint: 'Make someone else a Hub administrator first.'
  },
  IDENTITY_CHANGED: {
    title: 'What would be suspended changed',
    hint: 'The page shows the new list now. Check it, then confirm again.'
  },
  NO_IDENTITY: {
    title: 'The Hub knows no email or Entra id for this person',
    hint: 'There is nothing the apps could match them by.'
  },
  LAST_ADMIN: {
    title: 'Their last administrator',
    hint: 'This app has no other active administrator. Make someone else an administrator there, then retry.'
  },
  NO_LINK: {
    title: 'The Hub has no link to this environment',
    hint: 'Give the environment its hub token, or suspend the person in that app by hand.'
  },
  LINK_MISSING: {
    title: 'The app has no people link',
    hint: 'It runs a Nivaro version before 0.3.215, or no HUB_TOKEN is set there. Suspend the person in that app by hand.'
  },
  LINK_REFUSED: {
    title: 'The app refused the Hub',
    hint: 'Check the environment’s hub token (or the shared deployment’s token).'
  },
  LINK_UNREACHABLE: { title: 'The app did not answer', hint: 'Retry once it is back.' },
  TIMEOUT: { title: 'The app did not answer in time', hint: 'Retry once it is back.' },
  ENVIRONMENT_GONE: { title: 'The environment was removed since' }
}

export function peopleError(err: unknown, fallback: string): ErrorDescription {
  const d = describeError(err, fallback)
  const copy = d.code ? PEOPLE_COPY[d.code] : undefined
  if (!copy) return d
  const out: ErrorDescription = { ...d, title: copy.title }
  if (copy.hint) out.hint = copy.hint
  else delete out.hint
  return out
}

export function peopleToast(err: unknown, fallback: string) {
  const d = peopleError(err, fallback)
  toast.error(d.title, errorToastOptions(d))
}

/** A code an environment answered, in words (never the raw code alone). */
export const codeWords = (code: string | undefined): string | null =>
  code ? (PEOPLE_COPY[code]?.title ?? 'Could not finish') : null
