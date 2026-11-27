import type { DocSection } from '../types.js'

// Live costs and estimates (Task 44a API, Task 44c screens). Facts are from the merged code:
// api/src/services/hub/providers/{estimate,costs-live}.ts, pricing/*, placement/chargeback.ts
// (estimateStack), routes/hub-placement.ts + hub-providers.ts, admin/src/pages/hub/costs/*.

export const hubCostsLiveDocs: DocSection = {
  id: 'hub-costs-live',
  label: 'Live costs and estimates',
  content: [
    { type: 'h1', id: 'hub-costs-live', text: 'Live costs and estimates — Hub mode only' },
    {
      type: 'warn',
      text: 'Everything here exists only on a Nivaro Hub (`HUB=on`). Every amount except Billed is an estimate: provider resources at list price, Docker stacks at the Hub’s own chargeback rates. The providers’ bills are the truth.'
    },
    {
      type: 'p',
      text: 'The Hub shows what things cost before you make them and while they run. Create forms show a running estimate, plans show each operation’s cost before → after and the change’s total, and the Costs tab (`/hub/costs`) shows the run-rate, the month so far, the month-end forecast against each app’s budget, and what the providers billed.'
    },
    { type: 'h2', id: 'hub-costs-live-figure', text: 'Reading a figure' },
    {
      type: 'p',
      text: 'Every figure reads “About $48.20 a month”, with a chip that says how it was priced and an info button that lists what it is made of.'
    },
    {
      type: 'table',
      head: ['Chip', 'Meaning'],
      rows: [
        [
          'List price',
          'The provider’s published price list (AWS Price List, cached seven days; a bundled table with its date when the list cannot be read).'
        ],
        [
          'Plan price',
          'The plan the account is on. The provider bills the account, not the resource; the line shows what this resource adds.'
        ],
        [
          'Hub rates',
          'A Docker stack or shared deployment at the chargeback rates set under Costs → Chargeback, times the host region’s factor.'
        ],
        ['Plus usage', 'Priced by use; the figure is the base only.'],
        ['Free', 'The provider does not charge for it.']
      ]
    },
    {
      type: 'ul',
      items: [
        'Each line names its quantity, unit and unit price, and where the figure came from: price list, plan price, measured, assumed, from your bills, or a rate set by an administrator.',
        '**Data transfer** is its own line. On a create form, “Data out” is prefilled from what the Hub measured for the same app (another environment, or the one being changed) and says so: measured, you entered, or none assumed. Set your own figure with Set; Reset goes back to the measured one.',
        '**Tax** is its own line: the rate learned from the provider’s bills over the last three billed months, else the rate an administrator set on the connection (`tax_percent`, 0 = exempt). With neither, the figure says “Tax not included.”',
        '**Credits and discounts** show as a minus line only when they were learned from a bill; the Hub never assumes one.',
        '“No estimate” means the Hub has no price for it (an unknown region, a price list that could not be read). It is never shown as $0, and a change with an unknown part never approves itself.'
      ]
    },
    { type: 'h2', id: 'hub-costs-live-forms', text: 'Estimates while you create or change' },
    {
      type: 'ul',
      items: [
        'Provider resource forms (create and change): the estimate updates 400 ms after you stop typing and keeps the last figure while the next one loads. A change shows the difference from what it costs now. Secrets are never sent for an estimate.',
        'Stack settings: what the stack costs now and at the size picked.',
        'Create app: per environment its stack at the Hub’s rates and each provider part at list price, with the total and how many parts have no estimate.',
        'Scale and move plans: the cost before → after.',
        'Plans: each operation shows Cost now → after, and the change shows its total (a month, once, a year) with the time the prices were checked. The approval card a Hub administrator sees shows the same totals. Estimates are never part of what the plan hash binds; prices move.'
      ]
    },
    { type: 'h2', id: 'hub-costs-live-now', text: 'Costs → Now' },
    {
      type: 'p',
      text: 'Every 15 minutes the Hub samples the run-rate of every managed resource and every stack. Now shows the result and updates by itself (topic `hub:costs`).'
    },
    {
      type: 'ul',
      items: [
        '**Running now**: what everything costs a month at the current run-rate (an hourly figure under it).',
        '**Month to date**: the samples added up since the first of the month.',
        '**Forecast, month end**: month to date plus the current run-rate for the rest of the month.',
        '**Billed**: what the providers billed this month, through the last day they reported, and the gap against the estimate over the same days. It reads “No bill yet” until a provider cost feed is connected.',
        '**Per app**: running now, month to date and the forecast against the app’s budget. Open an app for its environments, then each provider, then each resource.',
        '**By provider**: running now and the month so far per provider.',
        'Managed resource rows, environment rows and app cards show the same run-rate as a `$x/mo` chip (hourly on hover).'
      ]
    },
    { type: 'h2', id: 'hub-costs-live-budgets', text: 'Budgets and approvals' },
    {
      type: 'ul',
      items: [
        'A Hub administrator sets a monthly budget per app (the pencil beside the forecast bar). When the forecast crosses 80 % and then 100 % of it, the app’s owners and the Hub’s notify routes are told once per threshold per month (`cost.over_budget`). App owners see their apps’ budgets, read only.',
        'An owner’s change that costs money waits for a Hub administrator. Under **Approving costed changes** an administrator may set an amount: an owner change that adds less than it a month, and costs less than it once and a year, starts without waiting. 0 (the default) = every costed change waits. An app’s budget can carry its own amount; blank = the Hub-wide one.'
      ]
    },
    { type: 'h2', id: 'hub-costs-live-api', text: 'API' },
    {
      type: 'table',
      head: ['Route', 'What it does'],
      rows: [
        [
          '`POST /api/hub/providers/estimate`',
          'One resource’s estimate: `{connection_id, type | resource_id, desired, app_id?, environment_id?, egress_gb_month?, delete?}` → the estimate plus `before`, `deltaMonthlyCents`, `traffic`. A read: works during maintenance, `hub:read`, MCP allowed.'
        ],
        [
          '`POST /api/hub/environments/:envId/stack/estimate`',
          '`{size?, replicas?}` → `{before, after, deltaMonthlyCents}` at the Hub’s rates.'
        ],
        [
          '`POST /api/hub/apps/create/estimate`',
          'The Create app body → per environment its stack and provider parts (administrators).'
        ],
        [
          '`GET /api/hub/costs/live?app_id=&environment_id=`',
          'Run-rate now, month to date, forecast, billed, gap, per app / provider / series. Owners see their own apps.'
        ],
        [
          '`GET|PUT /api/hub/apps/:id/cost-budget`',
          '`{monthly_cents, auto_approve_under_cents}` (PUT: administrators).'
        ],
        [
          '`GET|PUT /api/hub/costs/settings`',
          '`{cost_auto_approve_under_cents}` (PUT: administrators).'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Amounts in the API are cents. A month is 730 hours, as in the price lists.'
    }
  ]
}
