import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { get, patch as patchCmd } from '../../../lib/commands'
import type { PlacementKey, PlacementPatch, PlacementRow } from '../../../lib/layout-ops'
import { parseSaveFailure } from '../useLayoutDraft'
import type { GlobalPending, GlobalWriter, InspectorEnv } from './kit'
import {
  asObject,
  describeField,
  type FieldInfo,
  type GlobalFieldRow,
  type Obj,
  type RelationRow,
  readOptions,
  readOverrides,
  withKey,
  withOption,
  withOverride
} from './model'

export interface CollectionMeta {
  fields: GlobalFieldRow[]
  relations: RelationRow[]
}

/** GET /collections/:c — the field rows (global settings) and relations. Same
 *  key and shape as the shared pickers' `collection-meta` reads. */
export function useCollectionMeta(collection: string | null | undefined) {
  const client = useNivaroClient()
  return useQuery<CollectionMeta>({
    queryKey: ['collection-meta', collection],
    queryFn: () =>
      client
        .request<{ data: CollectionMeta }>(get(`/collections/${collection}`))
        .then((r) => ({ fields: r.data?.fields ?? [], relations: r.data?.relations ?? [] })),
    enabled: !!collection,
    staleTime: 60_000
  })
}

export interface FieldCtx {
  env: InspectorEnv
  row: PlacementRow
  at: PlacementKey
  info: FieldInfo
  /** This form's overrides and overrides.options. */
  ov: Obj
  opts: Obj
  globals: GlobalFieldRow[]
  relations: RelationRow[]
  /** nivaro_fields.options / dependency_config (every form). */
  globalOptions: Obj
  globalDependency: Obj
  /** Read-only view (an inherited placement). */
  readOnly: boolean
  setOverride(key: string, value: unknown, label: string, text?: boolean): void
  setOption(key: string, value: unknown, label: string, text?: boolean): void
  /** Several option keys in one op (undefined removes a key). */
  setOptions(patch: Obj, label: string, text?: boolean): void
  setPlacement(patch: PlacementPatch, label: string, text?: boolean): void
  /** Propose an every-form option change; saved after the inline confirm. */
  proposeGlobalOption(settingKey: string, optionKey: string, value: unknown, label: string): void
  proposeGlobal(settingKey: string, value: unknown, patch: Obj, label: string): void
}

export const FieldCtxContext = createContext<FieldCtx | null>(null)

export function useFieldCtx(): FieldCtx {
  const ctx = useContext(FieldCtxContext)
  if (!ctx) throw new Error('Field inspector tabs render inside the field inspector')
  return ctx
}

/** Writes nivaro_fields after the inline confirm. Outside undo by design (spec §9.11). */
export function useGlobalWriter(
  collection: string,
  field: string,
  fieldLabel: string
): GlobalWriter {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [pending, setPending] = useState<GlobalPending | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return {
    collection,
    field,
    fieldLabel,
    pending,
    saving,
    error,
    propose: (p) => {
      setError(null)
      setPending(p)
    },
    cancel: () => {
      setError(null)
      setPending(null)
    },
    confirm: () => {
      if (!pending) return
      setSaving(true)
      setError(null)
      client
        .request(
          patchCmd(`/field-config/${collection}/${encodeURIComponent(field)}`, pending.patch)
        )
        .then(() => {
          setPending(null)
          toast.success(`${pending.label} — saved for every form`)
          // Every read of this collection's field rows (canvas, pickers, lists).
          return qc.invalidateQueries({
            predicate: (q) => (q.queryKey as unknown[]).includes(collection)
          })
        })
        .catch((e) => setError(parseSaveFailure(e, 'The field could not be saved').message))
        .finally(() => setSaving(false))
    }
  }
}

export function useFieldCtxValue({
  env,
  row,
  meta,
  writer,
  readOnly
}: {
  env: InspectorEnv
  row: PlacementRow
  meta: CollectionMeta
  writer: GlobalWriter
  readOnly: boolean
}): FieldCtx {
  return useMemo(() => {
    const at = { field: row.field, group_key: row.group_key }
    const info = describeField(row.field, meta.fields, meta.relations, row)
    const global = info.global
    const globalOptions = asObject(global?.options)
    const update = (p: PlacementPatch, label: string, text?: boolean) =>
      env.apply([{ op: 'update_placement', at, patch: p }], { label, text })
    return {
      env,
      row,
      at,
      info,
      ov: readOverrides(row),
      opts: readOptions(row),
      globals: meta.fields,
      relations: meta.relations,
      globalOptions,
      globalDependency: asObject(global?.dependency_config),
      readOnly,
      setOverride: (key, value, label, text) =>
        update({ overrides: withOverride(row, key, value) }, label, text),
      setOption: (key, value, label, text) =>
        update({ overrides: withOption(row, key, value) }, label, text),
      setOptions: (patch, label, text) => {
        let options: Obj | null = readOptions(row)
        for (const [k, v] of Object.entries(patch)) options = withKey(options ?? {}, k, v)
        update(
          { overrides: withKey(readOverrides(row), 'options', options ?? undefined) },
          label,
          text
        )
      },
      setPlacement: update,
      proposeGlobalOption: (settingKey, optionKey, value, label) =>
        writer.propose({
          key: settingKey,
          value,
          label,
          patch: { options: withKey(globalOptions, optionKey, value) }
        }),
      proposeGlobal: (settingKey, value, patch, label) =>
        writer.propose({ key: settingKey, value, label, patch })
    }
  }, [env, row, meta, writer, readOnly])
}
