import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { TabsContent } from '../../ui/tabs'
import { helpVideoKeys } from '../api'
import { RECORDING_BUSY, useHelpVideoRecording } from '../recorder/HelpVideoRecordingProvider'
import type { HelpVideoDto } from '../types'
import { DetailsTab } from './DetailsTab'
import { StatsTab } from './StatsTab'
import { VersionsTab } from './VersionsTab'

/**
 * The editor's Details, Versions and Stats tabs. The Versions tab's Re-record
 * starts the app's one recorder (useHelpVideoRecording); the editor reloads its
 * draft when that recording is saved. Rendered inside the editor's Tabs.
 */
export function ManagePanels({
  video,
  flush,
  conflict,
  onReload
}: {
  video: HelpVideoDto
  /** Lands the editor's pending save; false when it failed. */
  flush: () => Promise<boolean>
  /** The editor's draft changed elsewhere. */
  conflict: boolean
  /** Loads the draft afresh (after a restore or a re-record). */
  onReload: () => void
}) {
  const qc = useQueryClient()
  const recorder = useHelpVideoRecording()
  const [busy, setBusy] = useState(false)
  const scroll = 'mt-0 min-h-0 flex-1 overflow-y-auto'
  return (
    <>
      <TabsContent value='details' className={scroll}>
        <DetailsTab video={video} />
      </TabsContent>
      <TabsContent value='versions' className={scroll}>
        <VersionsTab
          video={video}
          onRerecord={() => {
            const started = recorder.start({
              videoId: video.id,
              onDone: () => {
                void qc.invalidateQueries({ queryKey: helpVideoKeys.one(video.id) })
                onReload()
              }
            })
            setBusy(!started)
          }}
          onRestored={onReload}
          beforeChange={flush}
          conflict={conflict}
          onReload={onReload}
        />
      </TabsContent>
      <TabsContent value='stats' className={scroll}>
        <StatsTab video={video} />
      </TabsContent>
      {busy && recorder.active && (
        <p role='status' className='px-4 py-2 text-[12px] text-rose-700 dark:text-rose-300'>
          {RECORDING_BUSY}
        </p>
      )}
      {recorder.fallback}
    </>
  )
}
