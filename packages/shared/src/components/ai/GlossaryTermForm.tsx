import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import type { GlossaryTerm } from '../../lib/glossary'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { SimpleSelect } from '../ui/SimpleSelect'
import { Textarea } from '../ui/textarea'

/**
 * The glossary term editor and the business-collection picker, shared by the
 * Knowledge console's Glossary and Data guides tabs and by the topic map's
 * "Add a glossary term" action (prefilled from a topic's questions).
 */

export function useCollections(enabled: boolean) {
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

export function CollectionSelect({
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

export type TermDraft = {
  term: string
  definition: string
  aliases: string
  collection: string
  query_slug: string
  query_note: string
}

export const blankDraft: TermDraft = {
  term: '',
  definition: '',
  aliases: '',
  collection: '',
  query_slug: '',
  query_note: ''
}

export const toDraft = (t: GlossaryTerm): TermDraft => ({
  term: t.term,
  definition: t.definition,
  aliases: t.aliases.join(', '),
  collection: t.collection ?? '',
  query_slug: t.query_slug ?? '',
  query_note: t.query_note ?? ''
})

export const fromDraft = (d: TermDraft) => ({
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

export function TermForm({
  initial,
  busy,
  onSave,
  onCancel,
  onDraftChange
}: {
  initial: TermDraft
  busy: boolean
  onSave: (d: TermDraft) => void
  onCancel: () => void
  /** Every edit, for a host that shows what the draft would change. */
  onDraftChange?: (d: TermDraft) => void
}) {
  const [d, setD] = useState(initial)
  const set = (k: keyof TermDraft) => (v: string) =>
    setD((p) => {
      const next = { ...p, [k]: v }
      onDraftChange?.(next)
      return next
    })
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
