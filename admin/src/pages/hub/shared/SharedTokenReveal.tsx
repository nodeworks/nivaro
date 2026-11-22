import { KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatDateTime } from '@/lib/utils'
import { CopyButton } from '../hub-parts'
import { reapplyWords, type SharedRotated } from './shared-api'

/**
 * A deployment token, shown this once (on the answer that made or rotated it), with Copy. For a
 * deployment run elsewhere the settings block carries the token too. "Done" hands it back: the
 * page keeps it nowhere and every later read shows only the mask.
 */
export function SharedTokenReveal({
  token,
  envBlock,
  rotated,
  version,
  onDone
}: {
  token: string
  envBlock: string | null
  /** Set after a rotation: how long the old token works and whether the stack picked it up. */
  rotated?: Pick<SharedRotated, 'previous_token_valid_until' | 'reapply' | 'reapply_reason'>
  /** What the deployment runs (the version an upgrade re-applies). */
  version?: string | null
  onDone: () => void
}) {
  return (
    <section
      aria-label='New deployment token'
      className='space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-3 sm:p-4 dark:border-amber-900/60 dark:bg-amber-950/30'
    >
      <div className='flex items-start gap-2'>
        <KeyRound
          className='mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300'
          aria-hidden
        />
        <div className='min-w-0'>
          <p
            role='status'
            className='m-0 text-[13px] font-semibold text-amber-900 dark:text-amber-200'
          >
            Copy the token now — it is shown only this once
          </p>
          <p className='m-0 mt-0.5 text-[12px] text-amber-900/80 dark:text-amber-200/80'>
            The Hub keeps it sealed and never shows it again. If it is lost, rotate it.
          </p>
        </div>
      </div>

      <div className='flex min-w-0 flex-wrap items-center gap-2'>
        <code
          data-testid='shared-token'
          className='min-w-0 max-w-full flex-1 break-all rounded border border-amber-200 bg-white px-2 py-1.5 font-mono text-[12px] text-slate-900 dark:border-amber-900/60 dark:bg-background dark:text-foreground'
        >
          {token}
        </code>
        <CopyButton value={token} label='Copy the token' />
      </div>

      {rotated && <RotationNote rotated={rotated} version={version} />}

      {envBlock && (
        <div className='space-y-1.5'>
          <div className='flex items-center gap-2'>
            <p className='m-0 flex-1 text-[12px] font-medium text-amber-900 dark:text-amber-200'>
              Settings for the deployment, with the token filled in
            </p>
            <CopyButton value={envBlock} label='Copy the settings' />
          </div>
          <pre className='m-0 max-h-[240px] overflow-auto rounded border border-amber-200 bg-white p-2 font-mono text-[11.5px] leading-relaxed whitespace-pre text-slate-800 dark:border-amber-900/60 dark:bg-background dark:text-slate-200'>
            {envBlock}
          </pre>
        </div>
      )}

      <Button
        type='button'
        size='sm'
        className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
        onClick={onDone}
      >
        Done, I have stored it
      </Button>
    </section>
  )
}

function RotationNote({
  rotated,
  version
}: {
  rotated: Pick<SharedRotated, 'previous_token_valid_until' | 'reapply' | 'reapply_reason'>
  version?: string | null
}) {
  return (
    <ul className='m-0 list-disc space-y-0.5 pl-5 text-[12px] text-amber-900 dark:text-amber-200'>
      <li>
        {
          reapplyWords(rotated.reapply, rotated.reapply_reason, { what: 'the new token', version })
            .text
        }
      </li>
      {rotated.previous_token_valid_until && (
        <li>
          The old token keeps working until {formatDateTime(rotated.previous_token_valid_until)}.
        </li>
      )}
    </ul>
  )
}
