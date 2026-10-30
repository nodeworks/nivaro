import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get, post } from '../../../lib/commands'
import { userErrorMessage } from '../../../lib/safe-error'
import { BUTTON, FAINT, FOCUS, MUTED } from '../theme'

/**
 * Inline forms for acting from a "Needs attention" row (CC-30). Each runs through a route the app
 * already has, never a Command Center write of its own except the nudge:
 *   nudge      POST /command-center/nudge            (owners of the current step, once per 30 min)
 *   transition POST /pipelines/instance/:c/:id/transition  (choices from GET /pipelines/instance)
 *   approve    POST /approvals/instances/:id/decide
 *   reassign   POST /pipelines/instance/:c/:id/owners      (the hand-off the record page uses)
 * Every one asks for a second, explicit confirm before it writes and reports the server's answer
 * in words. The board hides them on a wallboard link.
 */

const INPUT =
  'w-full rounded-md border border-[var(--cc-border)] bg-[var(--cc-panel)] px-2 py-1 text-[12px] text-[var(--cc-text)] placeholder:text-[var(--cc-faint)]'
const PRIMARY =
  'rounded-md bg-nvr-cyan px-2.5 py-1 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50'

function useRefreshBoard() {
  const qc = useQueryClient()
  return () => void qc.invalidateQueries({ queryKey: ['command-center'] })
}

function Result({ ok, text }: { ok: boolean; text: string }) {
  return (
    <p
      role='status'
      className={`text-[11.5px] ${ok ? 'text-[var(--cc-good-text)]' : 'text-[var(--cc-bad-text)]'}`}
    >
      {text}
    </p>
  )
}

export function NudgeForm({
  target,
  onDone
}: {
  target: { collection: string; id: string }
  onDone: () => void
}) {
  const client = useNivaroClient()
  const refresh = useRefreshBoard()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const send = async () => {
    setBusy(true)
    try {
      const r = await client.request<{ data: { notified: number; names: string[] } }>(
        post('/command-center/nudge', {
          collection: target.collection,
          item: target.id,
          ...(message.trim() ? { message: message.trim() } : {})
        })
      )
      setResult({ ok: true, text: `Nudged ${r.data.names.join(', ')}.` })
      refresh()
    } catch (err) {
      setResult({ ok: false, text: userErrorMessage(err, 'Could not send the nudge') })
    } finally {
      setBusy(false)
    }
  }
  if (result?.ok)
    return (
      <div className='flex items-center gap-2'>
        <Result {...result} />
        <button type='button' onClick={onDone} className={`${BUTTON} ${FOCUS}`}>
          Close
        </button>
      </div>
    )
  return (
    <div className='space-y-1.5'>
      <label className={`block text-[11px] ${MUTED}`}>
        Message to the owners (optional)
        <input
          className={`${INPUT} mt-0.5 ${FOCUS}`}
          value={message}
          maxLength={500}
          onChange={(e) => setMessage(e.target.value)}
          placeholder='Can you take a look today?'
        />
      </label>
      <div className='flex items-center gap-2'>
        <button type='button' disabled={busy} onClick={send} className={`${PRIMARY} ${FOCUS}`}>
          {busy ? 'Sending…' : 'Send nudge'}
        </button>
        <button type='button' onClick={onDone} className={`${BUTTON} ${FOCUS}`}>
          Cancel
        </button>
      </div>
      {result && <Result {...result} />}
    </div>
  )
}

interface InstanceTransition {
  id: string
  label: string | null
  name?: string | null
}

export function TransitionForm({
  target,
  onDone
}: {
  target: { collection: string; id: string }
  onDone: () => void
}) {
  const client = useNivaroClient()
  const refresh = useRefreshBoard()
  const [pick, setPick] = useState<InstanceTransition | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const q = useQuery({
    queryKey: ['command-center', 'attention-transitions', target.collection, target.id],
    queryFn: () =>
      client
        .request<{ data: { available_transitions?: InstanceTransition[] } | null }>(
          get(
            `/pipelines/instance/${encodeURIComponent(target.collection)}/${encodeURIComponent(target.id)}`
          )
        )
        .then((r) => r.data?.available_transitions ?? []),
    staleTime: 15_000
  })
  const name = (t: InstanceTransition) => t.label || t.name || 'Move on'
  const run = async () => {
    if (!pick) return
    setBusy(true)
    try {
      await client.request(
        post(
          `/pipelines/instance/${encodeURIComponent(target.collection)}/${encodeURIComponent(target.id)}/transition`,
          { transition_id: pick.id }
        )
      )
      setResult({ ok: true, text: `Done: ${name(pick)}.` })
      refresh()
    } catch (err) {
      // A transition that needs fields filled in answers 422 — that is the record page's job.
      setResult({
        ok: false,
        text: userErrorMessage(err, 'Could not move the record — open it to finish this step')
      })
    } finally {
      setBusy(false)
    }
  }
  if (result?.ok)
    return (
      <div className='flex items-center gap-2'>
        <Result {...result} />
        <button type='button' onClick={onDone} className={`${BUTTON} ${FOCUS}`}>
          Close
        </button>
      </div>
    )
  if (q.isLoading) return <p className={`text-[11.5px] ${FAINT}`}>Loading the next steps…</p>
  const choices = q.data ?? []
  if (choices.length === 0)
    return (
      <div className='flex items-center gap-2'>
        <p className={`text-[11.5px] ${MUTED}`}>
          There is no step you can take on this record from here.
        </p>
        <button type='button' onClick={onDone} className={`${BUTTON} ${FOCUS}`}>
          Close
        </button>
      </div>
    )
  return (
    <div className='space-y-1.5'>
      {!pick ? (
        <div className='flex flex-wrap items-center gap-1.5'>
          {choices.map((t) => (
            <button
              key={t.id}
              type='button'
              onClick={() => setPick(t)}
              className={`${BUTTON} ${FOCUS}`}
            >
              {name(t)}
            </button>
          ))}
          <button type='button' onClick={onDone} className={`${BUTTON} ${FOCUS}`}>
            Cancel
          </button>
        </div>
      ) : (
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-[12px] text-[var(--cc-text)]'>
            Run <b>{name(pick)}</b> on this record?
          </span>
          <button type='button' disabled={busy} onClick={run} className={`${PRIMARY} ${FOCUS}`}>
            {busy ? 'Working…' : 'Yes, run it'}
          </button>
          <button type='button' onClick={() => setPick(null)} className={`${BUTTON} ${FOCUS}`}>
            Back
          </button>
        </div>
      )}
      {result && <Result {...result} />}
    </div>
  )
}

export function ApproveForm({ approvalId, onDone }: { approvalId: number; onDone: () => void }) {
  const client = useNivaroClient()
  const refresh = useRefreshBoard()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const run = async () => {
    setBusy(true)
    try {
      await client.request(
        post(`/approvals/instances/${approvalId}/decide`, { decision: 'approved' })
      )
      setResult({ ok: true, text: 'Approved.' })
      refresh()
    } catch (err) {
      setResult({ ok: false, text: userErrorMessage(err, 'Could not approve') })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className='space-y-1.5'>
      {!result?.ok && (
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-[12px] text-[var(--cc-text)]'>Approve this step?</span>
          <button type='button' disabled={busy} onClick={run} className={`${PRIMARY} ${FOCUS}`}>
            {busy ? 'Approving…' : 'Yes, approve'}
          </button>
          <button type='button' onClick={onDone} className={`${BUTTON} ${FOCUS}`}>
            Cancel
          </button>
        </div>
      )}
      {result && <Result {...result} />}
      {result?.ok && (
        <button type='button' onClick={onDone} className={`${BUTTON} ${FOCUS}`}>
          Close
        </button>
      )}
    </div>
  )
}

interface Person {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
}
const personName = (p: Person) => [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email

/** Bulk hand-off of a stuck group to one person, record by record, with per-record failures. */
export function ReassignForm({
  targets,
  onDone
}: {
  targets: Array<{ collection: string; id: string }>
  onDone: () => void
}) {
  const client = useNivaroClient()
  const refresh = useRefreshBoard()
  const [search, setSearch] = useState('')
  const [pick, setPick] = useState<Person | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{
    moved: number
    failed: Array<{ id: string; error: string }>
  } | null>(null)
  const people = useQuery({
    queryKey: ['command-center', 'reassign-people', search],
    queryFn: () =>
      client
        .request<{ data: Person[] }>(get('/users', { search, limit: 8 }))
        .then((r) => r.data ?? []),
    enabled: !pick && search.trim().length >= 2,
    staleTime: 30_000
  })
  const run = async () => {
    if (!pick) return
    setBusy(true)
    let moved = 0
    const failed: Array<{ id: string; error: string }> = []
    for (const t of targets) {
      try {
        await client.request(
          post(
            `/pipelines/instance/${encodeURIComponent(t.collection)}/${encodeURIComponent(t.id)}/owners`,
            { user: pick.id }
          )
        )
        moved++
      } catch (err) {
        failed.push({ id: t.id, error: userErrorMessage(err, 'Refused') })
      }
    }
    setDone({ moved, failed })
    setBusy(false)
    refresh()
  }
  if (done)
    return (
      <div className='space-y-1'>
        <Result
          ok={done.failed.length === 0}
          text={`${done.moved} of ${targets.length} handed to ${pick ? personName(pick) : 'them'}.${
            done.failed.length ? ` ${done.failed.length} refused:` : ''
          }`}
        />
        {done.failed.length > 0 && (
          <ul className={`max-h-24 overflow-y-auto text-[11px] ${MUTED}`}>
            {done.failed.slice(0, 20).map((f) => (
              <li key={f.id}>
                #{f.id}: {f.error}
              </li>
            ))}
          </ul>
        )}
        <button type='button' onClick={onDone} className={`${BUTTON} ${FOCUS}`}>
          Close
        </button>
      </div>
    )
  return (
    <div className='space-y-1.5'>
      {!pick ? (
        <>
          <label className={`block text-[11px] ${MUTED}`}>
            Hand {targets.length} record{targets.length === 1 ? '' : 's'} to
            <input
              className={`${INPUT} mt-0.5 ${FOCUS}`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='Type a name'
              aria-autocomplete='list'
            />
          </label>
          {search.trim().length >= 2 && (
            <ul className='space-y-0.5' aria-label='People'>
              {(people.data ?? []).map((p) => (
                <li key={p.id}>
                  <button
                    type='button'
                    onClick={() => setPick(p)}
                    className={`w-full rounded px-1.5 py-0.5 text-left text-[12px] text-[var(--cc-text)] hover:bg-[var(--cc-chip)] ${FOCUS}`}
                  >
                    {personName(p)} <span className={FAINT}>{p.email}</span>
                  </button>
                </li>
              ))}
              {people.data?.length === 0 && (
                <li className={`text-[11.5px] ${FAINT}`}>Nobody found.</li>
              )}
            </ul>
          )}
          <button type='button' onClick={onDone} className={`${BUTTON} ${FOCUS}`}>
            Cancel
          </button>
        </>
      ) : !confirm ? (
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-[12px] text-[var(--cc-text)]'>
            Hand {targets.length} record{targets.length === 1 ? '' : 's'} to{' '}
            <b>{personName(pick)}</b>?
          </span>
          <button type='button' onClick={() => setConfirm(true)} className={`${BUTTON} ${FOCUS}`}>
            Continue
          </button>
          <button type='button' onClick={() => setPick(null)} className={`${BUTTON} ${FOCUS}`}>
            Pick someone else
          </button>
        </div>
      ) : (
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-[12px] text-[var(--cc-text)]'>
            {personName(pick)} becomes an owner of the current step on each record. Sure?
          </span>
          <button type='button' disabled={busy} onClick={run} className={`${PRIMARY} ${FOCUS}`}>
            {busy ? 'Handing on…' : `Yes, hand on ${targets.length}`}
          </button>
          <button type='button' onClick={() => setConfirm(false)} className={`${BUTTON} ${FOCUS}`}>
            Back
          </button>
        </div>
      )}
    </div>
  )
}
