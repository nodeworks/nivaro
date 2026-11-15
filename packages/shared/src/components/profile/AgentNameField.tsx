import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, Loader2, Pencil } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { patch } from '../../lib/commands'
import { userErrorMessage } from '../../lib/safe-error'
import { cn } from '../../lib/utils'

/** Longest agent name the server keeps (api services/mcp-calls.ts AGENT_NAME_MAX). */
export const AGENT_NAME_MAX = 40

/**
 * The name an AI agent goes by (rt8 #21), edited in place: what a record shows while it works
 * ("Claude (for Rob) is updating this record"), its badge on changes and notifications. The
 * connection's owner edits theirs from Profile → What my agents did (`scope='mine'`); an
 * administrator edits anyone's from MCP connections (`scope='admin'`). Clearing it goes back to
 * the app's own name. Plain text, ≤ 40 characters.
 */
export function AgentNameField({
  conn,
  displayName,
  customName,
  appName,
  forName,
  scope,
  trailing,
  className
}: {
  /** Beside the name while it is not being edited: the kind pill. */
  trailing?: ReactNode
  conn: string
  /** What it goes by now. */
  displayName: string
  /** The chosen name, when one is set. */
  customName: string | null | undefined
  /** The app's own name (the default). */
  appName: string
  /** Who it acts for, as the preview names them ("you" on the person's own page). */
  forName: string
  scope: 'mine' | 'admin'
  className?: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(displayName)
  const inputRef = useRef<HTMLInputElement>(null)
  const hintId = useId()
  useEffect(() => {
    const el = inputRef.current
    if (!editing || !el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])
  const save = useMutation({
    mutationFn: (name: string | null) =>
      client.request(
        patch(
          scope === 'mine'
            ? `/mcp-connections/mine/${encodeURIComponent(conn)}/name`
            : `/mcp-connections/${encodeURIComponent(conn)}/name`,
          { name }
        )
      ),
    onSuccess: () => {
      setEditing(false)
      void qc.invalidateQueries({ queryKey: ['nvr-mcp-connections'] })
    }
  })
  const trimmed = value.trim()
  const unchanged = trimmed === displayName
  const start = () => {
    setValue(displayName)
    save.reset()
    setEditing(true)
  }
  const cancel = () => {
    setEditing(false)
    save.reset()
  }

  if (!editing)
    return (
      <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
        <span
          className='truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100'
          data-tip={
            customName ? `Named by its owner or an administrator · app: ${appName}` : undefined
          }
        >
          {displayName}
        </span>
        <button
          type='button'
          onClick={start}
          aria-label={`Rename ${displayName}`}
          data-tip='Rename — the name records and notifications show for this agent'
          className='inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-muted hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:text-slate-500 dark:hover:text-slate-200'
        >
          <Pencil className='h-3.5 w-3.5' aria-hidden />
        </button>
        {trailing}
      </span>
    )

  const preview = trimmed || appName
  return (
    <form
      className={cn('flex w-full min-w-0 flex-col gap-1', className)}
      data-nvr-agent-name-edit
      onSubmit={(e) => {
        e.preventDefault()
        if (unchanged || !trimmed) return
        save.mutate(trimmed)
      }}
    >
      <div className='flex flex-wrap items-center gap-1.5'>
        <input
          ref={inputRef}
          value={value}
          maxLength={AGENT_NAME_MAX}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              cancel()
            }
          }}
          aria-label='Agent name'
          aria-describedby={hintId}
          className='h-8 w-48 min-w-0 rounded-md border border-slate-200 bg-white px-2 text-[13px] text-slate-800 outline-none transition-colors focus:border-nvr-cyan focus-visible:ring-2 focus-visible:ring-nvr-cyan/25 dark:border-border dark:bg-background dark:text-slate-100'
        />
        <button
          type='submit'
          disabled={unchanged || !trimmed || save.isPending}
          className='inline-flex h-8 items-center gap-1 rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-nvr-cyan/90 disabled:opacity-40'
        >
          {save.isPending ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden />
          ) : (
            <Check className='h-3.5 w-3.5' aria-hidden />
          )}
          Save
        </button>
        <button
          type='button'
          onClick={cancel}
          className='h-8 rounded-md px-2 text-[12px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
        >
          Cancel
        </button>
        {customName && (
          <button
            type='button'
            disabled={save.isPending}
            onClick={() => save.mutate(null)}
            className='h-8 rounded-md px-2 text-[12px] font-medium text-slate-500 underline-offset-2 transition-colors hover:text-slate-800 hover:underline disabled:opacity-40 dark:text-slate-400 dark:hover:text-slate-100'
          >
            Use “{appName}”
          </button>
        )}
      </div>
      <p id={hintId} className='text-[11.5px] leading-snug text-slate-500 dark:text-slate-400'>
        Records it works on show “
        <span className='font-medium text-slate-700 dark:text-slate-200'>{preview}</span> (for{' '}
        {forName}) is updating this record”.
        {save.isError && (
          <span role='alert' className='ml-1 text-red-600 dark:text-red-400'>
            {userErrorMessage(save.error, 'The name could not be saved')}
          </span>
        )}
      </p>
    </form>
  )
}
