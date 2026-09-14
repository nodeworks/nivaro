import { type Command, markNotificationRead } from '@nivaro/sdk'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import type { NotificationActionSpec } from '../../lib/notification-target'

/**
 * The inline action pills a notification row offers (server-described:
 * endpoint + body, domain-blind). One-click actions fire straight away;
 * actions carrying `input` (Reply, Comment on this) open an inline text box
 * under the row and send its value as body[field]. Marks the row read when
 * the action says so, then invalidates the notification queries.
 */
export interface NotificationActionsProps {
  actions: NotificationActionSpec[]
  notificationId: number
  /** Called after any successful action (hosts refresh their own lists). */
  onDone?: () => void
  onError?: (message: string) => void
  size?: 'sm' | 'xs'
  className?: string
}

export function NotificationActions({
  actions,
  notificationId,
  onDone,
  onError,
  size = 'xs',
  className
}: NotificationActionsProps) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (openKey) inputRef.current?.focus()
  }, [openKey])

  const run = useMutation({
    mutationFn: async ({ action, value }: { action: NotificationActionSpec; value?: string }) => {
      const body: Record<string, unknown> = { ...(action.body ?? {}) }
      if (action.input) body[action.input.field] = value ?? ''
      const command: Command<unknown> = {
        _method: action.method,
        _path: action.endpoint,
        _body: body
      }
      await client.request(command)
      if (action.mark_read)
        await client.request(markNotificationRead(notificationId)).catch(() => {})
    },
    onSuccess: () => {
      setOpenKey(null)
      setText('')
      void qc.invalidateQueries({ queryKey: ['notifications'] })
      void qc.invalidateQueries({ queryKey: ['notification-count'] })
      onDone?.()
    },
    onError: (e) => {
      const msg =
        (e as { response?: { error?: string }; message?: string })?.response?.error ??
        (e as Error)?.message ??
        'Action failed'
      onError?.(msg)
    }
  })

  if (actions.length === 0) return null
  const pill =
    size === 'sm'
      ? 'rounded-full border border-nvr-cyan/40 bg-nvr-cyan/10 px-2 py-0.5 text-[11px] font-semibold text-nvr-navy hover:bg-nvr-cyan/20 disabled:opacity-40 dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
      : 'rounded-full border border-nvr-cyan/40 bg-nvr-cyan/10 px-2 py-0.5 text-[10.5px] font-semibold text-nvr-navy hover:bg-nvr-cyan/20 disabled:opacity-40 dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
  const open = actions.find((a) => a.key === openKey && a.input)
  return (
    <div className={className} data-nvr-notification-actions>
      <div className='flex flex-wrap gap-1'>
        {actions.map((a) => (
          <button
            key={a.key + a.endpoint}
            type='button'
            disabled={run.isPending}
            onClick={(e) => {
              e.stopPropagation()
              if (a.input) {
                setOpenKey(openKey === a.key ? null : a.key)
                return
              }
              run.mutate({ action: a })
            }}
            className={`${pill} ${openKey === a.key ? 'ring-1 ring-nvr-cyan/60' : ''}`}
          >
            {a.label}
          </button>
        ))}
      </div>
      {open?.input && (
        <form
          className='mt-1.5 flex items-end gap-1.5'
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault()
            if (!text.trim()) return
            run.mutate({ action: open, value: text.trim() })
          }}
        >
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (text.trim()) run.mutate({ action: open, value: text.trim() })
              }
              if (e.key === 'Escape') setOpenKey(null)
            }}
            placeholder={open.input.placeholder}
            rows={2}
            className='min-h-[38px] flex-1 resize-none rounded-md border border-slate-200 bg-background px-2 py-1 text-[12px] focus:border-nvr-cyan focus:outline-none dark:border-border'
          />
          <button
            type='submit'
            disabled={run.isPending || !text.trim()}
            className='h-7 rounded-md bg-nvr-cyan px-2.5 text-[11px] font-semibold text-white disabled:opacity-40'
          >
            {run.isPending ? '…' : (open.input.submit_label ?? 'Send')}
          </button>
        </form>
      )}
    </div>
  )
}
