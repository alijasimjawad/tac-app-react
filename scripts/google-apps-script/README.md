# TAC Auto Backup (Google Apps Script)

Hourly backup of the whole Supabase database to Google Drive.

- **Hourly:** last 48 backups in `TAC_Backups/` (`tac_backup_<UTC time>.json`)
- **Daily:** one gzip copy per day, taken during 23:00–23:59 Baghdad time, kept
  for 365 days in `TAC_Backups/Daily/` (`tac_daily_YYYY-MM-DD.json.gz`)
- Every table is discovered automatically, all rows are fetched (1000 per page)
- A table that fails → file is saved as `..._PARTIAL.json`, you get an email,
  and the Backup & Restore page turns red
- Each run is logged to the `backup_runs` table (shown in the app)

## Install / update

1. **Supabase:** run `migrations/014_backup_runs.sql` in the SQL Editor.
2. Open the *TAC Auto Backup* project at script.google.com.
3. Replace the contents of the code file with `tac-auto-backup.gs` from this folder.
4. Project Settings (gear icon) → **Script Properties** → add:
   - `SUPABASE_URL` = `https://gauejhgitzcqjvzalshf.supabase.co`
   - `SUPABASE_SERVICE_KEY` = the **secret** key from Supabase → Project Settings → API Keys
     (the `sb_secret_…` / service_role key — **not** the publishable key).
     Never paste this key into chat, code or git.
5. Select `testBackupSetup` → **Run** (approve the permission prompts). The
   execution log should list every table with its row count.
6. Select `tacAutoBackup` → **Run** once. Check Drive and the app's Backup page.
7. Triggers (clock icon): the existing hourly trigger on `tacAutoBackup` keeps
   working — nothing to change.

The old script used the public key in the code. Once the new one works, rotate
that publishable key if you want it fully retired.

## Restoring

Backup & Restore page → *Choose Backup File…* accepts both `.json` and
`.json.gz` files.
