import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { post } from '../../../lib/commands'
import { useLayoutEditorHost } from '../host'
import { AiAskPopover, aiFailure, aiGhostBtn, aiPrimaryBtn, aiQuiet } from './AiAskPopover'
import type { FieldRuleAnswer } from './api'

/**
 * AI default / field-rule writer (#2675): "Default Zone from the project's
 * zone" becomes a draft field rule, dry-run on five records (now → after the
 * rule, and what a new record would get). Nothing is stored until the admin
 * confirms; then it goes through the existing POST /field-rules, which runs
 * the rule on every form and every API write of the collection.
 */

function Cell({ v }: { v: string | null }) {
  return v == null ? (
    <span className='text-slate-400 dark:text-muted-foreground'>empty</span>
  ) : (
    <span className='break-words'>{v}</span>
  )
}

export function DryRunTable({ rows }: { rows: FieldRuleAnswer['dry_run'] }) {
  if (!rows.length) return <p className={aiQuiet}>No records to try it on yet.</p>
  return (
    <table className='w-full table-fixed text-left text-[12px]' data-ai-field-rule-dry-run=''>
      <thead>
        <tr className='text-[11px] text-slate-500 dark:text-muted-foreground'>
          <th className='w-[34%] pb-1 font-medium'>Record</th>
          <th className='pb-1 font-medium'>Now</th>
          <th className='pb-1 font-medium'>After</th>
          <th className='pb-1 font-medium'>New record</th>
        </tr>
      </thead>
      <tbody className='text-slate-700 dark:text-foreground'>
        {rows.map((r) => {
          const changed = r.after_label !== r.before_label
          return (
            <tr key={r.id} className='border-t border-slate-100 align-top dark:border-border'>
              <td className='truncate py-1 pr-2'>{r.label}</td>
              <td className='py-1 pr-2'>
                <Cell v={r.before_label} />
              </td>
              <td className={changed ? 'py-1 pr-2 font-medium' : 'py-1 pr-2'}>
                <Cell v={r.after_label} />
              </td>
              <td className='py-1'>
                <Cell v={r.new_record_label} />
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function FieldRuleWriter({
  layoutId,
  field,
  disabled
}: {
  layoutId: number
  field: string
  disabled?: boolean
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const host = useLayoutEditorHost()
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!host.isAdmin) return null

  return (
    <AiAskPopover<FieldRuleAnswer>
      testId='field-rule'
      label='Write a rule with AI'
      title='Describe where this value comes from'
      placeholder="default from the project's zone"
      disabled={disabled}
      ask={async (text) => {
        setConfirming(false)
        setError(null)
        const res = await client.request<{ data: FieldRuleAnswer }>(
          post(`/ai-design/layouts/${layoutId}/field-rule`, { text, field })
        )
        return res.data
      }}
    >
      {(answer, done, back) => (
        <>
          <p className='text-[12.5px] font-medium leading-snug text-slate-800 dark:text-foreground'>
            {answer.sentence}
          </p>
          {answer.explanation && <p className={aiQuiet}>{answer.explanation}</p>}
          <DryRunTable rows={answer.dry_run} />
          <p className={aiQuiet}>
            A field rule runs on every form and every API write of these records, not only this
            layout.
          </p>
          {error && <p className='text-[12px] text-red-700 dark:text-red-300'>{error}</p>}
          <div className='flex items-center justify-end gap-1.5 pt-1'>
            {confirming ? (
              <>
                <span className='mr-auto text-[12px] text-slate-700 dark:text-foreground'>
                  Save this rule now?
                </span>
                <button type='button' className={aiGhostBtn} onClick={() => setConfirming(false)}>
                  Not yet
                </button>
                <button
                  type='button'
                  className={aiPrimaryBtn}
                  disabled={saving}
                  data-ai-field-rule-confirm=''
                  onClick={async () => {
                    setSaving(true)
                    setError(null)
                    try {
                      await client.request(post('/field-rules', answer.rule))
                      await qc.invalidateQueries({ queryKey: ['field-rules'] })
                      toast.success(`Rule saved: ${answer.sentence}`)
                      setConfirming(false)
                      done()
                    } catch (e) {
                      setError(aiFailure(e, 'The rule could not be saved'))
                    } finally {
                      setSaving(false)
                    }
                  }}
                >
                  {saving ? 'Saving…' : 'Save rule'}
                </button>
              </>
            ) : (
              <>
                <button type='button' className={aiGhostBtn} onClick={back}>
                  Back
                </button>
                <button
                  type='button'
                  className={aiPrimaryBtn}
                  data-ai-field-rule-save=''
                  onClick={() => setConfirming(true)}
                >
                  Save rule…
                </button>
              </>
            )}
          </div>
        </>
      )}
    </AiAskPopover>
  )
}
