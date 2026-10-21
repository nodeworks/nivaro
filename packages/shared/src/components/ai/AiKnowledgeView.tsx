import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Check, Pencil, Plus, RotateCw, Search, Trash2, Wand2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { type GlossaryTerm, invalidateGlossary } from '../../lib/glossary'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { SimpleSelect } from '../ui/SimpleSelect'
import { Textarea } from '../ui/textarea'
import { DataGuideCard, type DataGuideRow } from './DataGuideCard'
import { EmbeddingFreshnessTab } from './EmbeddingFreshnessTab'
import { type FindingSide, KnowledgeFindingsTab } from './KnowledgeFindingsTab'
import { RoleChecklistsTab } from './RoleChecklistsTab'
import { TopicMapTab } from './TopicMapTab'

/**
 * What Ask AI knows beyond the data (migration 434), one console:
 *  - Glossary (#1899): business terms defined once. Everyone reads it (term
 *    links from answers land here); admins add, edit and delete.
 *  - Data guides (#1847): per-collection hints and example questions.
 *  - Suggestions (#1898 / #1949): drafted guide lines and glossary terms an
 *    admin accepts (optionally edited) or dismisses.
 *  - Docs gaps (#1855): questions Ask AI could not answer from the docs,
 *    grouped by topic.
 */

export type AiKnowledgeTab =
  | 'glossary'
  | 'guides'
  | 'suggestions'
  | 'gaps'
  | 'conflicts'
  | 'index'
  | 'topics'
  | 'checklists'

const TABS: Array<{ id: AiKnowledgeTab; label: string; admin: boolean }> = [
  { id: 'glossary', label: 'Glossary', admin: false },
  { id: 'guides', label: 'Data guides', admin: true },
  { id: 'suggestions', label: 'Suggestions', admin: true },
  { id: 'gaps', label: 'Docs gaps', admin: true },
  { id: 'conflicts', label: 'Conflicts', admin: true },
  { id: 'topics', label: 'Topic map', admin: true },
  { id: 'index', label: 'Search index', admin: true },
  { id: 'checklists', label: 'First week', admin: true }
]

const errMsg = (e: unknown, fallback: string) => (e as { message?: string })?.message || fallback

function useCollections(enabled: boolean) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: ['nvr-ai-knowledge-collections'],
    enabled,
    staleTime: 60_000,
    queryFn: () =>
      client
        .request<{ data: Array<{ collection: string; display_name?: string | null }> }>(
          get('/collections')
        )
        .then((r) =>
          (r.data ?? [])
            .filter((c) => !/^(nivaro|directus)_/i.test(c.collection))
            .sort((a, b) => a.collection.localeCompare(b.collection))
        )
  })
}

function CollectionSelect({
  value,
  onChange,
  emptyLabel
}: {
  value: string
  onChange: (v: string) => void
  emptyLabel: string
}) {
  const cols = useCollections(true)
  const options = useMemo(
    () => [
      { value: '', label: emptyLabel },
      ...(cols.data ?? []).map((c) => ({
        value: c.collection,
        label:
          c.display_name && c.display_name !== c.collection
            ? `${c.display_name} (${c.collection})`
            : c.collection
      }))
    ],
    [cols.data, emptyLabel]
  )
  return (
    <SimpleSelect
      value={value}
      onChange={onChange}
      options={options}
      ariaLabel='Collection'
      className='h-8 text-[12.5px]'
    />
  )
}

// ─── Glossary ────────────────────────────────────────────────────────────────

type TermDraft = {
  term: string
  definition: string
  aliases: string
  collection: string
  query_slug: string
  query_note: string
}

const blankDraft: TermDraft = {
  term: '',
  definition: '',
  aliases: '',
  collection: '',
  query_slug: '',
  query_note: ''
}

const toDraft = (t: GlossaryTerm): TermDraft => ({
  term: t.term,
  definition: t.definition,
  aliases: t.aliases.join(', '),
  collection: t.collection ?? '',
  query_slug: t.query_slug ?? '',
  query_note: t.query_note ?? ''
})

const fromDraft = (d: TermDraft) => ({
  term: d.term,
  definition: d.definition,
  aliases: d.aliases
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean),
  collection: d.collection || null,
  query_slug: d.query_slug.trim() || null,
  query_note: d.query_note.trim() || null
})

function TermForm({
  initial,
  busy,
  onSave,
  onCancel
}: {
  initial: TermDraft
  busy: boolean
  onSave: (d: TermDraft) => void
  onCancel: () => void
}) {
  const [d, setD] = useState(initial)
  const set = (k: keyof TermDraft) => (v: string) => setD((p) => ({ ...p, [k]: v }))
  return (
    <div className='grid gap-2 rounded-lg border border-nvr-cyan/40 bg-white p-3 dark:bg-card md:grid-cols-2'>
      <Input
        value={d.term}
        onChange={(e) => set('term')(e.target.value)}
        placeholder='Term — e.g. Held'
        maxLength={120}
        className='h-8 text-[12.5px]'
        aria-label='Term'
      />
      <Input
        value={d.aliases}
        onChange={(e) => set('aliases')(e.target.value)}
        placeholder='Other spellings, comma separated — on hold, held invoice'
        className='h-8 text-[12.5px]'
        aria-label='Aliases'
      />
      <Textarea
        value={d.definition}
        onChange={(e) => set('definition')(e.target.value)}
        placeholder='Definition — an invoice with is_on_hold set; it is not paid until released.'
        rows={2}
        maxLength={2000}
        className='text-[12.5px] md:col-span-2'
        aria-label='Definition'
      />
      <CollectionSelect
        value={d.collection}
        onChange={set('collection')}
        emptyLabel='Every collection'
      />
      <Input
        value={d.query_slug}
        onChange={(e) => set('query_slug')(e.target.value)}
        placeholder='Saved query slug behind the figure (optional)'
        className='h-8 text-[12.5px]'
        aria-label='Saved query slug'
      />
      <Input
        value={d.query_note}
        onChange={(e) => set('query_note')(e.target.value)}
        placeholder='Rule behind it (optional) — is_on_hold = 1'
        className='h-8 text-[12.5px] md:col-span-2'
        aria-label='Rule'
      />
      <div className='flex gap-2 md:col-span-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={busy || !d.term.trim() || !d.definition.trim()}
          onClick={() => onSave(d)}
        >
          {busy ? 'Saving…' : 'Save term'}
        </Button>
        <Button size='sm' variant='ghost' className='h-8' onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function GlossaryTab({ isAdmin, focusTerm }: { isAdmin: boolean; focusTerm?: string | null }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const q = useQuery({
    queryKey: ['nvr-ai-glossary'],
    queryFn: () => client.request<{ data: GlossaryTerm[] }>(get('/ai-knowledge/glossary'))
  })
  const refresh = () => {
    invalidateGlossary(client)
    void qc.invalidateQueries({ queryKey: ['nvr-ai-glossary'] })
  }
  const create = useMutation({
    mutationFn: (d: TermDraft) => client.request(post('/ai-knowledge/glossary', fromDraft(d))),
    onSuccess: () => {
      setCreating(false)
      refresh()
    },
    onError: (e) => toast.error(errMsg(e, 'Could not add the term'))
  })
  const update = useMutation({
    mutationFn: ({ id, d }: { id: number; d: TermDraft }) =>
      client.request(patch(`/ai-knowledge/glossary/${id}`, fromDraft(d))),
    onSuccess: () => {
      setEditing(null)
      refresh()
    },
    onError: (e) => toast.error(errMsg(e, 'Could not save the term'))
  })
  const remove = useMutation({
    mutationFn: (id: number) => client.request(del(`/ai-knowledge/glossary/${id}`)),
    onSuccess: () => {
      setConfirmDelete(null)
      refresh()
    },
    onError: (e) => toast.error(errMsg(e, 'Could not delete the term'))
  })

  const terms = q.data?.data ?? []
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    if (!f) return terms
    return terms.filter((t) =>
      [t.term, t.definition, ...t.aliases, t.collection ?? ''].some((s) =>
        s.toLowerCase().includes(f)
      )
    )
  }, [terms, filter])

  const focusRef = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    if (focusTerm && terms.length) focusRef.current?.scrollIntoView({ block: 'center' })
  }, [focusTerm, terms.length])

  return (
    <div className='flex flex-col gap-3' data-ai-glossary>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='relative w-full max-w-[320px]'>
          <Search className='absolute left-2 top-2 h-4 w-4 text-muted-foreground' />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder='Find a term'
            className='h-8 pl-8 text-[12.5px]'
          />
        </div>
        {isAdmin && !creating && (
          <Button
            size='sm'
            className='h-8 gap-1 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            onClick={() => setCreating(true)}
          >
            <Plus className='h-3.5 w-3.5' /> New term
          </Button>
        )}
        <span className='text-[11.5px] text-muted-foreground'>
          Ask AI uses these meanings, and labels and answers show them on hover.
        </span>
      </div>
      {creating && (
        <TermForm
          initial={blankDraft}
          busy={create.isPending}
          onSave={(d) => create.mutate(d)}
          onCancel={() => setCreating(false)}
        />
      )}
      {q.isLoading ? (
        <p className='text-[12px] text-muted-foreground'>Loading…</p>
      ) : !shown.length ? (
        <div className='rounded-lg border border-dashed border-slate-300 p-8 text-center text-[12.5px] text-muted-foreground dark:border-border'>
          {terms.length
            ? 'No term matches.'
            : isAdmin
              ? 'No terms yet. Add one, or draft them from the data on the Suggestions tab.'
              : 'No terms defined yet.'}
        </div>
      ) : (
        <ul className='flex flex-col gap-2'>
          {shown.map((t) =>
            editing === t.id ? (
              <li key={t.id}>
                <TermForm
                  initial={toDraft(t)}
                  busy={update.isPending}
                  onSave={(d) => update.mutate({ id: t.id, d })}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : (
              <li
                key={t.id}
                id={`term-${t.slug}`}
                ref={t.slug === focusTerm ? focusRef : undefined}
                data-glossary-entry={t.slug}
                className={cn(
                  'group rounded-lg border bg-white px-4 py-3 dark:bg-card',
                  t.slug === focusTerm
                    ? 'border-nvr-cyan ring-2 ring-nvr-cyan/30'
                    : 'border-slate-200 dark:border-border'
                )}
              >
                <div className='flex flex-wrap items-baseline gap-2'>
                  <span className='text-[13.5px] font-semibold'>{t.term}</span>
                  {t.aliases.map((a) => (
                    <span
                      key={a}
                      className='rounded bg-muted px-1.5 py-px text-[11px] text-muted-foreground'
                    >
                      {a}
                    </span>
                  ))}
                  {t.collection && (
                    <span className='rounded border border-slate-200 px-1.5 py-px font-mono text-[10.5px] text-muted-foreground dark:border-border'>
                      {t.collection}
                    </span>
                  )}
                  {isAdmin && (
                    <span className='ml-auto flex items-center gap-1'>
                      {confirmDelete === t.id ? (
                        <>
                          <span className='text-[11.5px] text-muted-foreground'>Delete?</span>
                          <Button
                            size='sm'
                            variant='destructive'
                            className='h-7 px-2 text-[11.5px]'
                            disabled={remove.isPending}
                            onClick={() => remove.mutate(t.id)}
                          >
                            Delete
                          </Button>
                          <Button
                            size='sm'
                            variant='ghost'
                            className='h-7 px-2 text-[11.5px]'
                            onClick={() => setConfirmDelete(null)}
                          >
                            Keep
                          </Button>
                        </>
                      ) : (
                        <>
                          <button
                            type='button'
                            aria-label={`Edit ${t.term}`}
                            onClick={() => setEditing(t.id)}
                            className='rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground'
                          >
                            <Pencil className='h-3.5 w-3.5' />
                          </button>
                          <button
                            type='button'
                            aria-label={`Delete ${t.term}`}
                            onClick={() => setConfirmDelete(t.id)}
                            className='rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive'
                          >
                            <Trash2 className='h-3.5 w-3.5' />
                          </button>
                        </>
                      )}
                    </span>
                  )}
                </div>
                <p className='mt-1 whitespace-pre-wrap text-[12.5px] text-slate-700 dark:text-slate-300'>
                  {t.definition}
                </p>
                {(t.query_note || t.query_slug) && (
                  <p className='mt-1 text-[11.5px] text-muted-foreground'>
                    {t.query_note && <>Rule: {t.query_note}</>}
                    {t.query_note && t.query_slug && ' · '}
                    {t.query_slug && (
                      <>
                        Saved query: <code className='font-mono'>{t.query_slug}</code>
                      </>
                    )}
                  </p>
                )}
              </li>
            )
          )}
        </ul>
      )}
    </div>
  )
}

// ─── Data guides ─────────────────────────────────────────────────────────────

function GuidesTab() {
  const client = useNivaroClient()
  const [adding, setAdding] = useState('')
  const q = useQuery({
    queryKey: ['nvr-ai-data-guides'],
    queryFn: () => client.request<{ data: DataGuideRow[] }>(get('/ai-knowledge/data-guides'))
  })
  const guides = q.data?.data ?? []
  const open = adding && !guides.some((g) => g.collection === adding) ? [adding] : []
  return (
    <div className='flex flex-col gap-3' data-ai-data-guides>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='w-full max-w-[320px]'>
          <CollectionSelect value={adding} onChange={setAdding} emptyLabel='Add a guide for…' />
        </div>
        <span className='text-[11.5px] text-muted-foreground'>
          A guide rides Ask AI's prompt only when a question touches its collection. The guide on a
          collection's settings is the same one.
        </span>
      </div>
      {open.map((c) => (
        <div key={c}>
          <div className='mb-1 font-mono text-[12px] font-medium'>{c}</div>
          <DataGuideCard collection={c} />
        </div>
      ))}
      {q.isLoading ? (
        <p className='text-[12px] text-muted-foreground'>Loading…</p>
      ) : !guides.length && !open.length ? (
        <div className='rounded-lg border border-dashed border-slate-300 p-8 text-center text-[12.5px] text-muted-foreground dark:border-border'>
          No collection has a data guide yet.
        </div>
      ) : (
        guides.map((g) => (
          <div key={g.collection}>
            <div className='mb-1 font-mono text-[12px] font-medium'>{g.collection}</div>
            <DataGuideCard collection={g.collection} />
          </div>
        ))
      )}
    </div>
  )
}

// ─── Suggestions ─────────────────────────────────────────────────────────────

interface Suggestion {
  id: number
  kind: 'glossary' | 'guide'
  collection: string | null
  payload: Record<string, unknown>
  source: string
  evidence: Array<{ question?: string; note?: string; source?: string } | unknown>
  reason: string | null
  status: 'pending' | 'accepted' | 'dismissed'
  created_at: string | null
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

function SuggestionCard({ s }: { s: Suggestion }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [term, setTerm] = useState(str(s.payload.term))
  const [definition, setDefinition] = useState(str(s.payload.definition))
  const [aliases, setAliases] = useState(
    Array.isArray(s.payload.aliases) ? (s.payload.aliases as string[]).join(', ') : ''
  )
  const [text, setText] = useState(str(s.payload.text))
  const [collection, setCollection] = useState(s.collection ?? '')
  const done = () => {
    invalidateGlossary(client)
    void qc.invalidateQueries({ queryKey: ['nvr-ai-knowledge-suggestions'] })
    void qc.invalidateQueries({ queryKey: ['nvr-ai-glossary'] })
    void qc.invalidateQueries({ queryKey: ['nvr-ai-data-guides'] })
  }
  const accept = useMutation({
    mutationFn: () =>
      client.request<{ data: { applied: string; target: string } }>(
        post(`/ai-knowledge/suggestions/${s.id}/accept`, {
          payload:
            s.kind === 'glossary'
              ? {
                  term,
                  definition,
                  aliases: aliases
                    .split(',')
                    .map((a) => a.trim())
                    .filter(Boolean),
                  collection: collection || null
                }
              : { text, collection: collection || null }
        })
      ),
    onSuccess: (r) => {
      toast.success(
        r.data.applied === 'glossary'
          ? 'Added to the glossary'
          : r.data.applied === 'global-guide'
            ? 'Added to the global data guide'
            : `Added to the ${r.data.target} data guide`
      )
      done()
    },
    onError: (e) => toast.error(errMsg(e, 'Could not accept'))
  })
  const dismiss = useMutation({
    mutationFn: () => client.request(post(`/ai-knowledge/suggestions/${s.id}/dismiss`)),
    onSuccess: done,
    onError: (e) => toast.error(errMsg(e, 'Could not dismiss'))
  })
  const pending = s.status === 'pending'
  const evidence = s.evidence.filter(
    (e): e is { question?: string; note?: string; source?: string } => !!e && typeof e === 'object'
  )
  return (
    <li
      data-ai-suggestion={s.id}
      className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'
    >
      <div className='mb-2 flex flex-wrap items-center gap-2 text-[11px]'>
        <span
          className={cn(
            'rounded px-1.5 py-px font-medium',
            s.kind === 'glossary'
              ? 'bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300'
              : 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300'
          )}
        >
          {s.kind === 'glossary' ? 'Glossary term' : 'Data guide line'}
        </span>
        <span className='text-muted-foreground'>from {s.source}</span>
        {s.created_at && (
          <span className='text-muted-foreground'>
            · {new Date(s.created_at).toLocaleDateString()}
          </span>
        )}
        {!pending && <span className='ml-auto capitalize text-muted-foreground'>{s.status}</span>}
      </div>
      {s.kind === 'glossary' ? (
        <div className='grid gap-2 md:grid-cols-2'>
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            disabled={!pending}
            className='h-8 text-[12.5px]'
            aria-label='Term'
          />
          <Input
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            disabled={!pending}
            placeholder='Aliases, comma separated'
            className='h-8 text-[12.5px]'
            aria-label='Aliases'
          />
          <Textarea
            value={definition}
            onChange={(e) => setDefinition(e.target.value)}
            disabled={!pending}
            rows={2}
            className='text-[12.5px] md:col-span-2'
            aria-label='Definition'
          />
        </div>
      ) : (
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!pending}
          rows={2}
          className='text-[12.5px]'
          aria-label='Guide line'
        />
      )}
      {pending && (
        <div className='mt-2 max-w-[320px]'>
          <CollectionSelect
            value={collection}
            onChange={setCollection}
            emptyLabel={s.kind === 'glossary' ? 'Every collection' : 'Global data guide'}
          />
        </div>
      )}
      {s.reason && <p className='mt-2 text-[11.5px] text-muted-foreground'>Why: {s.reason}</p>}
      {evidence.length > 0 && (
        <details className='mt-1 text-[11.5px] text-muted-foreground'>
          <summary className='cursor-pointer'>Evidence ({evidence.length})</summary>
          <ul className='mt-1 flex flex-col gap-1 pl-3'>
            {evidence.map((e, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static evidence list
              <li key={i}>
                {e.question && <span className='text-foreground'>“{e.question}”</span>}
                {e.note && <> — {e.note}</>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {pending && (
        <div className='mt-2 flex gap-2'>
          <Button
            size='sm'
            className='h-7 gap-1 bg-nvr-cyan px-2.5 text-[12px] text-white hover:bg-nvr-cyan/90'
            disabled={accept.isPending}
            onClick={() => accept.mutate()}
          >
            <Check className='h-3.5 w-3.5' /> Accept
          </Button>
          <Button
            size='sm'
            variant='ghost'
            className='h-7 gap-1 px-2.5 text-[12px]'
            disabled={dismiss.isPending}
            onClick={() => dismiss.mutate()}
          >
            <X className='h-3.5 w-3.5' /> Dismiss
          </Button>
        </div>
      )}
    </li>
  )
}

function SuggestionsTab() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [status, setStatus] = useState('pending')
  const q = useQuery({
    queryKey: ['nvr-ai-knowledge-suggestions', status],
    queryFn: () =>
      client.request<{ data: Suggestion[] }>(get('/ai-knowledge/suggestions', { status }))
  })
  const draft = useMutation({
    mutationFn: (source: 'corrections' | 'data') =>
      client.request<{ data: { kind: string; created: number } }>(
        post('/ai-knowledge/suggestions/draft', { source })
      ),
    onSuccess: (r) => {
      toast.success(
        r.data.created
          ? `${r.data.created} new suggestion${r.data.created === 1 ? '' : 's'}`
          : 'Nothing new to suggest'
      )
      void qc.invalidateQueries({ queryKey: ['nvr-ai-knowledge-suggestions'] })
    },
    onError: (e) => toast.error(errMsg(e, 'Drafting failed'))
  })
  const rows = q.data?.data ?? []
  return (
    <div className='flex flex-col gap-3' data-ai-suggestions>
      <div className='flex flex-wrap items-center gap-2'>
        <Button
          size='sm'
          variant='outline'
          className='h-8 gap-1 text-[12px]'
          disabled={draft.isPending}
          onClick={() => draft.mutate('corrections')}
        >
          <Wand2 className='h-3.5 w-3.5' /> Draft guide lines from corrections
        </Button>
        <Button
          size='sm'
          variant='outline'
          className='h-8 gap-1 text-[12px]'
          disabled={draft.isPending}
          onClick={() => draft.mutate('data')}
        >
          <BookOpen className='h-3.5 w-3.5' /> Draft glossary from the data
        </Button>
        <div className='w-[140px]'>
          <SimpleSelect
            value={status}
            onChange={setStatus}
            ariaLabel='Status'
            className='h-8 text-[12px]'
            options={[
              { value: 'pending', label: 'Pending' },
              { value: 'accepted', label: 'Accepted' },
              { value: 'dismissed', label: 'Dismissed' },
              { value: 'all', label: 'All' }
            ]}
          />
        </div>
        {draft.isPending && (
          <span className='text-[11.5px] text-muted-foreground'>Asking the model…</span>
        )}
      </div>
      <p className='text-[11.5px] text-muted-foreground'>
        Guide lines come from thumbs-down reasons and other corrections; glossary terms from choice
        lists, field help text and the docs. Nothing changes until you accept it.
      </p>
      {q.isLoading ? (
        <p className='text-[12px] text-muted-foreground'>Loading…</p>
      ) : !rows.length ? (
        <div className='rounded-lg border border-dashed border-slate-300 p-8 text-center text-[12.5px] text-muted-foreground dark:border-border'>
          No {status === 'all' ? '' : `${status} `}suggestions.
        </div>
      ) : (
        <ul className='flex flex-col gap-2'>
          {rows.map((s) => (
            <SuggestionCard key={`${s.id}-${s.status}`} s={s} />
          ))}
        </ul>
      )}
    </div>
  )
}

// ─── Docs gaps ───────────────────────────────────────────────────────────────

interface GapTopic {
  topic: string
  count: number
  people: number
  examples: string[]
  last_at: string
  ids: number[]
}

interface DocsHit {
  id: string
  label: string
  group: string
  heading: string | null
  snippet: string
  coverage: number
  path: string
}

function DocsTry() {
  const client = useNivaroClient()
  const [q, setQ] = useState('')
  const [asked, setAsked] = useState('')
  const r = useQuery({
    queryKey: ['nvr-ai-docs-search', asked],
    enabled: !!asked,
    queryFn: () =>
      client.request<{ data: { hits: DocsHit[]; answered: boolean } }>(
        get('/ai-knowledge/docs-search', { q: asked })
      )
  })
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
      <form
        className='flex gap-2'
        onSubmit={(e) => {
          e.preventDefault()
          setAsked(q.trim())
        }}
      >
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder='Try the docs search Ask AI uses — how do I bulk update records?'
          className='h-8 text-[12.5px]'
        />
        <Button size='sm' variant='outline' className='h-8 text-[12px]' type='submit'>
          Search
        </Button>
      </form>
      {asked && r.data && (
        <div className='mt-2 text-[12px]'>
          <p className='mb-1 text-muted-foreground'>
            {r.data.data.answered
              ? 'Answered from the docs:'
              : r.data.data.hits.length
                ? 'Only a partial match — Ask AI would log this as a gap:'
                : 'No section covers this — Ask AI would log it as a gap.'}
          </p>
          <ul className='flex flex-col gap-1.5'>
            {r.data.data.hits.map((h) => (
              <li key={h.id}>
                <a href={h.path} className='font-medium underline underline-offset-2'>
                  {h.label}
                </a>
                <span className='text-muted-foreground'>
                  {' '}
                  · {h.group}
                  {h.heading ? ` › ${h.heading}` : ''} · {Math.round(h.coverage * 100)}% of words
                </span>
                <p className='text-muted-foreground'>{h.snippet}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function GapsTab() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [days, setDays] = useState('90')
  const q = useQuery({
    queryKey: ['nvr-ai-docs-gaps', days],
    queryFn: () =>
      client.request<{ data: { topics: GapTopic[]; total: number; answered_since: number } }>(
        get('/ai-knowledge/docs-gaps', { days })
      )
  })
  const dismiss = useMutation({
    mutationFn: (ids: number[]) => client.request(post('/ai-knowledge/docs-gaps/dismiss', { ids })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['nvr-ai-docs-gaps'] }),
    onError: (e) => toast.error(errMsg(e, 'Could not dismiss'))
  })
  const d = q.data?.data
  return (
    <div className='flex flex-col gap-3' data-ai-docs-gaps>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='w-[140px]'>
          <SimpleSelect
            value={days}
            onChange={setDays}
            ariaLabel='Window'
            className='h-8 text-[12px]'
            options={[
              { value: '30', label: 'Last 30 days' },
              { value: '90', label: 'Last 90 days' },
              { value: '365', label: 'Last year' }
            ]}
          />
        </div>
        <button
          type='button'
          onClick={() => void q.refetch()}
          className='inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-[12px] text-muted-foreground hover:bg-muted'
        >
          <RotateCw className='h-3.5 w-3.5' /> Refresh
        </button>
        {d && (
          <span className='text-[11.5px] text-muted-foreground'>
            {d.total} unanswered question{d.total === 1 ? '' : 's'} in {d.topics.length} topic
            {d.topics.length === 1 ? '' : 's'}
            {d.answered_since > 0 && ` · ${d.answered_since} now answered by newer docs`}
          </span>
        )}
      </div>
      <p className='text-[11.5px] text-muted-foreground'>
        Questions Ask AI searched the docs for and found nothing that answers them — a list of docs
        to write. A topic drops off by itself once a docs section answers it.
      </p>
      <DocsTry />
      {q.isLoading ? (
        <p className='text-[12px] text-muted-foreground'>Loading…</p>
      ) : !d?.topics.length ? (
        <div className='rounded-lg border border-dashed border-slate-300 p-8 text-center text-[12.5px] text-muted-foreground dark:border-border'>
          No docs gaps in this window.
        </div>
      ) : (
        <ul className='flex flex-col gap-2'>
          {d.topics.map((t) => (
            <li
              key={t.ids[0]}
              className='rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'
            >
              <div className='flex flex-wrap items-baseline gap-2'>
                <span className='text-[13px] font-semibold'>{t.topic}</span>
                <span className='text-[11.5px] text-muted-foreground'>
                  {t.count} question{t.count === 1 ? '' : 's'} · {t.people}{' '}
                  {t.people === 1 ? 'person' : 'people'} · last{' '}
                  {new Date(t.last_at).toLocaleDateString()}
                </span>
                <Button
                  size='sm'
                  variant='ghost'
                  className='ml-auto h-7 px-2 text-[11.5px]'
                  disabled={dismiss.isPending}
                  onClick={() => dismiss.mutate(t.ids)}
                >
                  Dismiss
                </Button>
              </div>
              <ul className='mt-1 list-disc pl-5 text-[12px] text-slate-700 dark:text-slate-300'>
                {t.examples.map((ex) => (
                  <li key={ex}>{ex}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─── View ────────────────────────────────────────────────────────────────────

export function AiKnowledgeView({
  isAdmin,
  tab,
  onTabChange,
  focusTerm
}: {
  isAdmin: boolean
  tab?: AiKnowledgeTab
  onTabChange?: (t: AiKnowledgeTab) => void
  /** A glossary slug to scroll to and highlight (term links from answers). */
  focusTerm?: string | null
}) {
  const [local, setLocal] = useState<AiKnowledgeTab>(tab ?? 'glossary')
  const tabs = TABS.filter((t) => isAdmin || !t.admin)
  const requested = tab ?? local
  const active = tabs.some((t) => t.id === requested) ? requested : 'glossary'
  const [localTerm, setLocalTerm] = useState<string | null>(null)
  const openSide = (side: FindingSide) => {
    if (side.type === 'glossary') setLocalTerm(side.ref)
    select(side.type === 'glossary' ? 'glossary' : 'guides')
  }
  const select = (t: AiKnowledgeTab) => {
    setLocal(t)
    onTabChange?.(t)
  }
  return (
    <div className='flex flex-col gap-4' data-ai-knowledge>
      {tabs.length > 1 && (
        <div className='inline-flex w-fit max-w-full overflow-x-auto rounded-md border border-border p-0.5'>
          {tabs.map((t) => (
            <button
              key={t.id}
              type='button'
              onClick={() => select(t.id)}
              aria-pressed={active === t.id}
              className={cn(
                'shrink-0 whitespace-nowrap rounded px-3 py-1 text-[12.5px]',
                active === t.id
                  ? 'bg-nvr-cyan/15 font-medium'
                  : 'text-muted-foreground hover:bg-muted'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      {active === 'glossary' && (
        <GlossaryTab isAdmin={isAdmin} focusTerm={localTerm ?? focusTerm} />
      )}
      {active === 'guides' && <GuidesTab />}
      {active === 'suggestions' && <SuggestionsTab />}
      {active === 'gaps' && <GapsTab />}
      {active === 'conflicts' && <KnowledgeFindingsTab onOpenSide={openSide} />}
      {active === 'topics' && <TopicMapTab onOpenSuggestions={() => select('suggestions')} />}
      {active === 'index' && <EmbeddingFreshnessTab />}
      {active === 'checklists' && <RoleChecklistsTab />}
    </div>
  )
}
