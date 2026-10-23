import { jsonErrorAt } from './json-diff'

// ─── Code tab: parse + minimum shape check for the field map as JSON ────────
// The server's validateSpec is the real check (its errors arrive with the
// draft save). This only keeps a structurally broken spec out of the field
// map, which expects every row to be an object with an id, key and type.

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

function fieldsError(fields: unknown, at: string): string | null {
  if (!Array.isArray(fields)) return `${at} must be a list`
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    const here = `${at}[${i}]`
    if (!isObj(f)) return `${here} must be an object`
    if (typeof f.id !== 'string' || !f.id) return `${here} needs an "id" (text)`
    if (typeof f.key !== 'string') return `${here} needs a "key" (text)`
    if (typeof f.type !== 'string') return `${here} needs a "type"`
    if (f.children !== undefined) {
      const e = fieldsError(f.children, `${here}.children`)
      if (e) return e
    }
  }
  return null
}

export type SpecParse = { ok: true; spec: unknown } | { ok: false; message: string }

/** Parse the Code tab's text into a field map, or say plainly what is wrong and where. */
export function parseSpecText(text: string): SpecParse {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch (e) {
    const at = jsonErrorAt(text, e)
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      message: at
        ? `Line ${at.line}, column ${at.column}: this isn't valid JSON (${msg})`
        : `This isn't valid JSON (${msg})`
    }
  }
  if (!isObj(v))
    return { ok: false, message: 'The field map must be a JSON object { "v": 1, "fields": [...] }' }
  if (v.v !== 1) return { ok: false, message: 'The field map needs "v": 1' }
  const e = fieldsError(v.fields, 'fields')
  return e ? { ok: false, message: e } : { ok: true, spec: v }
}
