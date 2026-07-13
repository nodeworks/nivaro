import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { db } from '../db/index.js'

/**
 * Shared Anthropic client resolution — env key first, settings fallback —
 * extracted from routes/ai.ts so background jobs (ops briefs) can use the
 * same key/model configuration without importing route modules.
 */

export async function getAiClient(): Promise<Anthropic | null> {
  const key =
    config.ANTHROPIC_API_KEY ||
    (await db('nivaro_settings')
      .orderBy('id', 'asc')
      .first()
      .then((s: { anthropic_api_key?: string | null }) => s?.anthropic_api_key ?? null))
  if (!key) return null
  return new Anthropic({ apiKey: key })
}

export async function getAiModelSettings() {
  const row = await db('nivaro_settings')
    .orderBy('id', 'asc')
    .first('ai_model', 'ai_max_tokens_generate', 'ai_max_tokens_summarize')
    .catch(() => null)
  return {
    model: (row?.ai_model as string | null) ?? 'claude-haiku-4-5-20251001',
    maxTokensGenerate: (row?.ai_max_tokens_generate as number | null) ?? 500,
    maxTokensSummarize: (row?.ai_max_tokens_summarize as number | null) ?? 200
  }
}
