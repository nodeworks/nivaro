import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useNivaroClient } from '../context'
import { get } from '../lib/commands'
import { BaseMap, type BaseMapPin } from './BaseMap'

/**
 * Map display mode (#19) for collections with lat/long columns: fetches the
 * browser's filtered rows and renders them through BaseMap (the shared slippy
 * core the Command Center's live map also uses). Filter-aware — the same
 * conditions param the table sends applies here, so filters narrow the pins.
 * Row cap 1,000 (status line says when truncated).
 */
export function MapView({
  collection,
  latField,
  lngField,
  labelField,
  conditions,
  search,
  onOpen
}: {
  collection: string
  latField: string
  lngField: string
  /** Best available name-ish column for the pin tooltip. */
  labelField: string | null
  /** The browser's compiled conditions param — the map is filter-aware. */
  conditions: string | null
  search: string
  onOpen: (id: string) => void
}) {
  const client = useNivaroClient()
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['map-view', collection, latField, lngField, conditions, search],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${collection}`, {
            limit: 1000,
            fields: ['id', latField, lngField, ...(labelField ? [labelField] : [])].join(','),
            ...(conditions ? { conditions } : {}),
            ...(search ? { search } : {})
          })
        )
        .then((r) => r.data ?? []),
    staleTime: 30_000
  })

  const pins: BaseMapPin[] = useMemo(
    () =>
      rows
        .map((r) => ({
          id: String(r.id),
          lat: Number(r[latField]),
          lng: Number(r[lngField]),
          label: labelField && r[labelField] != null ? String(r[labelField]) : `#${r.id}`
        }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && (p.lat !== 0 || p.lng !== 0)),
    [rows, latField, lngField, labelField]
  )

  return (
    <BaseMap
      pins={pins}
      onPinClick={onOpen}
      statusLine={`${isLoading ? 'Loading records…' : `${pins.length} pinned${rows.length >= 1000 ? ' (first 1,000)' : ''}`} · © OpenStreetMap`}
    />
  )
}
