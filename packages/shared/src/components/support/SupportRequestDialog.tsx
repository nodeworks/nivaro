import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Paperclip, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { invalidateRecordTasks } from '../../lib/record-tasks'
import { type PreparedReplayClip, prepareReplayClip } from '../../lib/replay-capture'
import { installReplayTail } from '../../lib/replay-tail'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { collectSupportContext } from './support-context'
import type { SupportCategory, SupportTicket } from './types'

/**
 * Raise a support request (#999). With a record it is a change request about
 * that record and offers the types meant for its collection; without one it is
 * General Support. The request lands with the administrators (or the type's
 * team), who are told at once.
 *
 * #1377 — unless the person unticks it, the request carries what they were
 * looking at: the replay taken the moment the dialog OPENED (the error-replay
 * buffer cut as an app='support-clip' recording, or the live recording at
 * that moment) and a text attachment with the page, the console tail and the
 * last twenty requests. Nothing uploads unless the request is sent.
 */
export function SupportRequestDialog({
  open,
  onOpenChange,
  collection,
  item,
  recordLabel,
  initialTitle,
  initialDescription,
  onCreated
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  collection?: string | null
  item?: string | number | null
  /** Friendly id of the record ("CM26-79811"), shown in the title. */
  recordLabel?: string | null
  /** Prefill (an error's "Get help": what happened and its reference). */
  initialTitle?: string
  initialDescription?: string
  onCreated?: (ticket: SupportTicket) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const onRecord = !!collection && item != null && item !== ''
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [files, setFiles] = useState<Array<{ id: string; name: string }>>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [withContext, setWithContext] = useState(true)
  // Taken when the dialog opens — by the time the question is typed the
  // rolling buffer would hold mostly this dialog.
  const moment = useRef<{ clip: PreparedReplayClip; route: string } | null>(null)
  // Set on the first click, before React re-renders the button disabled: the
  // second click of a double-click sent the same request again (two tickets,
  // two context uploads).
  const sendingRef = useRef(false)
  useEffect(() => {
    installReplayTail()
  }, [])
  useEffect(() => {
    if (!open) return
    if (initialTitle) setTitle((t) => t || initialTitle)
    if (initialDescription) setDescription((d) => d || initialDescription)
  }, [open, initialTitle, initialDescription])
  useEffect(() => {
    if (!open) {
      moment.current = null
      return
    }
    moment.current = {
      clip: prepareReplayClip('support'),
      route: typeof window !== 'undefined' ? window.location.pathname : ''
    }
  }, [open])

  const { data: categories = [] } = useQuery({
    queryKey: ['support-categories', onRecord ? collection : null],
    queryFn: () =>
      client
        .request<{ data: SupportCategory[] }>(
          get('/support/categories', onRecord ? { collection } : undefined)
        )
        .then((r) => r.data ?? []),
    enabled: open
  })

  const reset = () => {
    setCategoryId(null)
    setTitle('')
    setDescription('')
    setFiles([])
    setError(null)
    setWithContext(true)
  }

  /** The context attachment + replay link; never fails the request. */
  async function gatherContext() {
    if (!withContext) return { fileId: null, replay: null }
    const m = moment.current
    return collectSupportContext({
      clip: m?.clip ?? null,
      route: m?.route ?? (typeof window !== 'undefined' ? window.location.pathname : ''),
      upload: (file) => client.upload(file, { title: 'What they saw' }),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null
    })
  }

  const create = useMutation({
    mutationFn: async () => {
      const ctx = await gatherContext()
      return client.request<{ data: SupportTicket }>(
        post('/support/tickets', {
          title: title.trim(),
          description: description.trim() || null,
          category_id: categoryId,
          collection: onRecord ? collection : null,
          item: onRecord ? String(item) : null,
          attachments: [...files.map((f) => f.id), ...(ctx.fileId ? [ctx.fileId] : [])],
          ...(ctx.replay ? { replay: ctx.replay } : {})
        })
      )
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['support-tickets'] })
      void qc.invalidateQueries({ queryKey: ['support-summary'] })
      // A request about a record shows in its Tasks slot (to its requester).
      if (onRecord) invalidateRecordTasks(qc, collection, item)
      onCreated?.(r.data)
      reset()
      onOpenChange(false)
    },
    onError: (e) => {
      // The same request was just sent (a second click, another tab): the
      // server kept the first ticket — that is a success, not a failure.
      const body = (e as { response?: { code?: string; data?: { code?: string } } }).response
      if ((body?.data?.code ?? body?.code) === 'DUPLICATE_REQUEST') {
        void qc.invalidateQueries({ queryKey: ['support-tickets'] })
        void qc.invalidateQueries({ queryKey: ['support-summary'] })
        reset()
        onOpenChange(false)
        return
      }
      setError((e as Error).message || 'Could not send the request')
    },
    onSettled: () => {
      sendingRef.current = false
    }
  })

  async function addFiles(list: FileList | null) {
    if (!list?.length) return
    setUploading(true)
    setError(null)
    try {
      for (const f of Array.from(list).slice(0, 10)) {
        const r = await client.upload(f)
        setFiles((prev) => [...prev, { id: String(r.id), name: f.name }])
      }
    } catch {
      setError('A file could not be uploaded')
    } finally {
      setUploading(false)
    }
  }

  const chosen = categories.find((c) => c.id === categoryId) ?? null
  const canSend = title.trim().length > 0 && !create.isPending && !uploading

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className='max-w-xl dark:bg-card' data-support-request>
        <DialogHeader className='px-6 pt-5'>
          <DialogTitle className='text-[15px] font-semibold text-slate-900 dark:text-slate-100'>
            {onRecord ? `Request a change${recordLabel ? ` · ${recordLabel}` : ''}` : 'Get help'}
          </DialogTitle>
          <DialogDescription className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            {onRecord
              ? 'Tell the administrators what needs to change on this record. You can follow the request under My requests.'
              : 'Ask the administrators for help. You can follow the request under My requests.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className='space-y-4 px-6 pb-5 pt-3'
          onSubmit={(e) => {
            e.preventDefault()
            if (!canSend || sendingRef.current) return
            sendingRef.current = true
            create.mutate()
          }}
        >
          {categories.length > 0 && (
            <fieldset>
              <legend className='mb-1.5 text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                What kind of request?
              </legend>
              <div className='flex flex-wrap gap-1.5' data-support-types>
                {categories.map((c) => (
                  <button
                    key={c.id}
                    type='button'
                    data-support-type={c.id}
                    aria-pressed={categoryId === c.id}
                    onClick={() => setCategoryId(categoryId === c.id ? null : c.id)}
                    className={
                      categoryId === c.id
                        ? 'rounded-full border border-nvr-cyan/60 bg-nvr-cyan/10 px-2.5 py-1 text-[12px] font-medium text-nvr-navy dark:text-nvr-cyan'
                        : 'rounded-full border border-slate-200 px-2.5 py-1 text-[12px] text-slate-600 hover:border-slate-300 dark:border-border dark:text-slate-300'
                    }
                  >
                    {c.name}
                  </button>
                ))}
              </div>
              {chosen?.description && (
                <p className='mt-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                  {chosen.description}
                </p>
              )}
            </fieldset>
          )}
          <label className='block'>
            <span className='mb-1 block text-[12px] font-medium text-slate-700 dark:text-slate-200'>
              Summary
            </span>
            <input
              data-support-title
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              placeholder={
                onRecord
                  ? 'e.g. Move to funding year 2027'
                  : 'e.g. I need access to the National zone'
              }
              className='h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-[13px] text-slate-900 outline-none focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-slate-100'
            />
          </label>
          <label className='block'>
            <span className='mb-1 block text-[12px] font-medium text-slate-700 dark:text-slate-200'>
              Details
            </span>
            <textarea
              data-support-description
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              placeholder='What should change, and why'
              className='w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-900 outline-none focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-slate-100'
            />
          </label>
          <div>
            <label className='inline-flex cursor-pointer items-center gap-1.5 text-[12px] font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100'>
              {uploading ? (
                <Loader2 className='h-3.5 w-3.5 animate-spin' />
              ) : (
                <Paperclip className='h-3.5 w-3.5' />
              )}
              Attach files
              <input
                type='file'
                multiple
                className='hidden'
                data-support-files
                onChange={(e) => {
                  void addFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </label>
            {files.length > 0 && (
              <ul className='mt-1.5 flex flex-wrap gap-1.5'>
                {files.map((f) => (
                  <li
                    key={f.id}
                    className='inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 text-[11.5px] text-slate-700 dark:bg-white/10 dark:text-slate-200'
                  >
                    {f.name}
                    <button
                      type='button'
                      aria-label={`Remove ${f.name}`}
                      onClick={() => setFiles((p) => p.filter((x) => x.id !== f.id))}
                      className='text-slate-400 hover:text-slate-700 dark:hover:text-slate-100'
                    >
                      <X className='h-3 w-3' />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <label
            className='flex items-start gap-2 text-[12px] text-slate-600 dark:text-slate-300'
            data-support-context
          >
            <input
              type='checkbox'
              checked={withContext}
              onChange={(e) => setWithContext(e.target.checked)}
              className='mt-0.5 accent-[#00ceff]'
            />
            <span>
              Include what I was doing
              <span className='block text-[11px] text-slate-400'>
                The page, recent errors and requests, and (when replay is on) the last minute of
                this screen with every typed value hidden.
              </span>
            </span>
          </label>
          {error && (
            <p className='text-[12px] text-red-600 dark:text-red-400' role='alert'>
              {error}
            </p>
          )}
          <div className='flex justify-end gap-2 pt-1'>
            <button
              type='button'
              onClick={() => onOpenChange(false)}
              className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] text-slate-700 hover:bg-slate-50 dark:border-border dark:text-slate-200 dark:hover:bg-white/5'
            >
              Cancel
            </button>
            <button
              type='submit'
              data-support-send
              disabled={!canSend}
              className='inline-flex h-8 items-center gap-1.5 rounded-md border border-nvr-cyan/60 bg-nvr-cyan/10 px-3 text-[12.5px] font-medium text-nvr-navy hover:bg-nvr-cyan/15 disabled:opacity-50 dark:text-nvr-cyan'
            >
              {create.isPending && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
              Send request
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
