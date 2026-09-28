import type {
  ImportProcessorDef,
  ImportProcessorResult,
  ImportProcessorTools
} from '@nivaro/extension-kit'
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import type { ImportRunItem, ImportRunPhase, ImportRunUnmatched } from './import-run-report.js'
import { createOne, deleteOne, updateOne } from './items.js'
import { recalcStoredRollupsForRecords } from './rollups.js'
import { runLongSql } from './run-long.js'
import type { ServiceImportSamples } from './staged-import-service.js'

export type {
  ImportProcessorDef,
  ImportProcessorInput,
  ImportProcessorResult,
  ImportProcessorTools,
  ImportWriteJob,
  ImportWriteOutcome
} from '@nivaro/extension-kit'

/**
 * Import processors — a staged import whose file does not map onto ONE
 * collection (a header and its lines, links between them, totals that follow
 * from the lines) is processed by code an extension registers, instead of by
 * a stored procedure or the single-collection `service` processor.
 *
 * A processor receives the parsed, header-mapped rows and a set of tools.
 * The tools are the only way it writes: every create / update / delete goes
 * through the items service as the person who queued the file, so revisions,
 * activity, rules, validation and hooks apply exactly as they do to an edit
 * made in the form. Writes run several at a time; work that follows from
 * many rows (stored rollups, set-based procedures) is called once, by the
 * processor, after the rows have landed.
 *
 * `definition.processor` names the registered key. 'service' and null/'proc'
 * keep their existing meaning.
 */

const KEY = /^[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*$/i
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const CHUNK = 900
const DEFAULT_WIDTH = 8
const MAX_WIDTH = 16

const processors = new Map<string, ImportProcessorDef>()

export function registerImportProcessor(def: ImportProcessorDef): void {
  if (!def || typeof def.run !== 'function')
    throw new Error('Import processor needs a run function')
  if (!KEY.test(def.key)) {
    throw new Error(`Import processor key "${def.key}" must look like "<extension>:<name>"`)
  }
  processors.set(def.key.toLowerCase(), def)
}

export function getImportProcessor(key: string | null | undefined): ImportProcessorDef | null {
  if (!key) return null
  return processors.get(String(key).toLowerCase()) ?? null
}

export function listImportProcessors(): Array<Omit<ImportProcessorDef, 'run'>> {
  return [...processors.values()].map(({ run: _run, ...rest }) => rest)
}

/** True for a value `processor` may hold besides null / 'proc' / 'service'. */
export function isProcessorKey(value: unknown): boolean {
  return typeof value === 'string' && KEY.test(value)
}

function assertBusinessCollection(collection: string): void {
  if (!IDENT.test(collection) || /^nivaro_/i.test(collection)) {
    throw new Error(`Import processors may not write to "${collection}"`)
  }
}

export function buildImportTools(opts: {
  user: User
  stamp: string | null
  dryRun: boolean
}): ImportProcessorTools {
  const { user, stamp, dryRun } = opts
  const refuse = (what: string) => {
    if (dryRun) throw new Error(`A dry run must not ${what}`)
  }
  const stamped = (body: Record<string, unknown>) =>
    stamp ? { ...body, _change_reason: stamp } : { ...body }

  const inChunks: ImportProcessorTools['inChunks'] = async (values, fn) => {
    const out = []
    for (let i = 0; i < values.length; i += CHUNK) {
      out.push(...(await fn(values.slice(i, i + CHUNK))))
    }
    return out
  }

  const runWrites: ImportProcessorTools['runWrites'] = async (jobs, o) => {
    refuse('write')
    const width = Math.max(1, Math.min(MAX_WIDTH, o?.width ?? DEFAULT_WIDTH, jobs.length || 1))
    const began = performance.now()
    const failures: string[] = []
    let failed = 0
    let done = 0
    let next = 0
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++]
        try {
          await job.run()
          done++
        } catch (err) {
          failed++
          if (failures.length < 10) {
            const msg = err instanceof Error ? err.message : String(err)
            failures.push(`${job.label}: ${msg}`.slice(0, 300))
          }
        }
      }
    }
    await Promise.all(Array.from({ length: width }, worker))
    return { done, failed, failures, ms: Math.round(performance.now() - began) }
  }

  return {
    db,
    inChunks,
    async lookup(table, column, values) {
      if (!IDENT.test(table) || !IDENT.test(column)) {
        throw new Error(`Unsafe lookup: ${table}.${column}`)
      }
      const map = new Map<string, unknown>()
      const list = [...new Set([...values].map((v) => String(v).trim()).filter(Boolean))]
      const rows = await inChunks(list, (chunk) =>
        db(table)
          .whereIn(column, chunk as string[])
          .orderBy('id', 'asc')
          .select('id', column)
      )
      for (const r of rows as Array<Record<string, unknown>>) {
        const k = String(r[column] ?? '')
          .trim()
          .toLowerCase()
        if (!map.has(k)) map.set(k, r.id)
      }
      return map
    },
    async create(collection, body) {
      refuse('create records')
      assertBusinessCollection(collection)
      const made = (await createOne(user, collection, stamped(body), undefined, undefined, {
        skipRollupRecalc: true
      })) as { id?: unknown } | null
      return made?.id ?? null
    },
    async update(collection, id, patch) {
      refuse('update records')
      assertBusinessCollection(collection)
      await updateOne(user, collection, id, stamped(patch))
    },
    async remove(collection, id) {
      refuse('delete records')
      assertBusinessCollection(collection)
      await deleteOne(user, collection, id)
    },
    runWrites,
    async recalcStoredRollups(collection, ids) {
      refuse('recalculate rollups')
      assertBusinessCollection(collection)
      const unique = [...new Set(ids.map((i) => String(i)))]
      const out = await runWrites(
        unique.map((id) => ({
          label: `${collection} ${id} rollups`,
          run: async () => {
            await recalcStoredRollupsForRecords(collection, [id])
          }
        }))
      )
      return out.done
    },
    async runProcedure(name) {
      refuse('run procedures')
      if (!IDENT.test(name)) throw new Error(`Unsafe procedure name: ${name}`)
      const began = performance.now()
      await runLongSql(`EXEC ${name}`)
      return Math.round(performance.now() - began)
    }
  }
}

export interface RunImportProcessorOptions {
  processor: ImportProcessorDef
  definition: { key: string; label: string | null; service_config?: string | null }
  rows: Array<Record<string, string>>
  createdBy: string | null
  dryRun?: boolean
  sampleLimit?: number
  stamp?: string | null
  onProgress?: (done: number, total: number) => void | Promise<void>
}

function parseConfig(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function runImportProcessor({
  processor,
  definition,
  rows,
  createdBy,
  dryRun = false,
  sampleLimit = 25,
  stamp = null,
  onProgress
}: RunImportProcessorOptions): Promise<ImportProcessorResult> {
  if (!createdBy) throw new Error('This import needs a queuing user (created_by missing)')
  const user = (await db('nivaro_users').where('id', createdBy).first()) as User | undefined
  if (!user) throw new Error(`Queuing user ${createdBy} not found`)
  return processor.run({
    definition: {
      key: definition.key,
      label: definition.label ?? null,
      config: parseConfig(definition.service_config)
    },
    rows,
    dryRun,
    sampleLimit,
    tools: buildImportTools({ user, stamp, dryRun }),
    progress: (done, total) => {
      void Promise.resolve(onProgress?.(done, total)).catch(() => {})
    }
  })
}
