import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Combobox } from './controls'
import { useEditorApi } from './editor-api'

export function useReportPickers(reportId: string) {
  const api = useEditorApi()
  const { data: reports = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['report-studio-list'],
    queryFn: () => api.get('/report-studio').then((r) => r.data.data ?? []),
    staleTime: 60_000
  })
  const { data: reportDetail } = useQuery<{
    widgets?: Array<{ id: string; type: string; title: string }>
  }>({
    queryKey: ['report-studio-detail', reportId],
    queryFn: () => api.get(`/report-studio/${reportId}`).then((r) => r.data.data),
    enabled: !!reportId,
    staleTime: 60_000
  })
  const widgets = (reportDetail?.widgets ?? []).filter((w) => w.type !== 'divider')
  return { reports, widgets }
}

// Config editor for widget_type 'report_widget' rows, shown inside the
// widget-slot settings popover. The config lives on the nivaro_widgets row
// itself (global to the widget, not per-layout), so this PATCHes
// /widgets-internal/:id — and only once BOTH ids are chosen, since the
// server validator requires the pair. With `onSave` it hands the next config
// over instead (the layout editor confirms first) and saves nothing itself.
export function ReportWidgetConfigSection({
  widgetId,
  config,
  onSave
}: {
  widgetId: number
  config: Record<string, unknown> | null
  onSave?: (next: Record<string, unknown>) => void
}) {
  const api = useEditorApi()
  const qc = useQueryClient()
  const [reportId, setReportId] = useState(
    typeof config?.report_id === 'string' ? config.report_id : ''
  )
  const [innerId, setInnerId] = useState(
    typeof config?.widget_id === 'string' ? config.widget_id : ''
  )
  const [filterField, setFilterField] = useState(
    typeof config?.entity_filter_field === 'string' ? config.entity_filter_field : ''
  )
  const { reports, widgets } = useReportPickers(reportId)

  const nextConfig = (r: string, w: string, f: string) => ({
    ...(config ?? {}),
    report_id: r,
    widget_id: w,
    entity_filter_field: f.trim() || null
  })
  const save = useMutation({
    mutationFn: (next: Record<string, unknown>) =>
      api.patch(`/widgets-internal/${widgetId}`, { config: next }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['widgets-internal'] })
  })
  const commit = (r: string, w: string, f: string) => {
    if (!r || !w) return
    if (onSave) onSave(nextConfig(r, w, f))
    else save.mutate(nextConfig(r, w, f))
  }

  return (
    <div className='space-y-1.5 border-t border-slate-100 pt-1.5 dark:border-border'>
      <p className='text-[11px] font-medium text-slate-400'>Report widget</p>
      <Combobox
        value={reportId}
        onChange={(v) => {
          setReportId(v)
          setInnerId('')
        }}
        options={reports.map((r) => ({ value: r.id, label: r.name }))}
        placeholder='Report…'
      />
      <Combobox
        value={innerId}
        onChange={(v) => {
          setInnerId(v)
          commit(reportId, v, filterField)
        }}
        options={widgets.map((w) => ({ value: w.id, label: w.title || w.type }))}
        placeholder='Widget…'
        disabled={!reportId}
      />
      <div className='flex items-center gap-1'>
        <input
          type='text'
          placeholder='Entity filter field'
          value={filterField}
          onChange={(e) => setFilterField(e.target.value)}
          className='min-w-0 flex-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-nvr-cyan placeholder:text-slate-300 dark:bg-muted dark:border-border'
        />
        <button
          type='button'
          disabled={!reportId || !innerId || save.isPending}
          onClick={() => commit(reportId, innerId, filterField)}
          className='shrink-0 rounded border border-slate-200 px-1.5 py-1 text-[11px] text-slate-500 hover:bg-muted disabled:opacity-40 dark:border-border'
        >
          {save.isPending ? '…' : 'Apply'}
        </button>
      </div>
      <p className='text-[11px] leading-snug text-slate-400'>
        Filter field scopes the report data by a record value (bind “Filter value” below, or name a
        field the record already carries).
      </p>
    </div>
  )
}
