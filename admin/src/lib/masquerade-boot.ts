import { captureMasqueradeFromHash, installMasqueradeFetch } from './masquerade-core'

// A "View as" tab (#640) must read its token and wrap window.fetch BEFORE any module creates an
// SDK client — a client keeps the fetch it was created with, and App / @nivaro/shared create
// theirs at import time. main.tsx imports this file first; installed in main.tsx's body, the
// patch came too late and those clients' calls (users/me, chat rooms, presence…) went out on
// the admin's cookie instead of the viewed person (2026-10-26).
captureMasqueradeFromHash()
installMasqueradeFetch()
