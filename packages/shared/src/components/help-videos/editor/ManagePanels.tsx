import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { TabsContent } from '../../ui/tabs'
import { helpVideoKeys } from '../api'
import { HelpVideoRecorder } from '../recorder/HelpVideoRecorder'
import type { HelpVideoDto } from '../types'
import { DetailsTab } from './DetailsTab'
import { StatsTab } from './StatsTab'
import { VersionsTab } from './VersionsTab'

/**
 * The editor's Details, Versions and Stats tabs, and the re-record recorder
 * the Versions tab opens (mounted only while it is open). Rendered inside the editor's Tabs.
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
  const [recording, setRecording] = useState(false)
  const scroll = 'mt-0 min-h-0 flex-1 overflow-y-auto'
  return (
    <>
      <TabsContent value='details' className={scroll}>
        <DetailsTab video={video} />
      </TabsContent>
      <TabsContent value='versions' className={scroll}>
        <VersionsTab
          video={video}
          onRerecord={() => setRecording(true)}
          onRestored={onReload}
          beforeChange={flush}
          conflict={conflict}
          onReload={onReload}
        />
      </TabsContent>
      <TabsContent value='stats' className={scroll}>
        <StatsTab video={video} />
      </TabsContent>
      {recording && (
        <HelpVideoRecorder
          open={recording}
          videoId={video.id}
          onClose={() => setRecording(false)}
          onDone={() => {
            setRecording(false)
            void qc.invalidateQueries({ queryKey: helpVideoKeys.one(video.id) })
            onReload()
          }}
        />
      )}
    </>
  )
}
