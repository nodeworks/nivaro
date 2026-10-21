import { formatFileSize, formatRelative } from '@/lib/utils'
import { DataTable, Empty, InventoryTab, Pill, Stat, StatStrip, Td, Th } from './inventory-ui'

interface Item {
  name: string
  detail: string
  bytes: number | null
}
interface Inv {
  images: Array<{
    id: string
    tags: string[]
    size_bytes: number
    shared_bytes: number | null
    unique_bytes: number
    containers: number
    created: number | null
    status: 'in-use' | 'unused' | 'dangling'
  }>
  totals: Record<'in_use' | 'unused' | 'dangling', { count: number; bytes: number }>
  build_cache: { total_bytes: number; reclaimable_bytes: number; entries: number }
  prune: {
    stopped_containers: Item[]
    dangling_images: Item[]
    unused_networks: Item[]
    build_cache: { bytes: number; entries: number }
    unused_images: Item[]
    plain_bytes: number
    all_bytes: number
  }
}

const tone = { 'in-use': 'green', unused: 'amber', dangling: 'slate' } as const

function PruneList({ title, items, note }: { title: string; items: Item[]; note?: string }) {
  return (
    <div className='py-2'>
      <div className='text-[12px] font-medium'>
        {title} <span className='text-slate-500 dark:text-muted-foreground'>({items.length})</span>
      </div>
      {note && <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>{note}</p>}
      {items.length > 0 && (
        <ul className='mt-1 space-y-0.5 text-[12px]'>
          {items.slice(0, 25).map((i) => (
            <li key={`${i.name}:${i.detail}`} className='flex gap-2'>
              <span className='truncate font-medium'>{i.name}</span>
              <span className='truncate text-slate-500 dark:text-muted-foreground'>{i.detail}</span>
              {i.bytes != null && (
                <span className='ml-auto tabular-nums'>{formatFileSize(i.bytes)}</span>
              )}
            </li>
          ))}
          {items.length > 25 && (
            <li className='text-slate-500 dark:text-muted-foreground'>
              and {items.length - 25} more
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/** Images, build cache and a preview of what docker system prune would remove (#2833). */
export function ImagesTab() {
  return (
    <InventoryTab<Inv>
      area='images'
      intro='Images and build cache per host, and what docker system prune would remove. This page only reads; nothing here deletes.'
    >
      {(inv) => (
        <div className='space-y-3'>
          <StatStrip>
            <Stat
              label='In use'
              value={`${inv.totals.in_use.count} · ${formatFileSize(inv.totals.in_use.bytes)}`}
            />
            <Stat
              label='Unused'
              value={`${inv.totals.unused.count} · ${formatFileSize(inv.totals.unused.bytes)}`}
            />
            <Stat
              label='Dangling'
              value={`${inv.totals.dangling.count} · ${formatFileSize(inv.totals.dangling.bytes)}`}
            />
            <Stat
              label='Build cache (reclaimable)'
              value={`${formatFileSize(inv.build_cache.total_bytes)} (${formatFileSize(inv.build_cache.reclaimable_bytes)})`}
            />
          </StatStrip>
          <div className='rounded-lg border border-slate-200 bg-white px-4 py-2 dark:border-border dark:bg-card'>
            <p className='text-[13px] font-semibold'>
              What docker system prune would do: free {formatFileSize(inv.prune.plain_bytes)}
              <span className='font-normal text-slate-500 dark:text-muted-foreground'>
                {' '}
                (with -a: {formatFileSize(inv.prune.all_bytes)})
              </span>
            </p>
            <div className='divide-y divide-slate-100 dark:divide-border'>
              <PruneList
                title='Stopped containers it would delete'
                items={inv.prune.stopped_containers}
                note='A prune run during a deploy deletes stopped containers that are mid-task or about to be restarted.'
              />
              <PruneList title='Dangling images' items={inv.prune.dangling_images} />
              <PruneList title='Unused networks' items={inv.prune.unused_networks} />
              <div className='py-2 text-[12px]'>
                <span className='font-medium'>Build cache</span>: {inv.prune.build_cache.entries}{' '}
                entries, {formatFileSize(inv.prune.build_cache.bytes)}
              </div>
              <PruneList
                title='Also with -a: images no container uses'
                items={inv.prune.unused_images}
              />
            </div>
          </div>
          {inv.images.length === 0 ? (
            <Empty>No images on this host.</Empty>
          ) : (
            <DataTable
              head={
                <>
                  <Th>Image</Th>
                  <Th>Status</Th>
                  <Th>Size</Th>
                  <Th>Shared</Th>
                  <Th>Containers</Th>
                  <Th>Created</Th>
                </>
              }
            >
              {inv.images.map((i) => (
                <tr key={i.id}>
                  <Td className='max-w-[360px] truncate font-medium'>
                    <span title={i.id}>
                      {i.tags[0] ?? i.id.replace('sha256:', '').slice(0, 12)}
                    </span>
                    {i.tags.length > 1 && (
                      <span className='ml-1 text-slate-500 dark:text-muted-foreground'>
                        +{i.tags.length - 1}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Pill tone={tone[i.status]}>{i.status === 'in-use' ? 'In use' : i.status}</Pill>
                  </Td>
                  <Td className='tabular-nums'>{formatFileSize(i.unique_bytes)}</Td>
                  <Td className='tabular-nums'>
                    {i.shared_bytes != null ? formatFileSize(i.shared_bytes) : '—'}
                  </Td>
                  <Td className='tabular-nums'>{i.containers}</Td>
                  <Td>{i.created ? formatRelative(new Date(i.created * 1000)) : '—'}</Td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>
      )}
    </InventoryTab>
  )
}
