import type { DocSection } from '../types.js'

export const infrastructureInventory: DocSection = {
  id: 'infrastructure-inventory',
  label: 'Containers, volumes and images',
  content: [
    { type: 'h1', id: 'infrastructure-inventory', text: 'Containers, volumes and images' },
    {
      type: 'p',
      text: 'Four tabs on the Infrastructure page list what runs on each Docker host: Containers, Volumes, Images and Provenance. They read through the same read-only Docker proxy as the rest of the page, set up as described in the Infrastructure overview, and nothing on them changes a host.'
    },
    { type: 'h2', id: 'infrastructure-containers', text: 'Containers' },
    {
      type: 'p',
      text: 'Every container on the host with its owner (swarm stack, compose project and service, or none), state, restart policy, age and image. Three things are flagged and sorted to the top. A container with no owner was started by hand with docker run and nothing redeploys it. A container stopped for more than 7 days still holds its volumes. A container in a compose project but started from a different working directory than the rest of that project is the dangerous case: running docker compose up --remove-orphans from the project directory would remove it.'
    },
    { type: 'h2', id: 'infrastructure-volumes', text: 'Volumes' },
    {
      type: 'p',
      text: 'Named volumes and bind mounts with size, owning stack or project, the containers using each, and last write time when the host facts collector reports it. Orphaned volumes (used by no container) are listed first, largest first, with the total space they would free. A volume counts as backed up when its name or path matches INFRA_BACKED_UP_VOLUMES (a comma list of names or globs) or it carries the label nivaro.backup=true. A volume in use that is not covered is flagged.'
    },
    { type: 'h2', id: 'infrastructure-images', text: 'Images' },
    {
      type: 'p',
      text: 'Images split into in use, unused and dangling, with size, shared size, how many containers use each, and the build cache total and reclaimable part. A preview lists what docker system prune would remove: the stopped containers by name (a prune during a deploy deletes stopped containers mid-task), dangling images, unused networks and unused build cache, and with -a the images no container uses. The preview only reads.'
    },
    { type: 'h2', id: 'infrastructure-provenance', text: 'Provenance' },
    {
      type: 'p',
      text: 'For each running container whose image carries OCI labels, or whose repository starts with an entry in INFRA_OWN_IMAGES, the tag, digest, git revision (linked when the image source label is a web URL), build date and age. For the Nivaro image the version label is compared with this API and shown as how many releases behind. Your own images running :latest, running untagged, or with no revision label are flagged as not from the release pipeline.'
    },
    {
      type: 'table',
      head: ['Setting', 'Meaning'],
      rows: [
        ['INFRA_BACKED_UP_VOLUMES', 'Comma list of volume names or globs that have a backup.'],
        ['INFRA_OWN_IMAGES', 'Comma list of repository prefixes that are your own images.']
      ]
    }
  ]
}
