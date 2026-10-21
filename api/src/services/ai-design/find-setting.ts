import { type AiComplete, asArray, cleanText, parseJsonLoose } from './model.js'

/**
 * "Where do I turn off comments?" (#2676), AI half. The editor searches its
 * own settings index first (Form settings registry + every inspector control,
 * parity-keys.json); only a question that search cannot place comes here,
 * with the candidate index it searched. The model picks keys FROM THAT LIST
 * — anything else is dropped — and the editor jumps to the first one.
 */

export const MAX_CANDIDATES = 400
export const MAX_PICKS = 3

export interface SettingCandidate {
  key: string
  label: string
  where: string
}

export const FIND_SETTING_SYSTEM = `You help an administrator find a control in a form-layout editor.
You get their question and the list of every control (key, label, where it lives).
Answer with ONE JSON object and nothing else: {"keys":["<key>", ...],"explanation":"<one short sentence>"}.
Pick at most ${MAX_PICKS} keys, best first, only keys from the list. When nothing in the list fits, answer {"keys":[],"explanation":"<why>"}.`

export function cleanCandidates(raw: unknown): SettingCandidate[] {
  const out: SettingCandidate[] = []
  const seen = new Set<string>()
  for (const r of asArray(raw).slice(0, MAX_CANDIDATES)) {
    const o = (r ?? {}) as Record<string, unknown>
    const key = typeof o.key === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(o.key) ? o.key : null
    const label = cleanText(o.label, 160)
    if (!key || !label || seen.has(key)) continue
    seen.add(key)
    out.push({ key, label, where: cleanText(o.where, 80) ?? '' })
  }
  return out
}

export function buildFindPrompt(question: string, candidates: SettingCandidate[]): string {
  return JSON.stringify({
    question,
    controls: candidates.map((c) => [c.key, c.label, c.where])
  })
}

export function parseFindAnswer(
  text: string,
  candidates: SettingCandidate[]
): { keys: string[]; explanation: string | null; dropped: number } {
  const parsed = parseJsonLoose(text)
  if (!parsed) return { keys: [], explanation: null, dropped: 0 }
  const known = new Set(candidates.map((c) => c.key))
  const keys: string[] = []
  let dropped = 0
  for (const k of asArray(parsed.keys)) {
    if (typeof k === 'string' && known.has(k) && !keys.includes(k)) keys.push(k)
    else dropped++
  }
  return {
    keys: keys.slice(0, MAX_PICKS),
    explanation: cleanText(parsed.explanation, 300),
    dropped
  }
}

export async function findSetting(
  question: string,
  candidates: SettingCandidate[],
  complete: AiComplete
): Promise<{ keys: string[]; explanation: string | null; dropped: number }> {
  const answer = await complete({
    system: FIND_SETTING_SYSTEM,
    user: buildFindPrompt(question, candidates),
    maxTokens: 400
  })
  return parseFindAnswer(answer, candidates)
}
