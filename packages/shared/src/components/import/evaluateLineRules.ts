import { post } from '../../lib/commands'

interface Client {
  request<T>(cmd: unknown): Promise<T>
}

/** Rule-set marker on a staged import line: which of its keys an auto-fill
 *  rule wrote (the file's value, if any, did not survive). `__`-prefixed keys
 *  never reach the save payload. */
export const RULE_SET_KEY = '__rule_set'

/**
 * Run a grid's row rules over freshly parsed import lines (bounded to 10
 * concurrent evaluate calls — a large file must not open hundreds), merge
 * the derived values in, and mark each line with the keys the rules changed
 * versus what the file carried, so a review can say "set by rule" per column.
 */
export async function evaluateImportLineRules(
  client: Client,
  lineCollection: string,
  rowRules: unknown[],
  parentContext: Record<string, unknown>,
  rows: Record<string, unknown>[]
): Promise<{
  rows: Record<string, unknown>[]
  failed: boolean
  ruleFields: Record<string, number>
}> {
  if (rowRules.length === 0 || rows.length === 0) return { rows, failed: false, ruleFields: {} }
  const evaluated: Record<string, unknown>[] = []
  let failed = false
  const CHUNK = 10
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const results = await Promise.all(
      chunk.map((row) => {
        const data = Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('__')))
        return client
          .request<{ updates: Record<string, unknown> }>(
            post('/field-rules/evaluate', {
              collection: lineCollection,
              data,
              parent_context: parentContext,
              row_rules: rowRules
            })
          )
          .then((res) => res.updates ?? {})
          .catch(() => {
            failed = true
            return {}
          })
      })
    )
    evaluated.push(...results)
  }
  const ruleFields: Record<string, number> = {}
  const same = (a: unknown, b: unknown) => String(a ?? '').trim() === String(b ?? '').trim()
  const merged = rows.map((row, i) => {
    const upd = evaluated[i] ?? {}
    const set: string[] = []
    for (const [k, v] of Object.entries(upd)) {
      if (same(row[k], v)) continue
      set.push(k)
      ruleFields[k] = (ruleFields[k] ?? 0) + 1
    }
    return set.length ? { ...row, ...upd, [RULE_SET_KEY]: set } : { ...row, ...upd }
  })
  return { rows: merged, failed, ruleFields }
}
