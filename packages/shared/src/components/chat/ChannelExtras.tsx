import { Check, History, Link2, Megaphone, Plus, UserPlus, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { cn, formatRelative } from '../../lib/utils'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { type ChannelMeta, useChannelAdmin, useChatRoles } from './chat-core'
import { useBulkInvite, useChannelAudit, useTeams } from './chat-hooks'

/**
 * The channel settings that go beyond name/topic/visibility: announce-only
 * (#935), a description and pinned links (#936), a welcome note (#961),
 * default roles (#960, admins only), bulk invite by team or role (#937) and
 * the channel's own change log (#975).
 */

interface Th {
  input: string
  action: string
  accentSoft: string
  accentText: string
  divider: string
}

function errorText(e: unknown, fallback: string): string {
  return (e as { response?: { error?: string } })?.response?.error ?? fallback
}

export function ChannelExtrasEditor({
  channel,
  th,
  isAdmin
}: {
  channel: ChannelMeta
  th: Th
  isAdmin: boolean
}) {
  const { update } = useChannelAdmin(channel.id)
  const roles = useChatRoles()
  const [announce, setAnnounce] = useState(!!channel.announce)
  const [description, setDescription] = useState(channel.description ?? '')
  const [links, setLinks] = useState<Array<{ label: string; url: string }>>(channel.links ?? [])
  const [welcome, setWelcome] = useState(channel.welcome_note ?? '')
  const [defaults, setDefaults] = useState<string[]>(
    (channel.default_roles ?? []).map((r) => String(r).toUpperCase())
  )
  const cleanLinks = links.filter((l) => l.url.trim())
  const dirty =
    announce !== !!channel.announce ||
    description !== (channel.description ?? '') ||
    welcome !== (channel.welcome_note ?? '') ||
    JSON.stringify(cleanLinks) !== JSON.stringify(channel.links ?? []) ||
    (isAdmin &&
      JSON.stringify([...defaults].sort()) !==
        JSON.stringify((channel.default_roles ?? []).map((r) => String(r).toUpperCase()).sort()))
  const save = () =>
    update.mutate(
      {
        announce,
        description: description.trim() || null,
        links: cleanLinks.map((l) => ({
          label: l.label.trim() || l.url.trim(),
          url: l.url.trim()
        })),
        welcome_note: welcome.trim() || null,
        ...(isAdmin ? { default_roles: defaults } : {})
      },
      {
        onSuccess: () => toast.success('Channel settings saved'),
        onError: (e) => toast.error(errorText(e, 'Could not save the channel settings'))
      }
    )
  const roleName = (id: string) =>
    roles.find((r) => String(r.id).toUpperCase() === id)?.name ?? 'Unknown role'

  return (
    <div className={cn('space-y-3 border-t pt-3', th.divider)} data-chat-channel-extras>
      <label className='flex items-start gap-2 text-[12px] text-slate-700 dark:text-slate-200'>
        <input
          type='checkbox'
          checked={announce}
          onChange={(e) => setAnnounce(e.target.checked)}
          className='mt-0.5'
          data-chat-channel-announce
        />
        <span>
          <span className='inline-flex items-center gap-1 font-medium'>
            <Megaphone className='h-3.5 w-3.5' /> Announcements only
          </span>
          <span className='block text-[11px] text-slate-500 dark:text-slate-400'>
            Only the channel owner and admins post. Everyone else can read, react and reply in
            threads.
          </span>
        </span>
      </label>

      <label className='block'>
        <span className='mb-1 block text-[11px] font-medium text-slate-400'>Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder='What people should know before posting here'
          className={cn(
            'w-full resize-none rounded-md px-2 py-1.5 text-[12.5px] outline-none',
            th.input
          )}
          data-chat-channel-description
        />
      </label>

      <div>
        <span className='mb-1 block text-[11px] font-medium text-slate-400'>Links</span>
        {links.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place and have no id
          <div key={i} className='mb-1 flex items-center gap-1'>
            <input
              value={l.label}
              onChange={(e) =>
                setLinks((ls) => ls.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
              }
              placeholder='Label'
              className={cn('h-7 w-[38%] rounded-md px-2 text-[12px] outline-none', th.input)}
              aria-label='Link label'
            />
            <input
              value={l.url}
              onChange={(e) =>
                setLinks((ls) => ls.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))
              }
              placeholder='https://… or /reports/…'
              className={cn(
                'h-7 min-w-0 flex-1 rounded-md px-2 text-[12px] outline-none',
                th.input
              )}
              aria-label='Link address'
            />
            <button
              type='button'
              onClick={() => setLinks((ls) => ls.filter((_, j) => j !== i))}
              className='rounded p-1 text-slate-400 hover:text-red-500'
              aria-label='Remove link'
            >
              <X className='h-3 w-3' />
            </button>
          </div>
        ))}
        {links.length < 10 && (
          <button
            type='button'
            onClick={() => setLinks((ls) => [...ls, { label: '', url: '' }])}
            className={cn(
              'inline-flex items-center gap-1 text-[11.5px] font-medium',
              th.accentText
            )}
            data-chat-channel-add-link
          >
            <Link2 className='h-3 w-3' /> Add a link
          </button>
        )}
      </div>

      <label className='block'>
        <span className='mb-1 block text-[11px] font-medium text-slate-400'>
          Welcome note — shown once to each new member
        </span>
        <textarea
          value={welcome}
          onChange={(e) => setWelcome(e.target.value)}
          rows={3}
          placeholder='Say hello, point people at the pinned messages, explain the ground rules'
          className={cn(
            'w-full resize-none rounded-md px-2 py-1.5 text-[12.5px] outline-none',
            th.input
          )}
          data-chat-channel-welcome
        />
      </label>

      {isAdmin && (
        <div>
          <span className='mb-1 block text-[11px] font-medium text-slate-400'>
            Join automatically — everyone with these roles
          </span>
          <div className='flex flex-wrap items-center gap-1'>
            {defaults.map((id) => (
              <span
                key={id}
                className={cn(
                  'inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11px]',
                  th.accentSoft
                )}
              >
                {roleName(id)}
                <button
                  type='button'
                  onClick={() => setDefaults((d) => d.filter((x) => x !== id))}
                  aria-label={`Remove ${roleName(id)}`}
                >
                  <X className='h-3 w-3' />
                </button>
              </span>
            ))}
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className='inline-flex h-6 items-center gap-1 rounded-full border border-slate-200 px-2 text-[11px] text-slate-600 hover:bg-muted dark:border-border dark:text-slate-300'
                  data-chat-channel-default-roles
                >
                  <Plus className='h-3 w-3' /> Role
                </button>
              </PopoverTrigger>
              <PopoverContent align='start' className='w-[240px] p-0'>
                <Command>
                  <CommandInput placeholder='Search roles…' />
                  <CommandList>
                    <CommandEmpty>No role found</CommandEmpty>
                    <CommandGroup>
                      {roles.map((r) => {
                        const id = String(r.id).toUpperCase()
                        const on = defaults.includes(id)
                        return (
                          <CommandItem
                            key={id}
                            value={r.name}
                            onSelect={() =>
                              setDefaults((d) => (on ? d.filter((x) => x !== id) : [...d, id]))
                            }
                          >
                            <Check
                              className={cn('mr-1.5 h-3.5 w-3.5', on ? 'opacity-100' : 'opacity-0')}
                            />
                            {r.name}
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          <p className='mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400'>
            People in these roles see the channel in their list the next time they open chat. They
            can still leave it.
          </p>
        </div>
      )}

      <button
        type='button'
        disabled={!dirty || update.isPending}
        onClick={save}
        className={cn(
          'rounded-md px-2.5 py-1 text-[12px] font-medium disabled:opacity-40',
          th.action
        )}
        data-chat-channel-extras-save
      >
        {update.isPending ? 'Saving…' : 'Save these settings'}
      </button>
    </div>
  )
}

/** Add a whole team or role at once, with a count before anything happens. */
export function BulkInvitePanel({ channelId, th }: { channelId: number; th: Th }) {
  const [open, setOpen] = useState(false)
  const teams = useTeams(open)
  const roles = useChatRoles()
  const invite = useBulkInvite(channelId)
  const [source, setSource] = useState<
    | { kind: 'team'; id: string | number; name: string }
    | { kind: 'role'; id: string; name: string }
    | null
  >(null)
  const [preview, setPreview] = useState<{ would_add: number; skipped: number } | null>(null)
  const body = (s: NonNullable<typeof source>) =>
    s.kind === 'team' ? { team_id: s.id } : { role_id: s.id }
  const pick = (s: NonNullable<typeof source>) => {
    setSource(s)
    setPreview(null)
    invite.mutate(
      { ...body(s), dry_run: true },
      {
        onSuccess: (d) => setPreview({ would_add: d.would_add ?? 0, skipped: d.skipped }),
        onError: (e) => toast.error(errorText(e, 'Could not count who that would add'))
      }
    )
  }
  return (
    <div data-chat-bulk-invite>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            className={cn(
              'inline-flex items-center gap-1 text-[11.5px] font-medium',
              th.accentText
            )}
          >
            <UserPlus className='h-3.5 w-3.5' /> Add a team or role
          </button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-[260px] p-0'>
          <Command>
            <CommandInput placeholder='Search teams and roles…' />
            <CommandList>
              <CommandEmpty>Nothing found</CommandEmpty>
              {teams.length > 0 && (
                <CommandGroup heading='Teams'>
                  {teams.map((t) => (
                    <CommandItem
                      key={`t${t.id}`}
                      value={`team ${t.name}`}
                      onSelect={() => {
                        setOpen(false)
                        pick({ kind: 'team', id: t.id, name: t.name })
                      }}
                    >
                      {t.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              <CommandGroup heading='Roles'>
                {roles.map((r) => (
                  <CommandItem
                    key={`r${r.id}`}
                    value={`role ${r.name}`}
                    onSelect={() => {
                      setOpen(false)
                      pick({ kind: 'role', id: String(r.id), name: r.name })
                    }}
                  >
                    {r.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {source && (
        <div className={cn('mt-1.5 rounded-lg border p-2 text-[12px]', th.divider)}>
          {!preview ? (
            <p className='text-slate-500'>Counting the people in {source.name}…</p>
          ) : preview.would_add === 0 ? (
            <p className='text-slate-600 dark:text-slate-300'>
              Everyone in {source.name} is already here
              {preview.skipped ? ` (${preview.skipped} skipped)` : ''}.
            </p>
          ) : (
            <>
              <p className='text-slate-700 dark:text-slate-200'>
                Adds {preview.would_add} {preview.would_add === 1 ? 'person' : 'people'} from{' '}
                {source.name}
                {preview.skipped ? ` · ${preview.skipped} already here or inactive` : ''}.
              </p>
              <div className='mt-1.5 flex gap-1.5'>
                <button
                  type='button'
                  disabled={invite.isPending}
                  onClick={() =>
                    invite.mutate(body(source), {
                      onSuccess: (d) => {
                        toast.success(`Added ${d.added ?? 0} to the channel`)
                        setSource(null)
                        setPreview(null)
                      },
                      onError: (e) => toast.error(errorText(e, 'Could not add them'))
                    })
                  }
                  className={cn('h-7 rounded-md px-2 text-[11.5px] font-medium', th.action)}
                  data-chat-bulk-invite-confirm
                >
                  Add {preview.would_add}
                </button>
                <button
                  type='button'
                  onClick={() => {
                    setSource(null)
                    setPreview(null)
                  }}
                  className='h-7 rounded-md px-2 text-[11.5px] text-slate-600 hover:bg-muted dark:text-slate-300'
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

const AUDIT_LABELS: Record<string, string> = {
  'chat-channel-create': 'created the channel',
  'chat-channel-update': 'changed settings',
  'chat-channel-join': 'joined',
  'chat-channel-leave': 'left',
  'chat-channel-member-add': 'added a member',
  'chat-channel-member-remove': 'removed a member',
  'chat-channel-bulk-invite': 'added a group of people',
  'chat-message-delete': 'deleted a message'
}

export function ChannelAuditLog({ channelId, th }: { channelId: number; th: Th }) {
  const [open, setOpen] = useState(false)
  const { rows, loading } = useChannelAudit(channelId, open)
  return (
    <div data-chat-channel-audit>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className='inline-flex items-center gap-1 text-[11.5px] font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
      >
        <History className='h-3.5 w-3.5' /> {open ? 'Hide channel history' : 'Channel history'}
      </button>
      {open && (
        <div className={cn('mt-1.5 max-h-60 overflow-y-auto rounded-lg border', th.divider)}>
          {loading ? (
            <p className='p-2 text-[11.5px] text-slate-500'>Loading…</p>
          ) : rows.length === 0 ? (
            <p className='p-2 text-[11.5px] text-slate-500'>No changes recorded yet.</p>
          ) : (
            rows.map((r) => (
              <div
                key={r.id}
                className={cn('border-b px-2 py-1.5 text-[11.5px] last:border-b-0', th.divider)}
              >
                <p className='text-slate-700 dark:text-slate-200'>
                  <span className='font-medium'>{r.user_name ?? 'Someone'}</span>{' '}
                  {AUDIT_LABELS[r.action] ?? r.action.replace(/^chat-/, '').replace(/-/g, ' ')}
                  <span className='ml-1 text-slate-400'>· {formatRelative(r.at)}</span>
                </p>
                {r.comment && (
                  <p className='truncate text-[11px] text-slate-500 dark:text-slate-400'>
                    {r.comment}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
