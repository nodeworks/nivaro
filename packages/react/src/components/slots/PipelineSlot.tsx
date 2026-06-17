import { useCallback, useEffect, useRef, useState } from 'react'
import { useOptionalNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import type { SlotRendererProps } from '../LayoutForm'
import { HistoryTimeline, type PHistory } from './pipeline/HistoryTimeline'
import { OwnersSection } from './pipeline/OwnersSection'
import { StateBadge } from './pipeline/StateBadge'
import { type PState, type PTransition, StateTrack } from './pipeline/StateTrack'

type PInstance = {
  id: string
  current_state: string | null
  current_state_obj: PState | null
  completed_at: string | null
}

type PData = {
  instance: PInstance | null
  states: PState[]
  available_transitions: PTransition[]
  all_transitions: PTransition[]
  history: PHistory[]
  binding: { id: number } | null
}

export function PipelineSlot({
  collection,
  itemId,
  labelOverride,
  defaultExpanded
}: SlotRendererProps) {
  const client = useOptionalNivaroClient()
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<PData | null>(null)
  const [comment, setComment] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [acting, setActing] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const mountedRef = useRef(true)
  const syncedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useEffect(() => {
    if (!syncedRef.current && defaultExpanded !== undefined) {
      syncedRef.current = true
      setOpen(defaultExpanded)
    }
  }, [defaultExpanded])

  const fetchData = useCallback(async () => {
    if (!client || !itemId) return
    try {
      const res = await client.request<{ data: PData }>(
        get(`/pipelines/instance/${collection}/${itemId}`)
      )
      if (mountedRef.current) setData(res.data ?? null)
    } catch {
      if (mountedRef.current) setData(null)
    }
  }, [client, collection, itemId])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  if (!data?.binding) return null

  const instance = data.instance
  const currentState = instance?.current_state_obj ?? null
  const transitions = data.available_transitions ?? []
  const stateById = new Map((data.states ?? []).map((s) => [s.id, s]))
  const hasTransitions = !instance?.completed_at && transitions.length > 0
  const pendingTx = pendingId ? transitions.find((t) => t.id === pendingId) : null
  const pendingToState = pendingTx ? stateById.get(pendingTx.to_state) : null

  const byLabel = new Map<string, PTransition[]>()
  for (const tx of transitions) {
    const list = byLabel.get(tx.label) ?? []
    list.push(tx)
    byLabel.set(tx.label, list)
  }

  async function startWorkflow() {
    if (!client || !itemId || acting) return
    setActing(true)
    try {
      await client.request(post(`/pipelines/instance/${collection}/${itemId}/start`))
      await fetchData()
    } catch {
      /* no-op */
    } finally {
      if (mountedRef.current) setActing(false)
    }
  }

  async function doTransition(txId: string) {
    if (!client || !itemId || acting) return
    setActing(true)
    try {
      await client.request(
        post(`/pipelines/instance/${collection}/${itemId}/transition`, {
          transition_id: txId,
          comment: comment.trim() || undefined
        })
      )
      setPendingId(null)
      setComment('')
      await fetchData()
    } catch {
      /* no-op */
    } finally {
      if (mountedRef.current) setActing(false)
    }
  }

  function trySetPending(txId: string) {
    setPendingId((prev) => (prev === txId ? null : txId))
  }

  return (
    <div data-nf-slot='__pipeline__' data-nf-slot-open={open ? 'true' : 'false'}>
      {/* Header — toggle button wraps the label and chevron */}
      <button type='button' data-nf-slot-toggle onClick={() => setOpen((v) => !v)}>
        <svg
          aria-hidden='true'
          data-nf-slot-icon
          width='14'
          height='14'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
        >
          <line x1='6' y1='3' x2='6' y2='15' />
          <circle cx='18' cy='6' r='3' />
          <circle cx='6' cy='18' r='3' />
          <path d='M18 9a9 9 0 0 1-9 9' />
        </svg>
        <span data-nf-slot-label>{labelOverride ?? 'Progress'}</span>
        <span data-nf-slot-meta>
          {instance?.completed_at && <span data-nf-slot-completed>✓ Completed</span>}
          {currentState && <StateBadge label={currentState.label} color={currentState.color} />}
        </span>
        {!open && hasTransitions && (
          <span data-nf-slot-inline-actions>
            {Array.from(byLabel.entries()).map(([label, txs]) => {
              const txColor = txs[0]?.color ?? null
              const isActive = txs.some((t) => t.id === pendingId)
              return (
                <button
                  key={label}
                  type='button'
                  data-nf-transition-btn
                  data-active={isActive ? 'true' : 'false'}
                  style={
                    txColor
                      ? isActive
                        ? { backgroundColor: txColor, borderColor: txColor, color: '#fff' }
                        : { borderColor: txColor, color: txColor }
                      : undefined
                  }
                  onClick={(e) => {
                    e.stopPropagation()
                    trySetPending(txs[0].id)
                  }}
                >
                  {label}
                </button>
              )
            })}
          </span>
        )}
        {!open && !instance && data.binding && (
          <button
            type='button'
            data-nf-start-btn
            onClick={(e) => {
              e.stopPropagation()
              void startWorkflow()
            }}
            disabled={acting}
          >
            Start
          </button>
        )}
        <svg
          aria-hidden='true'
          data-nf-slot-chevron
          width='14'
          height='14'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
          style={{ transform: open ? 'rotate(180deg)' : undefined }}
        >
          <polyline points='6 9 12 15 18 9' />
        </svg>
      </button>

      {/* Inline confirm when collapsed */}
      {!open && pendingId && (
        <div data-nf-slot-confirm>
          <div data-nf-confirm-header>
            <span data-nf-confirm-label>Confirming</span>
            {pendingTx && <span data-nf-confirm-name>{pendingTx.label}</span>}
            {currentState && pendingToState && (
              <span data-nf-confirm-states>
                <StateBadge label={currentState.label} color={currentState.color} small />
                <svg aria-hidden='true' width='12' height='12' viewBox='0 0 12 12' fill='none'>
                  <path
                    d='M2 6h8M7 3l3 3-3 3'
                    stroke='#cbd5e1'
                    strokeWidth='1.5'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                  />
                </svg>
                <StateBadge label={pendingToState.label} color={pendingToState.color} small />
              </span>
            )}
          </div>
          <input
            type='text'
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder='Add a comment (optional)'
            data-nf-confirm-input
          />
          <div data-nf-confirm-actions>
            <button type='button' data-nf-btn-ghost onClick={() => setPendingId(null)}>
              Cancel
            </button>
            <button
              type='button'
              data-nf-btn-primary
              disabled={acting}
              onClick={() => void doTransition(pendingId!)}
            >
              {acting ? '…' : 'Confirm ✓'}
            </button>
          </div>
        </div>
      )}

      {/* Expanded body */}
      {open && (
        <div data-nf-slot-content>
          {!instance ? (
            <div data-nf-pipeline-not-started>
              <p>Pipeline not started for this record.</p>
              <button
                type='button'
                data-nf-btn-outline
                disabled={acting}
                onClick={() => void startWorkflow()}
              >
                {acting ? '…' : 'Start Pipeline'}
              </button>
            </div>
          ) : (
            <div data-nf-pipeline-body>
              {/* State track */}
              {(data.states ?? []).length > 1 && (
                <div data-nf-state-track-wrap>
                  <StateTrack
                    states={data.states}
                    allTransitions={data.all_transitions ?? []}
                    availableTransitions={transitions}
                    currentStateId={instance.current_state}
                    history={data.history ?? []}
                  />
                </div>
              )}

              {/* Owners */}
              {itemId && (
                <div data-nf-pipeline-section>
                  <OwnersSection
                    collection={collection}
                    itemId={itemId}
                    states={data.states ?? []}
                    client={client}
                  />
                </div>
              )}

              {/* Transitions */}
              {hasTransitions && (
                <div data-nf-transitions data-nf-pipeline-section>
                  <div data-nf-transition-btns>
                    {Array.from(byLabel.entries()).map(([label, txs]) => {
                      const txColor = txs[0]?.color ?? null
                      const isActive = txs.some((t) => t.id === pendingId)
                      return (
                        <button
                          key={label}
                          type='button'
                          data-nf-transition-btn
                          data-active={isActive ? 'true' : 'false'}
                          style={
                            txColor
                              ? isActive
                                ? { backgroundColor: txColor, borderColor: txColor, color: '#fff' }
                                : { borderColor: txColor, color: txColor }
                              : undefined
                          }
                          onClick={() => trySetPending(txs[0].id)}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>

                  {/* Confirm box */}
                  {pendingId && pendingTx && (
                    <div data-nf-confirm-box>
                      <div data-nf-confirm-header>
                        <span data-nf-confirm-label>Confirming</span>
                        <span data-nf-confirm-name>{pendingTx.label}</span>
                        {currentState && pendingToState && (
                          <span data-nf-confirm-states>
                            <StateBadge
                              label={currentState.label}
                              color={currentState.color}
                              small
                            />
                            <svg
                              aria-hidden='true'
                              width='12'
                              height='12'
                              viewBox='0 0 12 12'
                              fill='none'
                            >
                              <path
                                d='M2 6h8M7 3l3 3-3 3'
                                stroke='#cbd5e1'
                                strokeWidth='1.5'
                                strokeLinecap='round'
                                strokeLinejoin='round'
                              />
                            </svg>
                            <StateBadge
                              label={pendingToState.label}
                              color={pendingToState.color}
                              small
                            />
                          </span>
                        )}
                      </div>
                      <input
                        type='text'
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        placeholder='Add a comment (optional)'
                        data-nf-confirm-input
                      />
                      <div data-nf-confirm-actions>
                        <button type='button' data-nf-btn-ghost onClick={() => setPendingId(null)}>
                          Cancel
                        </button>
                        <button
                          type='button'
                          data-nf-btn-primary
                          disabled={acting}
                          onClick={() => void doTransition(pendingId)}
                        >
                          {acting ? '…' : 'Confirm ✓'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* History toggle */}
              <div data-nf-pipeline-section>
                <button
                  type='button'
                  data-nf-history-toggle
                  onClick={() => setShowHistory((v) => !v)}
                >
                  <svg
                    aria-hidden='true'
                    width='14'
                    height='14'
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='2'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    style={{ transform: showHistory ? 'rotate(90deg)' : undefined }}
                  >
                    <polyline points='9 18 15 12 9 6' />
                  </svg>
                  Transition history ({(data.history ?? []).length})
                </button>
                {showHistory && (
                  <div data-nf-history-body>
                    <HistoryTimeline history={data.history ?? []} />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
