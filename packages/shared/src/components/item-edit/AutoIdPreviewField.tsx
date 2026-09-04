import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { type AutoIdConfigLike, autoIdVariantFields, resolveAutoIdPattern } from '../../lib/auto-id'
import { post } from '../../lib/commands'
import { Input } from '../ui/input'
import { parseJson } from './helpers'
import { M2MStagingContext, type M2MStagingCtx } from './M2MStagingContext'
import type { CMSField } from './types'

const NON_RELATION = new Set(['YY', 'YYYY', 'MM', 'seq', 'seq4', 'seq6'])

function relationFirstSegments(pattern: string): string[] {
  const segs = new Set<string>()
  for (const m of pattern.matchAll(/\{\s*([A-Za-z0-9_]+)(\[0\])?[^}]*\}/g)) {
    if (!NON_RELATION.has(m[1])) segs.add(m[1])
  }
  return [...segs]
}

// Live preview string for a collection's `auto_id` pattern as the operator fills
// in the relation fields it depends on. Debounced POST to the preview endpoint;
// keeps the last good preview on request failure so a transient error never
// blanks the value. Pass `staging` explicitly when calling from the component
// that PROVIDES M2MStagingContext (its own render sits above the provider).
export function useAutoIdPreview({
  collection,
  field,
  draft,
  itemId,
  staging
}: {
  collection: string
  field: CMSField | null
  draft: Record<string, unknown>
  itemId: string
  staging?: M2MStagingCtx | null
}): string {
  const client = useNivaroClient()
  const autoIdConfig = useMemo(
    () => parseJson<{ auto_id?: AutoIdConfigLike }>(field?.options ?? null)?.auto_id ?? null,
    [field?.options]
  )
  const variantFields = useMemo(() => autoIdVariantFields(autoIdConfig), [autoIdConfig])
  // The pattern itself can depend on the draft (variants keyed on e.g. workflow_type).
  const variantKey = JSON.stringify(variantFields.map((f) => draft[f]))
  // biome-ignore lint/correctness/useExhaustiveDependencies: variantKey is the proxy for the draft columns the variants read
  const pattern = useMemo(
    () => resolveAutoIdPattern(autoIdConfig, draft),
    [autoIdConfig, variantKey]
  )
  // Variant columns ride along so the server's preview picks the same pattern.
  const deps = useMemo(
    () => [...new Set([...(pattern ? relationFirstSegments(pattern) : []), ...variantFields])],
    [pattern, variantFields]
  )
  // M2M selections on new records live in the staging context, not the draft —
  // fall back to staged links so tokens like {funding_years[0]} preview live.
  const valueFor = (d: string): unknown => {
    if (draft[d] !== undefined) return draft[d]
    const staged = staging?.getStagedLinks(d) ?? []
    return staged.length ? staged : undefined
  }
  // Stable signature of only the values the pattern actually depends on —
  // typing in unrelated fields must not re-trigger the debounce/request cycle.
  // biome-ignore lint/correctness/useExhaustiveDependencies: valueFor reads draft+staging, both listed
  const depsKey = useMemo(() => JSON.stringify(deps.map(valueFor)), [deps, draft, staging])
  const stored = field ? draft[field.field] : undefined
  // New records start blank until the first preview response; existing records
  // show the stored value immediately.
  const [preview, setPreview] = useState<string>(() =>
    itemId !== 'new' && typeof stored === 'string' ? stored : ''
  )
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: depsKey is the intentional proxy for deps/draft
  useEffect(() => {
    if (!pattern || !field) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      try {
        const values: Record<string, unknown> = {}
        for (const d of deps) {
          const v = valueFor(d)
          if (v !== undefined) values[d] = v
        }
        const res = await client.request<{ preview: string; complete?: boolean }>(
          post(`/items/${collection}/auto-id-preview`, {
            field: field.field,
            values,
            record_id: itemId !== 'new' ? itemId : undefined
          })
        )
        // Only show fully-resolved IDs — a partial like '-####' or '26-####'
        // (some pattern token still unset) renders as nothing.
        setPreview(res?.complete && res.preview ? res.preview : '')
      } catch {
        // keep last good preview
      }
    }, 400)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [pattern, collection, field?.field, itemId, depsKey])

  return preview
}

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
  const staging = useContext(M2MStagingContext)
  const preview = useAutoIdPreview({ collection, field, draft, itemId, staging })
  return (
    <Input value={preview} disabled readOnly className='h-8 text-[12px] text-muted-foreground' />
  )
}
