import { useQuery } from '@tanstack/react-query'
import { Bell, BellRing, Copy, Crosshair, Link2, MessageSquare, Share2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { cn } from '../../../lib/utils'
import { Popover, PopoverContent } from '../../ui/popover'
import { SimpleSelect } from '../../ui/SimpleSelect'
import type { DescribeField } from '../overview/describe-conditions'
import { apiFailure } from '../overview/overview-api'
import { ToolButton } from '../toolbar-kit'
import {
  type PersonRef,
  type PreviewCommentRow,
  previewUrl,
  useCollabActions,
  useLayoutCollab,
  usePreviewComments,
  usePreviewLinks
} from './collab-api'

// The top bar's Watch toggle and Share popover (#2655 #2656 #2666): who owns the form,
// who watches it, read-only preview links for people who are not administrators, and the
// comments those people pinned to fields.

const smallBtn =
  'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 disabled:opacity-40 dark:text-muted-foreground dark:hover:text-foreground'
const heading = 'text-[12px] font-semibold text-slate-700 dark:text-foreground'
const hint = 'text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'

const fmtDate = (v: string | null) =>
  v ? new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''

function fail(err: unknown, fallback: string) {
  toast.error(apiFailure(err, fallback).message)
}

export function WatchButton({ layoutId }: { layoutId: number }) {
  const { data } = useLayoutCollab(layoutId)
  const actions = useCollabActions(layoutId)
  const [busy, setBusy] = useState(false)
  const watching = !!data?.watching
  return (
    <ToolButton
      label='Watch this form'
      ariaLabel={watching ? 'Stop watching this form' : 'Watch this form'}
      icon={watching ? <BellRing className='h-4 w-4' /> : <Bell className='h-4 w-4' />}
      hint='Hear when someone saves a change'
      iconOnly
      checked={watching}
      disabled={busy}
      className={cn(watching && 'text-[#0089ad] dark:text-nvr-cyan')}
      tip={
        watching
          ? 'Watching: you hear when someone saves a change. Click to stop'
          : 'Watch: hear when someone saves a change to this form'
      }
      data={{ 'data-form-watch': '' }}
      onClick={async () => {
        setBusy(true)
        try {
          await actions.setWatch(!watching)
        } catch (err) {
          fail(err, 'Could not change the watch')
        } finally {
          setBusy(false)
        }
      }}
    />
  )
}

function OwnerPicker({ layoutId, owner }: { layoutId: number; owner: PersonRef | null }) {
  const client = useNivaroClient()
  const actions = useCollabActions(layoutId)
  const [picking, setPicking] = useState(false)
  const [search, setSearch] = useState('')
  const { data: people = [] } = useQuery<
    Array<{ id: string; first_name: string | null; last_name: string | null; email: string }>
  >({
    queryKey: ['layout-editor', 'collab', 'people', search],
    queryFn: () =>
      client
        .request<{ data: never }>(get('/users', { search, limit: 6, people: '1' }))
        .then((r) => (r.data ?? []) as never),
    enabled: picking && search.trim().length > 1
  })
  const pick = async (userId: string | null) => {
    try {
      await actions.setOwner(userId)
      setPicking(false)
      setSearch('')
    } catch (err) {
      fail(err, 'Could not change the owner')
    }
  }
  if (!picking)
    return (
      <div className='flex items-center gap-2'>
        <span
          data-form-owner=''
          className={cn(
            'min-w-0 flex-1 truncate text-[12.5px]',
            owner
              ? 'text-slate-800 dark:text-foreground'
              : 'text-slate-400 dark:text-muted-foreground'
          )}
        >
          {owner?.name ?? 'No owner yet'}
        </span>
        <button type='button' className={smallBtn} onClick={() => setPicking(true)}>
          {owner ? 'Change' : 'Name an owner'}
        </button>
        {owner && (
          <button type='button' className={smallBtn} onClick={() => void pick(null)}>
            Clear
          </button>
        )}
      </div>
    )
  return (
    <div>
      <input
        // biome-ignore lint/a11y/noAutofocus: the person picker opens to type a name
        autoFocus
        aria-label='Find a person'
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setPicking(false)}
        placeholder='Type a name or email'
        className='h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] outline-none placeholder:text-slate-400 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'
      />
      {search.trim().length > 1 && (
        <div className='mt-1 overflow-hidden rounded-md border border-slate-200 dark:border-border'>
          {people.length === 0 ? (
            <div className={cn(hint, 'px-2.5 py-1.5')}>No one matches</div>
          ) : (
            people.map((u) => {
              const name = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email
              return (
                <button
                  key={u.id}
                  type='button'
                  onClick={() => void pick(u.id)}
                  className='block w-full px-2.5 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-foreground'
                >
                  {name}
                  <span className='ml-1.5 text-[11px] text-slate-400 dark:text-muted-foreground'>
                    {u.email}
                  </span>
                </button>
              )
            })
          )}
        </div>
      )}
      <button type='button' className={cn(smallBtn, 'mt-1')} onClick={() => setPicking(false)}>
        Cancel
      </button>
    </div>
  )
}

function PreviewLinks({ layoutId, open }: { layoutId: number; open: boolean }) {
  const { data: links = [] } = usePreviewLinks(layoutId, open)
  const actions = useCollabActions(layoutId)
  const [days, setDays] = useState('14')
  const [creating, setCreating] = useState(false)
  const [confirmOff, setConfirmOff] = useState<string | null>(null)
  const copy = async (path: string) => {
    try {
      await navigator.clipboard.writeText(previewUrl(path))
      toast.success('Link copied')
    } catch {
      toast.error('Could not copy — select the link and copy it')
    }
  }
  return (
    <div className='space-y-2'>
      <p className={hint}>
        Anyone with the link can read this form’s layout (never record data) and comment on its
        fields. It shows the last saved version, as you see it.
      </p>
      <div className='flex items-center gap-2'>
        <SimpleSelect
          value={days}
          onChange={setDays}
          ariaLabel='Link lasts'
          className='h-8 w-[120px] text-[12.5px]'
          options={[
            { value: '7', label: '7 days' },
            { value: '14', label: '14 days' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' }
          ]}
        />
        <button
          type='button'
          disabled={creating}
          className='inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50'
          onClick={async () => {
            setCreating(true)
            try {
              const link = await actions.createLink(Number(days))
              if (link?.path) await copy(link.path)
            } catch (err) {
              fail(err, 'Could not create the link')
            } finally {
              setCreating(false)
            }
          }}
        >
          <Link2 className='h-3.5 w-3.5' />
          Create link
        </button>
      </div>
      {links.map((l) => (
        <div
          key={l.id}
          data-preview-link={l.id}
          className='rounded-md border border-slate-200 px-2.5 py-1.5 dark:border-border'
        >
          <div className='truncate font-mono text-[11.5px] text-slate-600 dark:text-muted-foreground'>
            {previewUrl(l.path)}
          </div>
          <div className='mt-1 flex flex-wrap items-center gap-x-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            <span>until {fmtDate(l.expires_at)}</span>
            <span>
              · {l.view_count} {l.view_count === 1 ? 'view' : 'views'}
            </span>
            <span>
              · {l.comments} {l.comments === 1 ? 'comment' : 'comments'}
            </span>
            <span className='flex-1' />
            <button type='button' className={smallBtn} onClick={() => void copy(l.path)}>
              <Copy className='h-3 w-3' />
              Copy
            </button>
            {confirmOff === l.id ? (
              <button
                type='button'
                className={cn(smallBtn, 'text-red-600 dark:text-red-400')}
                onClick={async () => {
                  try {
                    await actions.revokeLink(l.id)
                  } catch (err) {
                    fail(err, 'Could not turn the link off')
                  }
                  setConfirmOff(null)
                }}
              >
                Turn off for everyone
              </button>
            ) : (
              <button type='button' className={smallBtn} onClick={() => setConfirmOff(l.id)}>
                Turn off
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function CommentList({
  layoutId,
  comments,
  fieldLabel,
  onSelectField
}: {
  layoutId: number
  comments: PreviewCommentRow[]
  fieldLabel: (field: string) => string
  onSelectField?: (field: string) => void
}) {
  const actions = useCollabActions(layoutId)
  if (comments.length === 0)
    return <p className={hint}>No comments yet. People with a preview link leave them here.</p>
  return (
    <ul className='space-y-1.5'>
      {comments.map((c) => (
        <li
          key={c.id}
          data-preview-comment={c.id}
          className='rounded-md bg-slate-50 px-2.5 py-1.5 dark:bg-muted/40'
        >
          <div className='flex items-center gap-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            <span className='min-w-0 truncate font-semibold text-slate-700 dark:text-foreground'>
              {c.field ? fieldLabel(c.field) : 'Whole form'}
            </span>
            <span className='shrink-0'>
              · {c.name} · {fmtDate(c.at)}
            </span>
            <span className='flex-1' />
            {c.field && onSelectField && (
              <button
                type='button'
                aria-label='Select this field'
                data-tip='Select this field on the canvas'
                className={smallBtn}
                onClick={() => onSelectField(c.field as string)}
              >
                <Crosshair className='h-3 w-3' />
              </button>
            )}
            <button
              type='button'
              aria-label='Resolve comment'
              data-tip='Resolve: remove the comment'
              className={smallBtn}
              onClick={async () => {
                try {
                  await actions.resolveComment(c.id)
                } catch (err) {
                  fail(err, 'Could not resolve the comment')
                }
              }}
            >
              <X className='h-3 w-3' />
            </button>
          </div>
          <p className='mt-0.5 whitespace-pre-wrap break-words text-[12.5px] text-slate-800 dark:text-foreground'>
            {c.text}
          </p>
        </li>
      ))}
    </ul>
  )
}

export function ShareButton({
  layoutId,
  fields,
  onSelectField
}: {
  layoutId: number
  fields: DescribeField[]
  onSelectField?: (field: string) => void
}) {
  const [open, setOpen] = useState(false)
  const { data: collab } = useLayoutCollab(layoutId)
  const { data: comments = [] } = usePreviewComments(layoutId)
  const fieldLabel = (f: string) => fields.find((x) => x.field === f)?.label || f
  const others = (collab?.watchers ?? []).filter((w) => w.id !== collab?.owner?.id)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ToolButton
        popover
        onOpen={() => setOpen(true)}
        label='Share & watchers'
        ariaLabel='Share'
        icon={<Share2 className='h-3.5 w-3.5' />}
        tip='Owner, watchers, preview links and comments'
        hint='Owner, watchers, preview links, comments'
        badge={comments.length || undefined}
        data={{ 'data-form-share': '' }}
        trailing={
          comments.length > 0 && (
            <span
              data-preview-comment-count=''
              className='inline-flex h-4 min-w-4 items-center justify-center gap-0.5 rounded-full bg-nvr-cyan/15 px-1 text-[10.5px] font-semibold text-[#0089ad] dark:text-nvr-cyan'
            >
              <MessageSquare className='h-2.5 w-2.5' />
              {comments.length}
            </span>
          )
        }
      />
      <PopoverContent
        align='end'
        className='max-h-[min(75vh,620px)] w-[400px] space-y-4 overflow-y-auto overscroll-contain p-3'
      >
        <section className='space-y-1.5'>
          <h3 className={heading}>Owner</h3>
          <OwnerPicker layoutId={layoutId} owner={collab?.owner ?? null} />
          <p className={hint}>
            The business owner hears first about change requests and every saved change.
          </p>
        </section>
        <section className='space-y-1'>
          <h3 className={heading}>Watching</h3>
          <p className={hint}>
            {others.length === 0
              ? 'No one else watches this form. Use the bell to watch it yourself.'
              : others.map((w) => w.name).join(', ')}
          </p>
        </section>
        <section className='space-y-1.5'>
          <h3 className={heading}>Preview link</h3>
          <PreviewLinks layoutId={layoutId} open={open} />
        </section>
        <section className='space-y-1.5'>
          <h3 className={heading}>Comments from previews</h3>
          <CommentList
            layoutId={layoutId}
            comments={comments}
            fieldLabel={fieldLabel}
            onSelectField={
              onSelectField
                ? (f) => {
                    onSelectField(f)
                    setOpen(false)
                  }
                : undefined
            }
          />
        </section>
      </PopoverContent>
    </Popover>
  )
}
