import { db } from '../db/index.js'
import { getAnthropicClient } from '../hooks/ai-validation.js'

// ---------------------------------------------------------------------------
// Statistical anomaly detection for the alert engine.
//
// An alert definition with detection_type='anomaly' compares the latest value
// of a numeric field against the mean of recent history (last 200 rows): the
// value is anomalous when |value - mean| > sensitivity * stddev. A short
// Claude explanation is attached when an API key is configured.
// ---------------------------------------------------------------------------

const EXPLANATION_MODEL = 'claude-haiku-4-5'
const MIN_SAMPLES = 5
const MAX_ROWS = 200

export interface AnomalyAlertDef {
  id: number
  name: string
  collection: string
  field: string
  filters: string | null
  sensitivity: number | null
}

export interface AnomalyResult {
  anomalous: boolean
  value: number
  mean: number
  stddev: number
  zscore: number
  /** id of the row that was evaluated (latest row when no explicit value given) */
  item: string | null
  explanation?: string
}

function parseFilters(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function explainAnomaly(
  def: AnomalyAlertDef,
  value: number,
  mean: number,
  stddev: number,
  zscore: number
): Promise<string | undefined> {
  try {
    const client = await getAnthropicClient()
    if (!client) return undefined

    const message = await client.messages.create({
      model: EXPLANATION_MODEL,
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: `The field "${def.field}" of collection "${def.collection}" has a new value of ${value}. The recent mean is ${mean.toFixed(2)} with a standard deviation of ${stddev.toFixed(2)} (z-score ${zscore.toFixed(2)}). In one short sentence, explain to a business user why this value is unusual. Return only the sentence.`
        }
      ]
    })
    const text = message.content[0]?.type === 'text' ? message.content[0].text.trim() : ''
    return text ? text.slice(0, 400) : undefined
  } catch {
    // Explanation is optional — never fail anomaly evaluation because of it
    return undefined
  }
}

/**
 * Evaluate an anomaly alert definition.
 *
 * Fetches up to the last 200 values of def.field (newest first, equality
 * filters applied), computes mean + stddev, then tests either the supplied
 * `current` value (e.g. the record that just changed) or the latest row.
 *
 * Returns null when there is not enough numeric history to judge.
 */
export async function evaluateAnomalyAlert(
  def: AnomalyAlertDef,
  current?: { value: number; item: string | null }
): Promise<AnomalyResult | null> {
  const filters = parseFilters(def.filters)

  let query = db(def.collection).select('*').orderBy('id', 'desc').limit(MAX_ROWS)
  for (const [key, val] of Object.entries(filters)) {
    query = query.where(key, val as string)
  }
  const rows = (await query) as Array<Record<string, unknown>>

  const series: Array<{ value: number; item: string | null }> = []
  for (const row of rows) {
    const raw = row[def.field]
    if (raw == null) continue
    const num = Number.parseFloat(String(raw))
    if (Number.isNaN(num)) continue
    series.push({ value: num, item: row.id != null ? String(row.id) : null })
  }
  if (series.length < MIN_SAMPLES) return null

  const values = series.map((s) => s.value)
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  const stddev = Math.sqrt(variance)

  const target = current ?? series[0] // rows are newest-first
  const sensitivity = def.sensitivity != null && def.sensitivity > 0 ? def.sensitivity : 2.0

  const zscore = stddev === 0 ? 0 : (target.value - mean) / stddev
  const anomalous = stddev > 0 && Math.abs(target.value - mean) > sensitivity * stddev

  const result: AnomalyResult = {
    anomalous,
    value: target.value,
    mean,
    stddev,
    zscore,
    item: target.item
  }

  if (anomalous) {
    result.explanation = await explainAnomaly(def, target.value, mean, stddev, zscore)
  }

  return result
}
