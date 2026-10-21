import { useState } from 'react'
import { useNivaroClient } from '../../../context'
import { post } from '../../../lib/commands'
import { applyLayoutOps, type LayoutBundle, type LayoutOp } from '../../../lib/layout-ops'
import { useLayoutEditorHost } from '../host'
import { humanizeOpError } from '../useLayoutDraft'
import {
  AiAskPopover,
  aiGhostBtn,
  aiPrimaryBtn,
  aiQuiet,
  aiWarn,
  DroppedList
} from './AiAskPopover'
import { ofChecked, type RuleAnswer } from './api'

/**
 * AI rule writer (#2673): describe when a step shows, or when a field is
 * read-only, in words. The server answers in the layout's own condition
 * grammar, already tested against the newest records ("shows on 312 of the
 * newest 500"); Apply is one draft batch — one undo step, saved with the form.
 */

export type RuleWriterTarget = { kind: 'step'; group: string } | { kind: 'lock'; field: string }

const SAMPLE_CAP = 500

export function RuleTestLine({ answer }: { answer: RuleAnswer }) {
  const { test, proposal } = answer
  const step = proposal.kind === 'step'
  const verb = step ? 'Shows on' : 'Locks on'
  const other = test.checked - test.matched
  return (
    <div className='space-y-1' data-ai-rule-test=''>
      {test.checked === 0 && !test.roles.length ? (
        <p className={aiQuiet}>No records to test it on yet.</p>
      ) : test.checked > 0 ? (
        <p className='text-[12.5px] text-slate-700 dark:text-foreground'>
          {verb} <strong>{ofChecked(test.matched, test.checked, SAMPLE_CAP)}</strong> records
          {step && other > 0 ? `; hidden on ${other.toLocaleString()}` : ''}.
          {test.current != null && (
            <span className={aiQuiet}> Today: {test.current.toLocaleString()}.</span>
          )}
        </p>
      ) : null}
      {test.roles.length > 0 && (
        <p className={aiQuiet}>
          Also read-only for everyone in {test.roles.join(', ')}, on every record.
        </p>
      )}
    </div>
  )
}

export function RuleWriter({
  layoutId,
  target,
  bundle,
  apply,
  disabled
}: {
  layoutId: number
  target: RuleWriterTarget
  bundle: LayoutBundle
  apply: (ops: LayoutOp[], opts: { label: string }) => void
  disabled?: boolean
}) {
  const client = useNivaroClient()
  const host = useLayoutEditorHost()
  const [error, setError] = useState<string | null>(null)
  if (!host.isAdmin) return null
  const step = target.kind === 'step'

  return (
    <AiAskPopover<RuleAnswer>
      testId={step ? 'step' : 'lock'}
      label='Write with AI'
      title={step ? 'Describe when this step shows' : 'Describe when this field is read-only'}
      placeholder={
        step
          ? 'hide this step when Is Sparing is yes or Warehouse is 3'
          : 'read-only once the record is Approved, or for Finance'
      }
      disabled={disabled}
      ask={async (text) => {
        setError(null)
        const res = await client.request<{ data: RuleAnswer }>(
          post(`/ai-design/layouts/${layoutId}/rule`, { text, target })
        )
        return res.data
      }}
    >
      {(answer, done, back) => (
        <>
          <p className='text-[12.5px] font-medium leading-snug text-slate-800 dark:text-foreground'>
            {answer.sentence}
          </p>
          {answer.replaces && <p className={aiQuiet}>Replaces: {answer.replaces}</p>}
          <RuleTestLine answer={answer} />
          {answer.explanation && <p className={aiQuiet}>{answer.explanation}</p>}
          {answer.notes.map((n) => (
            <p key={n} className={aiWarn}>
              {n}
            </p>
          ))}
          <DroppedList items={answer.dropped} />
          {error && <p className='text-[12px] text-red-700 dark:text-red-300'>{error}</p>}
          <div className='flex items-center justify-end gap-1.5 pt-1'>
            <button type='button' className={aiGhostBtn} onClick={back}>
              Back
            </button>
            <button
              type='button'
              className={aiPrimaryBtn}
              data-ai-rule-apply=''
              onClick={() => {
                // Proved again on the draft as it is now: the form may have changed.
                try {
                  applyLayoutOps(bundle, answer.ops)
                } catch (e) {
                  setError(humanizeOpError((e as Error).message))
                  return
                }
                apply(answer.ops, { label: answer.sentence })
                done()
              }}
            >
              Apply
            </button>
          </div>
        </>
      )}
    </AiAskPopover>
  )
}
