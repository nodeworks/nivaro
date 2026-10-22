import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Pencil, Trash2 } from 'lucide-react'
import { type KeyboardEvent, useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Search synonyms (#1581, admin only). A group of words that mean the same
 * thing to the people searching: a search for any of them also looks for the
 * others in list search boxes, pickers and Cmd+K. Added from a search that
 * found nothing (AddSynonymButton) or by hand (SynonymsCard).
 */

export interface SynonymGroup {
  id: number
  terms: string[]
  collection: string | null
  note?: string | null
}

const KEY = ['search-synonyms']
const splitTerms = (v: string) =>
  v
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
const errorText = (e: unknown) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
  'The synonym could not be saved.'

function useSaveSynonym(onDone?: () => void) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (b: { terms: string[]; collection: string | null }) =>
      api
        .post<{ data: SynonymGroup; meta: { merged: boolean } }>('/search-analytics/synonyms', b)
        .then((r) => r.data),
    onSuccess: (r) => {
      toast.success(r.meta.merged ? 'Added to an existing synonym group' : 'Synonym added', {
        description: r.data.terms.join(' · ')
      })
      qc.invalidateQueries({ queryKey: KEY })
      qc.invalidateQueries({ queryKey: ['search-analytics'] })
      onDone?.()
    },
    onError: (e) => toast.error(errorText(e))
  })
}

function Scope({
  value,
  onChange,
  collection
}: {
  value: 'here' | 'everywhere'
  onChange: (v: 'here' | 'everywhere') => void
  collection: string
}) {
  return (
    <span className='flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
      {(
        [
          ['here', `${collection} only`],
          ['everywhere', 'Everywhere']
        ] as const
      ).map(([v, label]) => (
        <button
          key={v}
          type='button'
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          className={cn(
            'min-w-0 flex-1 truncate rounded px-2 py-1 text-[11.5px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
            value === v
              ? 'bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
              : 'text-slate-500 hover:bg-muted hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
          )}
        >
          {label}
        </button>
      ))}
    </span>
  )
}

/**
 * The words two searches do not share: ("po 4471", "purchase order 4471") →
 * ["po", "purchase order"]. A rewording usually changes one word and keeps the
 * rest, and the synonym is the changed part — not the whole search.
 */
export function differingWords(a: string, b: string): [string, string] {
  const x = a.trim().split(/\s+/)
  const y = b.trim().split(/\s+/)
  const same = (p: string, q: string) => p.toLowerCase() === q.toLowerCase()
  let i = 0
  while (i < x.length - 1 && i < y.length - 1 && same(x[i], y[i])) i++
  let j = 0
  while (
    j < x.length - 1 - i &&
    j < y.length - 1 - i &&
    same(x[x.length - 1 - j], y[y.length - 1 - j])
  )
    j++
  return [x.slice(i, x.length - j).join(' '), y.slice(i, y.length - j).join(' ')]
}

const fieldLabel = 'block text-[11.5px] font-medium text-slate-600 dark:text-slate-300'

/** "Add a synonym" beside a search that found nothing — an anchored popover, prefilled with
 *  the words people changed when they searched again and found something. */
export function AddSynonymButton({
  query,
  collection,
  rewordedAs,
  className
}: {
  query: string
  collection: string | null
  rewordedAs?: { query: string; times: number } | null
  className?: string
}) {
  const initial = () => (rewordedAs ? differingWords(query, rewordedAs.query) : [query, ''])
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState(() => initial()[0])
  const [words, setWords] = useState(() => initial()[1])
  const [scope, setScope] = useState<'here' | 'everywhere'>(collection ? 'here' : 'everywhere')
  const id = useId()
  const save = useSaveSynonym(() => setOpen(false))
  const terms = [term.trim(), ...splitTerms(words)].filter(Boolean)
  const distinct = new Set(terms.map((t) => t.toLowerCase())).size
  const submit = () => {
    if (distinct < 2 || save.isPending) return
    save.mutate({ terms, collection: scope === 'here' ? collection : null })
  }
  const onEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) {
          const [t, w] = initial()
          setTerm(t)
          setWords(w)
        }
      }}
    >
      <PopoverTrigger asChild>
        <button type='button' className={className}>
          Add a synonym
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[320px] space-y-3 p-3'>
        <div>
          <p className='text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
            Add a synonym
          </p>
          <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            A search for either side also finds records that match the other.
          </p>
        </div>
        <div className='space-y-1'>
          <label htmlFor={`${id}-term`} className={fieldLabel}>
            Word people searched
          </label>
          <Input
            id={`${id}-term`}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={onEnter}
            className='h-8 font-mono text-[12px]'
          />
        </div>
        <div className='space-y-1'>
          <label htmlFor={`${id}-words`} className={fieldLabel}>
            Also look for
          </label>
          <Input
            id={`${id}-words`}
            autoFocus
            value={words}
            onChange={(e) => setWords(e.target.value)}
            onKeyDown={onEnter}
            placeholder='e.g. purchase order, PO'
            className='h-8 text-[12px]'
          />
          <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
            Separate several with commas.
          </span>
        </div>
        {rewordedAs && (
          <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            After finding nothing, people searched{' '}
            <span className='font-mono text-slate-700 dark:text-slate-200'>{rewordedAs.query}</span>{' '}
            and got results{rewordedAs.times > 1 ? ` (${rewordedAs.times} times)` : ''}.
          </p>
        )}
        {collection ? (
          <Scope value={scope} onChange={setScope} collection={collection} />
        ) : (
          <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            Applies everywhere: Cmd+K, list search boxes and pickers.
          </p>
        )}
        <div className='flex justify-end gap-2'>
          <Button
            variant='ghost'
            size='sm'
            className='h-7 text-[12px]'
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            size='sm'
            className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/90'
            disabled={distinct < 2 || save.isPending}
            onClick={submit}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ScopePicker({
  value,
  onChange
}: {
  value: string | null
  onChange: (v: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const { data: collections = [] } = useQuery<Array<{ collection: string }>>({
    queryKey: ['collections-list'],
    queryFn: () =>
      api
        .get<{ data?: Array<{ collection: string }> }>('/collections')
        .then((r) => r.data.data ?? []),
    staleTime: 60_000
  })
  const pick = (v: string | null) => {
    onChange(v)
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          size='sm'
          aria-label='Where the synonym applies'
          className='h-8 w-[200px] shrink-0 justify-between text-[12px] font-normal'
        >
          <span className={cn('truncate', value && 'font-mono')}>{value ?? 'Everywhere'}</span>
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[260px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search collections…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty>No collections.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value='__everywhere__'
                onSelect={() => pick(null)}
                className='text-[12px]'
              >
                <Check
                  className={cn('mr-2 h-3.5 w-3.5', value == null ? 'opacity-100' : 'opacity-0')}
                />
                Everywhere
              </CommandItem>
              {collections
                .filter((c) => !c.collection.startsWith('nivaro_'))
                .map((c) => (
                  <CommandItem
                    key={c.collection}
                    value={c.collection}
                    onSelect={() => pick(c.collection)}
                    className='text-[12px]'
                  >
                    <Check
                      className={cn(
                        'mr-2 h-3.5 w-3.5',
                        value === c.collection ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    <span className='font-mono'>{c.collection}</span>
                  </CommandItem>
                ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

const chip =
  'inline-flex items-center rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11.5px] text-slate-700 dark:bg-muted dark:text-foreground'

function GroupRow({ g }: { g: SynonymGroup }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [draft, setDraft] = useState('')
  const done = () => {
    qc.invalidateQueries({ queryKey: KEY })
    qc.invalidateQueries({ queryKey: ['search-analytics'] })
  }
  const update = useMutation({
    mutationFn: (terms: string[]) => api.patch(`/search-analytics/synonyms/${g.id}`, { terms }),
    onSuccess: () => {
      setEditing(false)
      done()
    },
    onError: (e) => toast.error(errorText(e))
  })
  const remove = useMutation({
    mutationFn: () => api.delete(`/search-analytics/synonyms/${g.id}`),
    onSuccess: () => {
      toast.success('Synonym removed')
      done()
    },
    onError: () => toast.error('The synonym could not be removed.')
  })

  return (
    <li className='flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-slate-100 py-2 first:border-t-0 dark:border-border'>
      {editing ? (
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') update.mutate(splitTerms(draft))
            if (e.key === 'Escape') setEditing(false)
          }}
          aria-label='Words in this group, comma-separated'
          className='h-7 min-w-[220px] flex-1 text-[12px]'
        />
      ) : (
        <span className='flex min-w-0 flex-1 flex-wrap items-center gap-1'>
          {g.terms.map((t) => (
            <span key={t} className={chip}>
              {t}
            </span>
          ))}
        </span>
      )}
      <span
        className={cn(
          'w-[160px] shrink-0 truncate text-[11.5px] text-slate-500 dark:text-muted-foreground',
          g.collection && 'font-mono'
        )}
      >
        {g.collection ?? 'Everywhere'}
      </span>
      <span className='flex w-[132px] shrink-0 items-center justify-end gap-1'>
        {editing ? (
          <>
            <Button
              variant='ghost'
              size='sm'
              className='h-7 text-[12px]'
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button
              size='sm'
              className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/90'
              disabled={splitTerms(draft).length < 2 || update.isPending}
              onClick={() => update.mutate(splitTerms(draft))}
            >
              Save
            </Button>
          </>
        ) : confirming ? (
          <>
            <span className='text-[11.5px] text-slate-600 dark:text-slate-300'>Delete?</span>
            <Button
              variant='ghost'
              size='sm'
              className='h-7 text-[12px] text-red-600 hover:text-red-700 dark:text-red-400'
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Yes
            </Button>
            <Button
              variant='ghost'
              size='sm'
              className='h-7 text-[12px]'
              onClick={() => setConfirming(false)}
            >
              No
            </Button>
          </>
        ) : (
          <>
            <Button
              variant='ghost'
              size='sm'
              className='h-7 w-7 p-0'
              aria-label={`Edit ${g.terms.join(', ')}`}
              data-tip='Edit'
              onClick={() => {
                setDraft(g.terms.join(', '))
                setEditing(true)
              }}
            >
              <Pencil className='!h-3.5 !w-3.5' />
            </Button>
            <Button
              variant='ghost'
              size='sm'
              className='h-7 w-7 p-0 text-slate-500 hover:text-red-600 dark:hover:text-red-400'
              aria-label={`Delete ${g.terms.join(', ')}`}
              data-tip='Delete'
              onClick={() => setConfirming(true)}
            >
              <Trash2 className='!h-3.5 !w-3.5' />
            </Button>
          </>
        )}
      </span>
    </li>
  )
}

export function SynonymsCard() {
  const [words, setWords] = useState('')
  const [collection, setCollection] = useState<string | null>(null)
  const { data: groups = [], isLoading } = useQuery({
    queryKey: KEY,
    queryFn: () =>
      api.get<{ data: SynonymGroup[] }>('/search-analytics/synonyms').then((r) => r.data.data)
  })
  const save = useSaveSynonym(() => setWords(''))
  const terms = splitTerms(words)
  const submit = () => {
    if (terms.length >= 2 && !save.isPending) save.mutate({ terms, collection })
  }

  return (
    <section className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>Synonyms</h2>
      <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        Words that mean the same thing to the people searching. A search for any word in a group
        also finds the others, in list search boxes, pickers and Cmd+K. It never shows anyone a
        record they could not already open. Changes reach every server within 30 seconds.
      </p>
      <div className='mt-3 flex flex-wrap items-center gap-2'>
        <Input
          value={words}
          onChange={(e) => setWords(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          placeholder='Words that mean the same, e.g. PO, purchase order'
          aria-label='New synonym group, comma-separated'
          className='h-8 min-w-[240px] flex-1 text-[12px]'
        />
        <ScopePicker value={collection} onChange={setCollection} />
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/90'
          disabled={terms.length < 2 || save.isPending}
          onClick={submit}
        >
          Add
        </Button>
      </div>
      {isLoading ? null : groups.length === 0 ? (
        <p className='mt-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No synonyms yet. Add one here, or from a search above that found nothing.
        </p>
      ) : (
        <ul className='mt-3'>
          {groups.map((g) => (
            <GroupRow key={g.id} g={g} />
          ))}
        </ul>
      )}
    </section>
  )
}
