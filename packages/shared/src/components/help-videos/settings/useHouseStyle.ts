import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../../context'
import { HOUSE_STYLE_DEFAULTS } from '../houseStyle'
import { helpVideoSettingsApi, helpVideoSettingsKeys } from './api'

/** The house style (#1551) as the editor uses it. Authors only (the server
 *  refuses everyone else); while loading or on any failure: the defaults,
 *  which is exactly how videos looked before there was a house style. */
export function useHouseStyle(enabled = true) {
  const client = useNivaroClient()
  const q = useQuery({
    queryKey: helpVideoSettingsKeys.houseStyle,
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => helpVideoSettingsApi(client).houseStyle()
  })
  return { style: q.data?.house_style ?? HOUSE_STYLE_DEFAULTS, query: q }
}
