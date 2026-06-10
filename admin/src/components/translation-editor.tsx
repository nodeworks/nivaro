import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Inline per-field translation editor.
 *
 * Renders a small globe toggle button (place it next to the field label inside a
 * `flex flex-wrap` row) and, when open, a full-width row set with one input per
 * non-default locale. The first configured locale is treated as the default —
 * its value lives on the record itself, so it is not shown here.
 *
 * Saves via its own mutation: PATCH /field-translations/:collection/:item with
 * `{ [field]: { [locale]: value } }`. Hidden entirely when no locales beyond the
 * default are configured, or for unsaved items.
 */
export function TranslationEditor({
  collection,
  item,
  field,
  type
}: {
  collection: string
  item: string
  field: string
  type?: string
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [hydrated, setHydrated] = useState(false)

  const { data: locales } = useQuery({
    queryKey: ['translation-locales'],
    queryFn: () =>
      api
        .get<{ data: string[] }>('/field-translations/locales')
        .then((r) => r.data.data)
        .catch(() => ['en'] as string[]),
    staleTime: 5 * 60 * 1000
  })

  const extraLocales = (locales ?? []).slice(1)
  const enabled = open && !!collection && !!item && item !== 'new'

  const { data: translations, isLoading } = useQuery({
    queryKey: ['field-translations', collection, item, field],
    queryFn: () =>
      api
        .get<{ data: Record<string, string> }>(
          `/field-translations/${encodeURIComponent(collection)}/${encodeURIComponent(item)}/${encodeURIComponent(field)}`
        )
        .then((r) => r.data.data),
    enabled,
    staleTime: 30_000
  })

  // Hydrate the draft once translations arrive (and re-hydrate when re-opened fresh)
  useEffect(() => {
    if (translations && !hydrated) {
      setDraft(translations)
      setHydrated(true)
    }
  }, [translations, hydrated])

  const saveMut = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api.patch<{ data: Record<string, Record<string, string>> }>(
        `/field-translations/${encodeURIComponent(collection)}/${encodeURIComponent(item)}`,
        { [field]: body }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['field-translations', collection, item, field] })
      setHydrated(false)
      toast.success('Translations saved')
    },
    onError: () => toast.error('Failed to save translations')
  })

  // Hide when item is unsaved or only the default locale is configured
  if (!item || item === 'new' || extraLocales.length === 0) return null

  const defaultLocale = locales?.[0] ?? 'en'
  const isTextarea = type === 'text'
  const dirty = extraLocales.some((loc) => (draft[loc] ?? '') !== (translations?.[loc] ?? ''))
  const translatedCount = extraLocales.filter((loc) => (translations?.[loc] ?? '') !== '').length

  return (
    <>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium transition-colors',
          open
            ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
            : 'text-slate-400 hover:bg-nvr-cyan/10 hover:text-nvr-cyan'
        )}
        title='Field translations'
        aria-expanded={open}
      >
        <Globe className='h-3 w-3' />
        {translatedCount > 0 && <span>{translatedCount}</span>}
      </button>

      {open && (
        <div className='basis-full rounded-lg border border-nvr-cyan/30 bg-nvr-cyan/[0.03] p-3 mt-1 space-y-2.5'>
          <div className='flex items-center justify-between'>
            <span className='text-[11px] font-medium text-slate-500 dark:text-slate-400'>
              Translations
              <span className='ml-1.5 inline-flex items-center rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 dark:bg-muted dark:text-muted-foreground'>
                default: {defaultLocale}
              </span>
            </span>
            {isLoading && <Loader2 className='h-3 w-3 animate-spin text-slate-400' />}
          </div>

          {extraLocales.map((locale) => (
            <div key={locale} className='flex items-start gap-2'>
              <span className='mt-1.5 inline-flex w-12 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-nvr-navy dark:text-nvr-cyan'>
                {locale}
              </span>
              {isTextarea ? (
                <Textarea
                  value={draft[locale] ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [locale]: e.target.value }))}
                  rows={2}
                  className='text-[12px]'
                  placeholder={`${field} in ${locale}…`}
                />
              ) : (
                <Input
                  value={draft[locale] ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [locale]: e.target.value }))}
                  className='h-7 text-[12px]'
                  placeholder={`${field} in ${locale}…`}
                />
              )}
            </div>
          ))}

          <div className='flex justify-end'>
            <Button
              type='button'
              size='sm'
              className='h-6 bg-nvr-cyan px-2.5 text-[11px] text-white hover:bg-nvr-cyan/80'
              disabled={!dirty || saveMut.isPending}
              onClick={() => {
                const body: Record<string, string> = {}
                for (const loc of extraLocales) body[loc] = draft[loc] ?? ''
                saveMut.mutate(body)
              }}
            >
              {saveMut.isPending ? 'Saving…' : 'Save translations'}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
