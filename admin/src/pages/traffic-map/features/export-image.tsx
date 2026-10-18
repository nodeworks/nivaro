import { ImageDown } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { useSettings } from '@/lib/useSettings'
import { useTrafficMap } from '../context'
import { callerLabel } from '../EventTicker'
import {
  buildMapSvg,
  downloadBlob,
  exportFileName,
  getMapExportSource,
  svgToPng
} from '../mapExport'
import { register } from '../registry/registry'
import { toolbarItems } from '../registry/toolbarItems'
import { BTN, errorOf } from './shared'

/**
 * #2142 — export the flow map as a PNG or SVG with the time window, filters, environment and a
 * legend printed on it (mapExport.ts builds the image from what the canvas draws). Everything
 * happens in the browser; nothing is uploaded.
 */
let envCache: string | null = null
async function serverEnvironment(): Promise<string | null> {
  if (envCache !== null) return envCache || null
  try {
    const r = await api.get<{ environment?: string }>('/version', { timeout: 3000 })
    envCache = typeof r.data?.environment === 'string' ? r.data.environment.slice(0, 40) : ''
  } catch {
    envCache = ''
  }
  return envCache || null
}

function ExportImage() {
  const { catalog } = useTrafficMap()
  const settings = useSettings()
  const [busy, setBusy] = useState<'png' | 'svg' | null>(null)
  const [open, setOpen] = useState(false)

  const run = async (kind: 'png' | 'svg') => {
    const src = getMapExportSource()
    if (!src?.data.loaded) {
      toast.error('The map has not loaded yet')
      return
    }
    setBusy(kind)
    try {
      const env = await serverEnvironment()
      const environment = [
        settings.data?.project_name || 'Nivaro',
        typeof window !== 'undefined' ? window.location.host : '',
        src.model.instance ? `api ${src.model.instance}` : '',
        env ?? ''
      ]
        .filter(Boolean)
        .join(' · ')
      const at = new Date()
      const { svg, width, height } = buildMapSvg(src, {
        environment,
        callerLabel: (k) => callerLabel(catalog, k),
        takenAt: at
      })
      if (kind === 'svg')
        downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), exportFileName('svg', at))
      else downloadBlob(await svgToPng(svg, width, height), exportFileName('png', at))
      setOpen(false)
    } catch (e) {
      toast.error(`Could not export the map: ${errorOf(e)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          id='tm-export-image'
          className={BTN}
          data-tip='Save the map as an image, with the window, filters and legend on it'
        >
          <ImageDown className='h-3.5 w-3.5' aria-hidden='true' />
          Image
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[280px] p-3'>
        <div className='traffic-map grid gap-2 text-[12px] text-[var(--tm-fg)]'>
          <p className='text-[var(--tm-fg-2)]'>
            The whole map as it is drawn now, with the time window, filters, environment and a
            legend on it. Made in your browser; nothing is uploaded.
          </p>
          <div className='flex flex-wrap gap-1.5'>
            <button
              type='button'
              id='tm-export-png'
              className={BTN}
              disabled={busy !== null}
              onClick={() => void run('png')}
            >
              {busy === 'png' ? 'Saving…' : 'Download PNG'}
            </button>
            <button
              type='button'
              id='tm-export-svg'
              className={BTN}
              disabled={busy !== null}
              onClick={() => void run('svg')}
            >
              {busy === 'svg' ? 'Saving…' : 'Download SVG'}
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

register(toolbarItems, { id: 'export-image', order: 72, slot: 'actions', Component: ExportImage })
