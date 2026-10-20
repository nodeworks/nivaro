import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { get, patch as patchCmd } from '../../../lib/commands'
import type { PlacementKey, PlacementPatch, PlacementRow } from '../../../lib/layout-ops'
import { titleCase } from '../../../lib/utils'
import { parseSaveFailure } from '../useLayoutDraft'
import type { GlobalDraft, GlobalPending, GlobalWriter, InspectorEnv } from './kit'
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
  /** The collection's display name. */
  label: string
}

/** The key of the inspector's GET /collections/:c read. Namespaced: other
 *  readers keep different shapes under ['collection-meta', c]. */
export const collectionMetaKey = (collection: string | null | undefined) => [
  'layout-editor',
  'collection-meta',
  collection
]

/** GET /collections/:c — the field rows (global settings), relations and name. */
export function useCollectionMeta(collection: string | null | undefined) {
  const client = useNivaroClient()
  return useQuery<CollectionMeta>({
    queryKey: collectionMetaKey(collection),
    queryFn: () =>
      client
        .request<{
          data: {
            fields?: GlobalFieldRow[]
            relations?: RelationRow[]
            display_name?: string | null
          }
        }>(get(`/collections/${collection}`))
        .then((r) => ({
          fields: r.data?.fields ?? [],
          relations: r.data?.relations ?? [],
          label: r.data?.display_name || titleCase(collection ?? '')
        })),
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
  /** Propose an every-form option change; saved after the inline confirm.
   *  `shown` (default: value) is what the control shows meanwhile. */
  proposeGlobalOption(
    settingKey: string,
    optionKey: string,
    value: unknown,
    label: string,
    shown?: unknown
  ): void
  /** Same for a dependency_config key. */
  proposeGlobalDependency(settingKey: string, depKey: string, value: unknown, label: string): void
  /** Any every-form change, built on the pending draft. */
  proposeGlobal(
    settingKey: string,
    shown: unknown,
    label: string,
    change: (d: GlobalDraft) => GlobalDraft
  ): void
}

export const FieldCtxContext = createContext<FieldCtx | null>(null)

export function useFieldCtx(): FieldCtx {
  const ctx = useContext(FieldCtxContext)
  if (!ctx) throw new Error('Field inspector tabs render inside the field inspector')
  return ctx
}

/** Writes nivaro_fields after the inline confirm. Outside undo by design (spec §9.11).
 *  Every-form changes made before saving merge into one patch: options and
 *  dependency_config are rebuilt from what is stored plus each change, so a
 *  format then a currency both save. */
export function useGlobalWriter({
  collection,
  collectionLabel,
  field,
  fieldLabel,
  stored
}: {
  collection: string
  collectionLabel: string
  field: string
  fieldLabel: string
  /** nivaro_fields.options / dependency_config as stored. */
  stored: { options: Obj; dependency_config: Obj }
}): GlobalWriter {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [changes, setChanges] = useState<{
    draft: GlobalDraft
    values: Record<string, unknown>
    labels: Record<string, string>
    key: string
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const base: GlobalDraft = { ...stored, columns: {} }
  const draft = changes?.draft ?? base
  const pending: GlobalPending | null = changes
    ? {
        key: changes.key,
        values: changes.values,
        labels: Object.values(changes.labels),
        patch: globalPatch(stored, changes.draft)
      }
    : null
  return {
    collection,
    collectionLabel,
    field,
    fieldLabel,
    pending,
    draft,
    saving,
    error,
    propose: (key, value, label, change) => {
      setError(null)
      setChanges((prev) => ({
        draft: change(prev?.draft ?? base),
        values: { ...prev?.values, [key]: value },
        labels: { ...prev?.labels, [key]: label },
        key
      }))
    },
    cancel: () => {
      setError(null)
      setChanges(null)
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
          setChanges(null)
          toast.success(`${pending.labels.join('; ')} — saved for every form`)
          return Promise.all([
            qc.invalidateQueries({ queryKey: collectionMetaKey(collection) }),
            qc.invalidateQueries({
              queryKey: ['layout-editor', 'field-impact', collection, field]
            })
          ])
        })
        .catch((e) => setError(parseSaveFailure(e, 'The field could not be saved').message))
        .finally(() => setSaving(false))
    }
  }
}

/** PATCH /field-config body: only what differs from what is stored. */
export function globalPatch(stored: { options: Obj; dependency_config: Obj }, d: GlobalDraft): Obj {
  const out: Obj = { ...d.columns }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const orNull = (o: Obj) => (Object.keys(o).length ? o : null)
  if (!same(d.options, stored.options)) out.options = orNull(d.options)
  if (!same(d.dependency_config, stored.dependency_config))
    out.dependency_config = orNull(d.dependency_config)
  return out
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
      proposeGlobalOption: (settingKey, optionKey, value, label, shown = value) =>
        writer.propose(settingKey, shown, label, (d) => ({
          ...d,
          options: withKey(d.options, optionKey, value) ?? {}
        })),
      proposeGlobalDependency: (settingKey, depKey, value, label) =>
        writer.propose(settingKey, value, label, (d) => ({
          ...d,
          dependency_config: withKey(d.dependency_config, depKey, value) ?? {}
        })),
      proposeGlobal: (settingKey, shown, label, change) =>
        writer.propose(settingKey, shown, label, change)
    }
  }, [env, row, meta, writer, readOnly])
}
