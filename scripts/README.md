# Migration scripts

## migrate-users-to-auth.ts

One-off script that creates a Supabase Auth user for every row in the `users`
table and writes the resulting `auth.users.id` back into `users.auth_user_id`.

**Run this exactly once, locally, before using the new React app.**

### Prerequisites

1. Get the **service role key** from Supabase Dashboard → Settings → API →
   `service_role` secret. This key bypasses Row-Level Security and grants full
   database access — treat it like a root password.

2. Install `tsx` if you don't have it:  
   ```
   npm install -g tsx
   ```
   Or use `npx tsx` (no global install needed).

### How to run

```bash
SUPABASE_SERVICE_ROLE_KEY=eyJ... npx tsx scripts/migrate-users-to-auth.ts
```

The script is **idempotent** — rows that already have `auth_user_id` set are
skipped, so it's safe to re-run if something fails partway through.

### Security rules — do not break these

- **Never** commit the service role key to git.
- **Never** put it in `.env` (the frontend `.env` is bundled by Vite and
  ships to browsers; the service role key must never reach the browser).
- **Never** import or use this script from any code that gets deployed.
- After migration is complete and verified, you can delete the key from your
  terminal history (`history -d <line>` in bash or `fc -p` in zsh).
