import { Building2, Clock, Eye, Mail, MapPin, MessageSquare, Phone, Video } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { cn, formatRelative } from '../../lib/utils'
import { canViewAs, viewAs } from '../../lib/view-as'
import { canOpenDm, openDmWith } from '../chat/chat-core'
import { UserAvatar } from '../UserAvatar'
import { BestTimeChip } from './BestTime'
import { NotifyButton } from './PersonExtras'
import { PersonChip, Pill, personInitials } from './primitives'
import type { PersonProfile } from './types'

/**
 * The identity band at the top of someone's page: who they are, whether
 * they are reachable right now, and the three ways to reach them. Admin-only
 * facts (account kind, directory verdict) ride as extra pills — the band is
 * the one place both viewers read first, so it must be honest at a glance.
 */
export function PersonHeader({
  profile: p,
  isAdmin
}: {
  profile: PersonProfile
  isAdmin: boolean
}) {
  const online = p.presence.online
  const idle = online && (p.presence.idle_minutes ?? 0) >= 5
  const statusTone =
    p.status === 'active' ? 'green' : p.status === 'suspended' ? 'red' : ('neutral' as const)
  const oooUntil = p.ooo_end
    ? new Date(p.ooo_end).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null
  const dm = canOpenDm()

  return (
    <div
      data-person-header={p.id}
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <div className='flex flex-wrap items-start gap-x-5 gap-y-4 p-5'>
        <div className='relative shrink-0'>
          <UserAvatar
            userId={p.id}
            alt={p.name}
            className='h-[76px] w-[76px] rounded-full border border-slate-200 object-cover dark:border-border'
            fallback={
              <span className='flex h-[76px] w-[76px] items-center justify-center rounded-full bg-[#c7f0fb] text-[24px] font-semibold text-[#04516b] dark:bg-nvr-cyan/15 dark:text-nvr-cyan'>
                {personInitials(p)}
              </span>
            }
          />
          <span
            data-person-presence={online ? (idle ? 'idle' : 'online') : 'offline'}
            className={cn(
              'absolute bottom-0.5 right-0.5 h-3.5 w-3.5 rounded-full border-2 border-white dark:border-card',
              online ? (idle ? 'bg-amber-400' : 'bg-emerald-500') : 'bg-slate-300 dark:bg-slate-600'
            )}
            title={
              online ? (idle ? `Idle · ${p.presence.idle_minutes}m` : 'Online now') : 'Offline'
            }
          />
        </div>

        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-center gap-2'>
            <h1 className='text-[21px] font-semibold tracking-[-0.015em] text-slate-900 dark:text-white'>
              {p.name}
            </h1>
            {p.role_name && (
              <Pill tone='brand' testId='role'>
                {p.role_name}
              </Pill>
            )}
            {p.status !== 'active' && (
              <Pill tone={statusTone} testId='status'>
                {p.status === 'suspended' ? 'Suspended' : p.status}
              </Pill>
            )}
            {p.admin?.is_redacted && (
              <Pill tone='red' testId='redacted'>
                Redacted
              </Pill>
            )}
            {p.is_out_of_office && (
              <Pill tone='amber' testId='ooo'>
                Out of office{oooUntil ? ` until ${oooUntil}` : ''}
              </Pill>
            )}
            {isAdmin && p.admin?.account_kind && (
              <Pill tone='violet' testId='account-kind'>
                {p.admin.account_kind}
              </Pill>
            )}
            {isAdmin &&
              (p.admin?.directory_status === 'missing' ||
                p.admin?.directory_status === 'disabled') && (
                <Pill tone='red' testId='directory'>
                  {p.admin.directory_status === 'missing'
                    ? 'Not in the directory'
                    : 'Disabled in the directory'}
                </Pill>
              )}
          </div>

          {p.custom_status && (
            <p
              data-person-custom-status
              className='mt-1 text-[13px] text-slate-600 dark:text-slate-300'
            >
              {p.custom_status.emoji && <span className='mr-1'>{p.custom_status.emoji}</span>}
              {p.custom_status.text}
            </p>
          )}

          {(p.title || p.department || p.company) && (
            <p className='mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[13px] text-slate-500 dark:text-slate-400'>
              {[p.title, p.department, p.company ? null : null]
                .filter((v): v is string => !!v)
                .map((v, i) => (
                  <span key={v} className='inline-flex items-center gap-1.5'>
                    {i > 0 && <span aria-hidden>·</span>}
                    {v}
                  </span>
                ))}
              {p.company && (
                <span className='inline-flex items-center gap-1.5'>
                  {(p.title || p.department) && <span aria-hidden>·</span>}
                  <Building2 className='h-3.5 w-3.5 shrink-0' aria-hidden />
                  {p.company}
                </span>
              )}
            </p>
          )}

          <div className='mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-slate-500 dark:text-slate-400'>
            <a
              href={`mailto:${p.email}`}
              className='inline-flex items-center gap-1.5 transition-colors hover:text-nvr-navy dark:hover:text-nvr-cyan'
            >
              <Mail className='h-3.5 w-3.5' /> {p.email}
            </a>
            {p.phone && (
              <a
                href={`tel:${p.phone}`}
                className='inline-flex items-center gap-1.5 transition-colors hover:text-nvr-navy dark:hover:text-nvr-cyan'
              >
                <Phone className='h-3.5 w-3.5' /> {p.phone}
              </a>
            )}
            {p.office_location && (
              <span className='inline-flex items-center gap-1.5'>
                <MapPin className='h-3.5 w-3.5' /> {p.office_location}
              </span>
            )}
            <span className='inline-flex items-center gap-1.5' data-person-last-seen>
              <Clock className='h-3.5 w-3.5' />
              {online
                ? idle
                  ? `Online · idle ${p.presence.idle_minutes}m`
                  : 'Online now'
                : p.last_access
                  ? `Last active ${formatRelative(p.last_access)}`
                  : 'Never signed in'}
            </span>
          </div>

          <BestTimeChip profile={p} />

          {p.manager ? (
            <div className='mt-2 flex items-center gap-2 text-[12px] text-slate-500 dark:text-slate-400'>
              <span>Reports to</span>
              <PersonChip person={p.manager} />
            </div>
          ) : p.manager_external ? (
            <div
              className='mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-slate-500 dark:text-slate-400'
              data-person-manager-external
            >
              <span>Reports to</span>
              {p.manager_external.email ? (
                <a
                  href={`mailto:${p.manager_external.email}`}
                  className='font-medium text-slate-700 hover:underline dark:text-slate-200'
                >
                  {p.manager_external.name ?? p.manager_external.email}
                </a>
              ) : (
                <span className='font-medium text-slate-700 dark:text-slate-200'>
                  {p.manager_external.name}
                </span>
              )}
              <span className='text-[11px] text-slate-400'>· not a Nivaro user</span>
            </div>
          ) : null}
        </div>

        {/* Reach out — the three doors, always in the same place. */}
        <div className='flex shrink-0 flex-wrap items-center gap-2 self-start' data-person-actions>
          {isAdmin && <NotifyButton profile={p} />}
          {isAdmin && canViewAs() && p.status === 'active' && !p.admin?.is_redacted && (
            <ViewAsButton profile={p} />
          )}
          <a
            href={`mailto:${p.email}`}
            className='inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          >
            <Mail className='h-3.5 w-3.5' /> Email
          </a>
          {dm && (
            <button
              type='button'
              data-person-message
              onClick={() => openDmWith(p.id, p.name)}
              className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-[12px] font-medium text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-border dark:text-slate-300 dark:hover:bg-muted'
            >
              <MessageSquare className='h-3.5 w-3.5' /> Message
            </button>
          )}
          <a
            href={`https://teams.microsoft.com/l/call/0/0?users=${encodeURIComponent(p.email)}`}
            target='_blank'
            rel='noreferrer'
            className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-[12px] font-medium text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-border dark:text-slate-300 dark:hover:bg-muted'
          >
            <Video className='h-3.5 w-3.5' /> Teams call
          </a>
        </div>
      </div>
    </div>
  )
}

/**
 * #640 — open the app as this person in a new tab. The host decides how
 * (the admin mints a masquerade token that lives only in that tab); the
 * request is activity-logged server-side under the admin's name.
 */
function ViewAsButton({ profile: p }: { profile: PersonProfile }) {
  const [busy, setBusy] = useState(false)
  const first = p.first_name ?? p.name
  return (
    <button
      type='button'
      data-person-view-as
      disabled={busy}
      data-tip={`See the app exactly as ${first} does. Recorded in the activity log under your name.`}
      onClick={async () => {
        setBusy(true)
        try {
          await viewAs({ id: p.id, name: p.name })
        } catch (err) {
          toast.error((err as Error)?.message || `Could not open the app as ${first}`)
        } finally {
          setBusy(false)
        }
      }}
      className='inline-flex h-8 items-center gap-1.5 rounded-md border border-amber-300 px-3 text-[12px] font-medium text-amber-800 transition-colors hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 dark:border-amber-500/40 dark:text-amber-200 dark:hover:bg-amber-500/10'
    >
      <Eye className='h-3.5 w-3.5' /> View as
    </button>
  )
}
