import { memo } from 'react'
import { Button } from '../../ui/button'
import { applyHouseStyle, type HouseStyle, houseStyleChanges } from '../houseStyle'
import { useHouseStyle } from '../settings/useHouseStyle'
import type { VideoEdits } from '../types'
import { SideSection } from './layout'

/** The side section around the panel. It reads the house style itself, so
 *  the house style arriving redraws only this section, never the column. */
export const HouseStyleSection = memo(function HouseStyleSection({
  edits,
  open,
  onToggle,
  onChange
}: {
  edits: VideoEdits
  open: boolean
  onToggle: (id: string) => void
  onChange: (e: VideoEdits, key?: string) => void
}) {
  const house = useHouseStyle()
  const diff = house.query.isPending ? null : houseStyleChanges(edits, house.style).length
  return (
    <SideSection
      id='house'
      title='House style'
      summary={
        diff === null
          ? ''
          : diff === 0
            ? 'Followed'
            : `${diff} ${diff === 1 ? 'difference' : 'differences'}`
      }
      open={open}
      onToggle={onToggle}
    >
      <HouseStylePanel
        edits={edits}
        house={house.style}
        loading={house.query.isPending}
        failed={house.query.isError}
        isDefault={house.query.data?.is_default ?? true}
        onChange={onChange}
      />
    </SideSection>
  )
})

/**
 * "Apply house style" (#1551): rewrites this video's own look to the house
 * style as one change (one undo step). Says first, in plain words, exactly
 * what will change; a video that already follows it says so instead.
 */
export const HouseStylePanel = memo(function HouseStylePanel({
  edits,
  house,
  loading,
  failed,
  isDefault,
  onChange
}: {
  edits: VideoEdits
  house: HouseStyle
  loading: boolean
  /** The house style could not be read (the standard look is shown). */
  failed: boolean
  /** No house style is set: it is the standard look. */
  isDefault: boolean
  onChange: (e: VideoEdits, key?: string) => void
}) {
  if (loading) {
    return (
      <p className='text-[12px] text-muted-foreground' role='status'>
        Loading the house style…
      </p>
    )
  }
  const changes = houseStyleChanges(edits, house)
  return (
    <div className='space-y-2' data-hv-house-style>
      <p className='text-[12px] leading-snug text-muted-foreground'>
        {failed
          ? 'The house style could not be loaded, so this compares the video with the standard look.'
          : isDefault
            ? 'No house style is set, so the house style is the standard look.'
            : 'New videos start from the house style. This video keeps its own choices until you apply it.'}
      </p>
      {changes.length === 0 ? (
        <p className='text-[12.5px] text-foreground' data-hv-house-style-matches>
          This video already follows the house style.
        </p>
      ) : (
        <>
          <p className='text-[12.5px] font-medium text-foreground'>Applying it changes:</p>
          <ul
            className='list-disc space-y-0.5 pl-4 text-[12.5px] text-foreground'
            data-hv-house-style-changes
          >
            {changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <p className='text-[12px] leading-snug text-muted-foreground'>
            Card text stays as you wrote it, and a card the house style leaves off stays as it is.
            You can undo this.
          </p>
          <Button
            size='sm'
            variant='outline'
            className='h-8 text-[12.5px]'
            disabled={failed}
            onClick={() => onChange(applyHouseStyle(edits, house))}
            data-hv-house-style-apply
          >
            Apply house style
          </Button>
        </>
      )}
    </div>
  )
})
