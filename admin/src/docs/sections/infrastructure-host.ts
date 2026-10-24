import type { DocSection } from '../types.js'

export const infrastructureHostGuide: DocSection = {
  id: 'infrastructure-host',
  label: 'Host health, reboot and logs',
  content: [
    { type: 'h1', id: 'infrastructure-host', text: 'Host health, reboot and logs' },
    {
      type: 'p',
      text: 'Three tabs on the Infrastructure page look at the Docker hosts themselves: Hosts (patches, reboot and IO health), Reboot (which containers come back after a reboot) and Logs (container log size and rotation). They are read-only and for administrators.'
    },
    { type: 'h2', id: 'infrastructure-host-facts', text: 'Host facts collector' },
    {
      type: 'p',
      text: 'Some facts can only be read on the host: the kernel, pending updates, processes stuck on IO, NFS messages, remote mounts in /etc/fstab and container log sizes. deploy/host-facts/nivaro-host-facts.sh collects them every minute (the slow parts every 30 minutes) and writes them as node_exporter textfile metrics named nivaro_host_*. The telemetry store collects them and the Infrastructure page reads them from there. Nivaro never runs anything on a host.'
    },
    {
      type: 'ul',
      items: [
        'Install the script and its systemd timer as the README beside it describes, or, without sudo on the host, run it as a container (Dockerfile and compose.example.yml in the same folder) with no extra capability and only the host paths it reads mounted read-only.',
        'Set NIVARO_HOST_NAME to the name the host has in DOCKER_HOSTS, so its facts line up with its containers.',
        'Point node_exporter (or Alloy) at the textfile folder. Until the first figures arrive the tabs say "Host facts are not collected".'
      ]
    },
    { type: 'h2', id: 'infrastructure-hosts-tab', text: 'Hosts tab' },
    {
      type: 'p',
      text: 'For each host: the running and newest installed kernel, whether a reboot is needed, days since the last boot, free space on /boot (under 100 MB is flagged, because the next kernel update may fail), pending security updates and how long ago the facts were collected.'
    },
    {
      type: 'p',
      text: 'It also tells you when a host is stuck waiting on IO: processes in D state, kernel hung-task messages, NFS servers that stopped answering, and a high load while the CPU is mostly idle — for example "Load 22 while the CPU is 90% idle — processes are waiting on IO, likely the mount /mnt/data". The readiness check host-hung-io warns when any host shows these signs.'
    },
    { type: 'h2', id: 'infrastructure-reboot-tab', text: 'Reboot tab' },
    {
      type: 'p',
      text: 'Every running container gets a verdict for what happens when its host reboots:'
    },
    {
      type: 'table',
      head: ['Verdict', 'When'],
      rows: [
        [
          'Comes back',
          'A swarm task (swarm reschedules it unless the service restart condition is none), or restart policy always / unless-stopped.'
        ],
        [
          'Stays down',
          'Restart policy no or on-failure outside swarm, or a swarm service with restart condition none.'
        ],
        [
          'May come back broken',
          'It uses a remote mount (NFS, CIFS…) that docker.service does not wait for at boot, so it can start against the empty mount point.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Each host also lists remote mounts without nofail in /etc/fstab: if their server is down while the host boots, the host can stop in emergency mode. The readiness check reboot-survivability warns when any container would stay down.'
    },
    {
      type: 'p',
      text: 'Temporary containers are not judged and are listed under the table instead: a container started with docker run --rm, and a GitLab CI job container (labels com.gitlab.gitlab-runner.*). Neither is meant to come back, and a CI build running on the host while a deploy gate looked used to turn the check to warn.'
    },
    { type: 'h2', id: 'infrastructure-logs-tab', text: 'Logs tab' },
    {
      type: 'p',
      text: 'For each container: its log driver, its rotation (max-size and max-file), the size of its log file and how much it grew in the last day. A json-file log without max-size is flagged, because it grows until the disk is full. Each host shows the total, the daily growth and, from the free space on the filesystem that holds the Docker root, about how many days until it fills.'
    }
  ]
}
