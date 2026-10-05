/**
 * Shared input-schema pieces.
 *
 * Several MCP clients hand object arguments over as JSON strings; the filter
 * and data inputs accept both shapes and normalise to an object.
 */
import { z } from 'zod'

export const MAX_LIMIT = 200
export const DEFAULT_LIMIT = 25

export const jsonObject = z.union([z.record(z.unknown()), z.string()])

export function toObject(
  value: Record<string, unknown> | string | undefined
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error('Expected a JSON object')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object')
  }
  return parsed as Record<string, unknown>
}

export const stringList = z.union([z.array(z.string()), z.string()])

export function toList(value: string[] | string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const list = Array.isArray(value)
    ? value
    : value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
  return list.length > 0 ? list : undefined
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT)
}

export const collectionName = z
  .string()
  .min(1)
  .describe('Collection name as registered in the instance, e.g. "articles".')

export const recordId = z
  .union([z.string(), z.number()])
  .describe('Primary key of the record (integer or uuid).')
