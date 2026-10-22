import { installClientChaosFetch } from '@nivaro/shared'

// Browser chaos mode (#2840) wraps window.fetch BEFORE any module creates an SDK client — a
// client keeps the fetch it was created with, and pages create theirs at import time. main.tsx
// imports this file first for that reason; it does nothing until chaos is switched on.
installClientChaosFetch()
