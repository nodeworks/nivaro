import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'

/** Mirror of the server's PersonProfile (services/user-profile.ts). */
export interface PersonRef {
  id: string
  name: string
  email: string | null
  title?: string | null
  is_out_of_office?: boolean
  ooo_end?: string | null
}

export interface PersonProfile {
  id: string
  first_name: string | null
  last_name: string | null
  name: string
  email: string
  title: string | null
  department: string | null
  company: string | null
  phone: string | null
  office_location: string | null
  status: string
  role_id: string | null
  role_name: string | null
  role_admin: boolean
  is_out_of_office: boolean
  ooo_start: string | null
  ooo_end: string | null
  delegate: (PersonRef & { expires_at: string | null }) | null
  manager: PersonRef | null
  direct_reports: PersonRef[]
  covers_for: PersonRef[]
  custom_status: { text: string; emoji?: string | null; expires_at?: string | null } | null
  timezone: string | null
  last_access: string | null
  created_at: string | null
  presence: { online: boolean; idle_minutes: number | null; last_seen: string | null }
  teams: Array<{ id: number; name: string; slug: string | null; member_count: number }>
  seats: Array<{
    template_id: string
    template_name: string
    states: Array<{ key: string; label: string; groups: number }>
  }>
  seat_count: number
  scopes: Array<{ dimension: string; label: string; values: string[] }>
  open_tasks: number
  admin: {
    account_kind: string | null
    city: string | null
    state: string | null
    country: string | null
    employee_id: string | null
    external_id: boolean
    directory_status: string | null
    directory_checked_at: string | null
    has_static_token: boolean
    is_redacted: boolean
    link_app: string | null
    current_path: string | null
    sessions: number
    activity_30d: number
    logins: Array<{ at: string; method: string; ip: string | null; new_ip: boolean }>
  } | null
}

export const PERSON_PROFILE_KEY = 'nvr-person-profile'

export function usePersonProfile(userId: string | null | undefined) {
  const client = useNivaroClient()
  return useQuery<PersonProfile | null>({
    queryKey: [PERSON_PROFILE_KEY, userId],
    queryFn: () =>
      client
        .request<{ data: PersonProfile }>(
          get(`/users/${encodeURIComponent(String(userId))}/profile`)
        )
        .then((r) => r.data),
    enabled: !!userId,
    staleTime: 30_000
  })
}

/** After any write that changes what the page shows. */
export function useInvalidatePerson(userId: string | null | undefined) {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: [PERSON_PROFILE_KEY, userId] })
    void qc.invalidateQueries({ queryKey: ['nvr-profile-user'] })
    void qc.invalidateQueries({ queryKey: ['nvr-profile-card'] })
    void qc.invalidateQueries({ queryKey: ['user', userId] })
    void qc.invalidateQueries({ queryKey: ['users'] })
    void qc.invalidateQueries({ queryKey: ['user-avatar', userId] })
  }
}

/** The error message an API rejection carries, for a toast. */
export function errorText(err: unknown, fallback: string): string {
  const e = err as {
    response?: { data?: { error?: string }; error?: string }
    message?: string
  }
  return e?.response?.data?.error ?? e?.response?.error ?? e?.message ?? fallback
}
