import { createHash } from 'node:crypto'

/**
 * What one Ask AI tool call showed the model, reduced to a fingerprint
 * (#1809). The loop stamps it on every trace entry; when someone else opens a
 * shared conversation, the same call is re-run AS THEM and compared — equal
 * fingerprints mean the answer was built only from data they can read.
 *
 * Hashes exactly the text the model received (the loop sends the JSON cut at
 * 12,000 characters), so a fingerprint never depends on bytes the model did
 * not see.
 */
export const TOOL_RESULT_MODEL_CHARS = 12_000

export function toolResultText(result: unknown): string {
  return String(JSON.stringify(result)).slice(0, TOOL_RESULT_MODEL_CHARS)
}

export function hashToolResult(result: unknown): string {
  return createHash('sha1').update(toolResultText(result)).digest('hex')
}
