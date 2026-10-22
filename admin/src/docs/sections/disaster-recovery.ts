import type { DocSection } from '../types.js'

export const disasterRecoveryDocs: DocSection = {
  id: 'disaster-recovery',
  label: 'Disaster recovery',
  content: [
    { type: 'h1', id: 'disaster-recovery', text: 'Disaster recovery' },
    {
      type: 'p',
      text: 'Telemetry → Disaster recovery answers one question: if the database server died now, how much would be lost and how long would getting back take? It judges each source against two stated targets — the RPO (recovery point objective: the most data a disaster may lose) and the RTO (recovery time objective: how long getting back may take) — and colours each row green, amber or red with the reason in words. Administrators only.'
    },
    {
      type: 'table',
      head: ['Row', 'Read from', 'Judged'],
      rows: [
        [
          'Database backup',
          'msdb: newest full, differential and log backup of this database',
          'Age against the RPO: amber up to 1.5×, red beyond, red when no full backup exists'
        ],
        [
          'Uploads backup',
          'The monitoring store metric efp_backup_last_success_timestamp_seconds{part=~"uploads.*"}',
          'Age against the RPO; amber "Not reported" until the uploads backup pushes it'
        ],
        [
          'Restore drill',
          'The newest restore drill (below)',
          'Red when it failed or never ran, amber when it could not run or is over 2 days old, red over 8 days'
        ],
        [
          'Measured restore time',
          'The newest passed drill',
          'Against the RTO: green up to 75 %, amber up to 100 %, red beyond'
        ],
        [
          'Chaos drill recovery',
          'Chaos drills of the last 90 days (GET /api/chaos/trends → recovery)',
          'p90 time to recover against the RTO; grey when no drill measured one'
        ]
      ]
    },
    {
      type: 'pre',
      code: `GET   /api/telemetry/recovery            the panel: targets, backups, drill, chaos, judged rows (?fresh=1 re-reads msdb)
PATCH /api/telemetry/recovery/settings   {targets:{rpo_minutes,rto_minutes}, runbook_url, restore_drill:{…}}
POST  /api/telemetry/restore-drill/run   202 — the drill runs in the background (heavy-job slot)
POST  /api/telemetry/restore-drill/run?dry_run=1   reads msdb + RESTORE FILELISTONLY only, answers at once
GET   /api/telemetry/restore-drill/runs/:id        one drill's stored result`
    },
    { type: 'h2', id: 'restore-drill', text: 'Restore drill' },
    {
      type: 'p',
      text: 'A backup that has never been restored is not a backup. The restore-drill job (nightly 02:30, or Run restore drill) restores the newest full backup of this database — plus the differential taken on top of it — into a scratch database, checks the copy, records how long the restore took, and always drops the copy afterwards.'
    },
    {
      type: 'ul',
      items: [
        'Off by default. Turn it on per instance in the panel’s settings, or with RESTORE_DRILL=on (RESTORE_DRILL=off forces it off). Never on cloud instances. The scheduled run ticks only where scheduled jobs tick.',
        'The scratch database must start with nivaro_restore_drill_ (default nivaro_restore_drill_<database>, or RESTORE_DRILL_DB). It may never be this instance’s own database, master, msdb, model, tempdb or EFP / EFP_Development / EFP_Staging. Before any RESTORE the run records an ownership claim on its job row (no claim, no restore). A database already under that name is dropped only when the newest claim on it belongs to a run that never confirmed dropping it; anything else refuses the run. A copy the drill cannot mark or drop fails the drill.',
        'Backups must be disk files the SQL Server can open (local, mapped or UNC paths; striped sets included). Backups taken by a backup agent (virtual device — Cohesity, NetBackup, Veeam), tape or URL are reported as "not restorable by path". When the newest full went to an agent but a full backup on disk exists, the drill restores the disk one and says so.',
        'Log backups are not applied: the copy is the full (+ differential) point, and the result says how many log backups came after it.',
        'Smoke check: the nivaro_ key tables (plus any business tables listed in the settings) must exist in the copy and hold rows wherever they hold rows live. Row counts and CHECKSUM_AGG over small configuration tables are recorded beside the live ones; differences are expected (the copy is older) and never fail the drill. DBCC CHECKDB (physical only) is optional.',
        'The login needs CREATE ANY DATABASE (dbcreator) and SELECT on msdb, and the SQL Server needs disk for a full copy (checked against the target volume before restoring). Each missing piece is recorded as the reason the drill could not run.',
        'Each run’s result lives on its nivaro_job_runs row (job restore-drill, progress column) — no table of its own. Background Jobs shows the runs; a failed drill reads failed there.'
      ]
    },
    {
      type: 'warn',
      text: 'A drill restores a full-size copy of the database on the same SQL Server: it costs disk and IO for the length of the restore. Point the data and log folders at a volume with room, and keep it off on servers that share disk with something that cannot spare it.'
    },
    { type: 'h2', id: 'recovery-settings', text: 'Targets, runbook and settings' },
    {
      type: 'p',
      text: 'Targets default to RPO 24 h and RTO 4 h. Settings live under the recovery key of this instance’s settings overrides (each environment keeps its own); env variables win and survive a database rebuilt from another one.'
    },
    {
      type: 'table',
      head: ['Env variable', 'Effect'],
      rows: [
        ['RESTORE_DRILL=on|off', 'Forces the drill on or off over the setting'],
        ['RESTORE_DRILL_DB', 'Scratch database name (must start with nivaro_restore_drill_)'],
        ['RECOVERY_RPO_MINUTES / RECOVERY_RTO_MINUTES', 'The stated targets'],
        ['DR_RUNBOOK_URL', 'The disaster-recovery runbook link on the panel (hidden when unset)']
      ]
    },
    {
      type: 'note',
      text: 'Ask AI on the Telemetry page (and the ops assistant) has a recovery_status tool with the same judged rows, so "could we recover right now?" and "did last night’s restore drill pass?" answer from the same facts. DB Health shows a red strip while any recovery row is red.'
    }
  ]
}
