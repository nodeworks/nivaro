import { ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { useApiFetchConfig } from '../../../context'
import { PickList, quietText, Segmented, Setting, smallBtn, Toggle } from './controls'
import { changeLabel, flag, type SectionProps, toggleLabel } from './section-props'
import { fieldLabel, isStoredField, usePdfTemplates, useSettingsFields } from './settings-api'
import { TextSetting } from './TextSetting'
import { ToggleSetting } from './ToggleSetting'

type Theme = 'classic' | 'minimal' | 'executive' | 'custom'

const THEMES: Array<{ value: Theme; label: string }> = [
  { value: 'classic', label: 'Classic' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'executive', label: 'Executive' },
  { value: 'custom', label: 'Custom' }
]

export function PdfSection(props: SectionProps) {
  const { layout, collection } = props
  const fields = useSettingsFields(collection)
  const templates = usePdfTemplates(collection, true)
  const theme = (
    THEMES.some((t) => t.value === layout.pdf_theme) ? layout.pdf_theme : 'classic'
  ) as Theme
  const templateId = layout.pdf_template_id == null ? null : String(layout.pdf_template_id)
  const coverOn = layout.pdf_cover_enabled == null ? true : flag(layout.pdf_cover_enabled)
  const titleOptions = fields
    .filter(isStoredField)
    .map((f) => ({ value: f.field, label: fieldLabel(fields, f.field), hint: f.field }))
    .sort((a, b) => a.label.localeCompare(b.label))
  const exportOn = flag(layout.is_active)

  return (
    <>
      <Setting
        k='layout.pdf_export_active'
        control={
          <Toggle
            label='PDF button on records'
            checked={exportOn}
            onChange={(on) =>
              props.set({ is_active: on }, toggleLabel('layout.pdf_export_active', on))
            }
          />
        }
      />
      <Setting
        k='layout.pdf_theme'
        control={
          <Segmented<Theme>
            ariaLabel='PDF theme'
            value={theme}
            options={THEMES}
            onChange={(v) => props.set({ pdf_theme: v }, changeLabel('layout.pdf_theme'))}
          />
        }
      />
      <Setting
        k='layout.pdf_template_id'
        control={
          <PickList
            ariaLabel='Custom template'
            value={templateId}
            options={templates.map((t) => ({ value: String(t.id), label: t.name }))}
            clearLabel='None'
            emptyText='No PDF templates for this collection'
            onChange={(v) =>
              props.set(
                v
                  ? { pdf_theme: 'custom', pdf_template_id: Number(v) }
                  : {
                      pdf_template_id: null,
                      ...(theme === 'custom' ? { pdf_theme: 'classic' } : {})
                    },
                v ? 'Use a custom PDF template' : 'Stop using a custom PDF template'
              )
            }
          />
        }
        note={
          theme === 'custom' && !templateId
            ? 'Pick a template: the Custom theme needs one, otherwise the PDF uses Classic.'
            : null
        }
      />
      <ToggleSetting k='layout.pdf_cover_enabled' props={props} defaultOn />
      <Setting
        k='layout.pdf_cover_title_field'
        note={coverOn ? null : 'Turn on the cover page first.'}
        control={
          <PickList
            ariaLabel='Cover title field'
            value={layout.pdf_cover_title_field ? String(layout.pdf_cover_title_field) : null}
            options={titleOptions}
            clearLabel="The record's name"
            disabled={!coverOn}
            onChange={(v) =>
              props.set({ pdf_cover_title_field: v }, changeLabel('layout.pdf_cover_title_field'))
            }
          />
        }
      />
      <TextSetting
        k='layout.pdf_cover_subtitle'
        props={props}
        placeholder='e.g. Procurement summary'
        disabled={!coverOn}
      />
      <TextSetting k='layout.pdf_button_label' props={props} placeholder='Download PDF' />
      <ToggleSetting k='layout.pdf_show_logo' props={props} defaultOn />
      <Setting
        k='layout.pdf_page_size'
        control={
          <Segmented<'A4' | 'Letter'>
            ariaLabel='Page size'
            value={layout.pdf_page_size === 'Letter' ? 'Letter' : 'A4'}
            options={[
              { value: 'A4', label: 'A4' },
              { value: 'Letter', label: 'Letter' }
            ]}
            onChange={(v) => props.set({ pdf_page_size: v }, changeLabel('layout.pdf_page_size'))}
          />
        }
      />
      <Setting
        k='layout.pdf_orientation'
        control={
          <Segmented<'portrait' | 'landscape'>
            ariaLabel='Orientation'
            value={layout.pdf_orientation === 'landscape' ? 'landscape' : 'portrait'}
            options={[
              { value: 'portrait', label: 'Portrait' },
              { value: 'landscape', label: 'Landscape' }
            ]}
            onChange={(v) =>
              props.set({ pdf_orientation: v }, changeLabel('layout.pdf_orientation'))
            }
          />
        }
      />
      <PdfPreviewSetting layoutId={Number(props.bundle.layout.id)} />
    </>
  )
}

/**
 * The route is admin-only and the host may authenticate with a bearer token, so a
 * plain link cannot carry it: fetch with the host's config and open the result.
 * The tab opens first so the click's popup allowance survives the await.
 */
function PdfPreviewSetting({ layoutId }: { layoutId: number }) {
  const fetchCfg = useApiFetchConfig()
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const open = async () => {
    setLoading(true)
    setFailed(false)
    const tab = window.open('', '_blank')
    try {
      const resp = await fetch(`${fetchCfg.apiBase}/collection-layouts/${layoutId}/preview-html`, {
        headers: fetchCfg.authHeaders,
        credentials: fetchCfg.credentials
      })
      if (!resp.ok) throw new Error(String(resp.status))
      const url = URL.createObjectURL(new Blob([await resp.text()], { type: 'text/html' }))
      if (tab) tab.location.href = url
      else window.open(url, '_blank')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch {
      tab?.close()
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }
  return (
    <Setting
      k='layout.pdf_preview'
      control={
        <button type='button' className={smallBtn} disabled={loading} onClick={open}>
          <ExternalLink className='h-3.5 w-3.5' />
          {loading ? 'Opening…' : 'Preview PDF'}
        </button>
      }
      note={
        failed ? (
          <span className='text-[#9c2f47] dark:text-[#f08aa1]'>
            The preview could not be made. Saved changes are still saved.
          </span>
        ) : (
          <span className={quietText}>Shows the last saved settings.</span>
        )
      }
    />
  )
}
