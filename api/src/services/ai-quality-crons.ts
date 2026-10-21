import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { runCatalogueCheck } from './ai-catalogue.js'
import { parseQualityConfig } from './ai-quality.js'
import { buildForecast, notifyForecastAlerts, rollupSpendDays } from './ai-spend.js'

/**
 * The two nightly jobs behind AI quality's spend and model pages:
 *  - ai-spend-rollup (#2473, #2764): roll the call log up per day, then tell
 *    admins about a projection past a budget or last month (once per month).
 *  - ai-model-catalogue (#2732): which models does the provider answer for.
 * Like every cron they tick only where cronTicksEnabled(); Run now always works.
 */
export function registerAiQualityCrons(app: FastifyInstance): void {
  app.cron.schedule('ai-spend-rollup', '40 2 * * *', async () => {
    const { days } = await rollupSpendDays()
    const row = (await db('nivaro_settings').orderBy('id', 'asc').first('ai_models')) as
      | { ai_models?: string | null }
      | undefined
    const forecast = await buildForecast(parseQualityConfig(row?.ai_models))
    const told = await notifyForecastAlerts(forecast.alerts)
    if (days || told) app.log.info(`ai-spend: ${days} day(s) rolled up, ${told} admin(s) told`)
  })
  app.cron.schedule('ai-model-catalogue', '50 2 * * *', async () => {
    const r = await runCatalogueCheck()
    if (r.new_models.length || r.retired_models.length)
      app.log.info(
        `ai-catalogue: ${r.new_models.length} new, ${r.retired_models.length} retired model(s)`
      )
  })
}
