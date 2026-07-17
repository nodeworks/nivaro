import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { Input } from '../ui/input'
import { parseJson } from './helpers'
import { M2MStagingContext } from './M2MStagingContext'
import type { CMSField } from './types'

const NON_RELATION = new Set(['YY', 'YYYY', 'MM', 'seq', 'seq4', 'seq6'])
const RELATION_TOKEN_RE = /\{([A-Za-z0-9_]+)(?:\[0\])?[.\s%}][^}]*\}/g

function relationFirstSegments(pattern: string): string[] {
  const segs = new Set<string>()
  for (const m of pattern.matchAll(RELATION_TOKEN_RE)) {
    if (!NON_RELATION.has(m[1])) segs.add(m[1])
  }
  return [...segs]
}

// Read-only preview of a collection's `auto_id` pattern as the operator fills in
// the relation fields it depends on. Debounced POST to the preview endpoint;
// keeps the last good preview on request failure so a transient error never
// blanks the field.
export function AutoIdPreviewField({
  collection,
  field,
  draft,
  itemId
}: {
  collection: string
  field: CMSField
  draft: Record<string, unknown>
  itemId: string
}) {
  const client = useNivaroClient()
  const pattern = useMemo(
    () => parseJson<{ auto_id?: { pattern?: string } }>(field.options)?.auto_id?.pattern,
    [field.options]
  )
  const deps = useMemo(() => (pattern ? relationFirstSegments(pattern) : []), [pattern])
  // M2M selections on new records live in the staging context, not the draft —
  // fall back to staged links so tokens like {funding_years[0]} preview live.
  const staging = useContext(M2MStagingContext)
  const valueFor = (d: string): unknown => {
    if (draft[d] !== undefined) return draft[d]
    const staged = staging?.getStagedLinks(d) ?? []
    return staged.length ? staged : undefined
  }
  // Stable signature of only the values the pattern actually depends on —
  // typing in unrelated fields must not re-trigger the debounce/request cycle.
  // biome-ignore lint/correctness/useExhaustiveDependencies: valueFor reads draft+staging, both listed
  const depsKey = useMemo(() => JSON.stringify(deps.map(valueFor)), [deps, draft, staging])
  const stored = draft[field.field]
  // New records start blank until the first preview response; existing records
  // show the stored value immediately.
  const [preview, setPreview] = useState<string>(() =>
    itemId !== 'new' && typeof stored === 'string' ? stored : ''
  )
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: depsKey is the intentional proxy for deps/draft
  useEffect(() => {
    if (!pattern) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      try {
        const values: Record<string, unknown> = {}
        for (const d of deps) {
          const v = valueFor(d)
          if (v !== undefined) values[d] = v
        }
        const res = await client.request<{ preview: string }>(
          post(`/items/${collection}/auto-id-preview`, {
            field: field.field,
            values,
            record_id: itemId !== 'new' ? itemId : undefined
          })
        )
        if (res?.preview) setPreview(res.preview)
      } catch {
        // keep last good preview
      }
    }, 400)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [pattern, collection, field.field, itemId, depsKey])

  return (
    <Input value={preview} disabled readOnly className='h-8 text-[12px] text-muted-foreground' />
  )
}
