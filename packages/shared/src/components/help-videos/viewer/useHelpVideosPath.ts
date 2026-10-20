import { useNavigation } from '../../../context'

// Its own module: the recording provider every host mounts at the root needs
// only this path, not the player sheet it used to live beside.
export function useHelpVideosPath(): (query?: string) => string {
  const nav = useNavigation()
  return (query = '') => `${nav.helpVideosPath ?? '/help-videos'}${query}`
}
