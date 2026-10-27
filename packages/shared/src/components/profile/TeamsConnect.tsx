import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { del } from '../../lib/commands'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { ConfirmButton } from './primitives'

/**
 * The Teams column's connection control (Profile → Notification rules): "Connect Teams" with a
 * short how-to while the person has no link, "Connected · Disconnect" (two-step, inline) once
 * they do. There is no web flow that installs a Teams app, so Connect only explains.
 */
export function TeamsConnect({ linked, linkedAt }: { linked: boolean; linkedAt?: string | null }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [failed, setFailed] = useState(false)
  const disconnect = useMutation({
    mutationFn: () => {
      setFailed(false)
      return client.request(del('/teams/link'))
    },
    onError: () => setFailed(true),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['nvr-profile-teams'] })
    }
  })

  if (linked) {
    return (
      <>
        <span
          className='inline-flex flex-wrap items-center justify-center gap-1 text-[10.5px] font-normal normal-case tracking-normal text-emerald-700 dark:text-emerald-400'
          data-teams-connected=''
          title={linkedAt ? `Connected ${new Date(linkedAt).toLocaleString()}` : undefined}
        >
          Connected ·{' '}
          <ConfirmButton
            onConfirm={() => disconnect.mutate()}
            confirmLabel='Disconnect Teams?'
            disabled={disconnect.isPending}
            className='font-medium text-slate-500 underline decoration-dotted underline-offset-2 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
            armedClassName='font-medium text-red-600 dark:text-red-400'
          >
            Disconnect
          </ConfirmButton>
        </span>
        {failed && (
          <p
            role='alert'
            data-teams-disconnect-error=''
            className='mt-0.5 text-[10.5px] font-normal normal-case tracking-normal text-red-600 dark:text-red-400'
          >
            Could not disconnect Teams. Try again; if it keeps failing, ask an admin.
          </p>
        )}
      </>
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-teams-connect=''
          className='rounded border border-slate-200 px-1.5 py-0.5 text-[10.5px] font-medium normal-case tracking-normal text-slate-600 hover:border-slate-400 hover:text-slate-800 dark:border-border dark:text-muted-foreground dark:hover:text-foreground'
        >
          Connect Teams
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-64 text-[12px] font-normal normal-case tracking-normal text-slate-600 dark:text-muted-foreground'
      >
        Open Nivaro in Teams and say hi, or sign in with Microsoft once, then turn categories on.
      </PopoverContent>
    </Popover>
  )
}
