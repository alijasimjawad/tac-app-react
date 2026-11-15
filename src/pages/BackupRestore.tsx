import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import css from './BackupRestore.module.css';

// Every table in the app, in dependency order (parents before children) so the
// same list drives both Export and Restore. The automatic Google Drive backup
// discovers tables on its own; this list covers what the manual buttons use.
const BACKUP_TABLES = [
  // core / people
  'users', 'projects', 'capex_projects', 'team_members', 'clients',
  // sites & sections
  'sections', 'rows', 'sites',
  // daily work & HR
  'daily_activities', 'activity_log', 'attendance', 'employee_documents',
  'salary_adjustments', 'push_subscriptions', 'app_settings',
  // cars & trips
  'cars', 'saved_points', 'field_trips', 'trip_participants',
  // finance
  'general_expenses', 'project_expenses', 'revenue', 'expense_claims',
  'invoices', 'invoice_items', 'invoice_payments',
  'advances', 'advance_distributions',
  // warehouse
  'warehouses', 'inventory_items', 'item_code_mappings',
  'goods_receipts', 'goods_receipt_items',
  'receiving_scan_sessions', 'receiving_scan_log',
  'goods_issues', 'goods_issue_items',
  'inventory_assets', 'goods_issue_assets',
  'stock_balances', 'stock_movements',
  'smr_documents', 'smr_lines', 'smr_line_scans',
] as const;

// Tables whose primary key is not `id`.
const KEY_COLUMN: Record<string, string> = { app_settings: 'key' };
const keyOf = (table: string) => KEY_COLUMN[table] ?? 'id';

// activity_log is deliberately excluded from restore — restoring history isn't
// the same as restoring live data.
const RESTORE_SKIP = new Set(['activity_log']);

const PAGE = 1000;

const GDRIVE_URL = 'https://drive.google.com/drive/folders/1Iboi8xSHJkF4KcPVptkcIj2AznMO-CRJ?usp=share_link';

interface BackupRun {
  run_at: string;
  ok: boolean;
  partial: boolean;
  file_name: string | null;
  file_size: number | null;
  table_count: number | null;
  total_records: number | null;
  daily_file: string | null;
  hourly_kept: number | null;
  daily_kept: number | null;
  errors: string[] | null;
  warnings: string[] | null;
}

type BannerState = 'loading' | 'ok' | 'warn' | 'err' | 'unknown';

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h} h ${mins % 60} min ago`;
  return `${Math.floor(h / 24)} days ago`;
}

function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
      <polyline points="15 3 21 3 21 9"/>
      <line x1="10" y1="14" x2="21" y2="3"/>
    </svg>
  );
}

/** Reads every row of a table, 1000 at a time (Supabase caps a single request at 1000). */
async function fetchAllRows(table: string): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table).select('*').order(keyOf(table), { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data || [];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

export default function BackupRestore() {
  const { currentUser } = useAuth();

  const [exportStatus, setExportStatus] = useState('');
  const [exportOk,     setExportOk]     = useState<boolean | null>(null);
  const [exportBusy,   setExportBusy]   = useState(false);

  const [restoreStatus, setRestoreStatus] = useState('');
  const [restoreOk,     setRestoreOk]     = useState<boolean | null>(null);
  const [restoreBusy,   setRestoreBusy]   = useState(false);

  const [toast,    setToast]    = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRef    = useRef<HTMLInputElement>(null);

  // Real status of the automatic Google Drive backup (from backup_runs)
  const [runs, setRuns]           = useState<BackupRun[] | null>(null);
  const [runsLoaded, setRunsLoaded] = useState(false);

  useEffect(() => {
    if (!currentUser || currentUser.role !== 'admin') return;
    supabase.from('backup_runs').select('*').order('run_at', { ascending: false }).limit(30)
      .then(({ data, error }) => {
        setRuns(error ? null : (data as BackupRun[]));
        setRunsLoaded(true);
      });
  }, [currentUser]);

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  if (!currentUser || currentUser.role !== 'admin') {
    return <div className={css.page}><p className={css.denied}>Admin access only.</p></div>;
  }

  // ── Banner state ─────────────────────────────────────────────────────────────
  const latest   = runs && runs.length ? runs[0] : null;
  const lastGood = runs ? runs.find(r => r.ok) ?? null : null;
  const goodAgeMin = lastGood ? (Date.now() - new Date(lastGood.run_at).getTime()) / 60000 : Infinity;

  let banner: BannerState = 'loading';
  if (runsLoaded) {
    if (!runs || !latest)  banner = 'unknown';
    else if (!latest.ok)   banner = 'err';
    else if (goodAgeMin > 180) banner = 'err';
    else if (goodAgeMin > 90 || (latest.warnings?.length ?? 0) > 0) banner = 'warn';
    else banner = 'ok';
  }

  async function exportBackup() {
    setExportBusy(true);
    setExportOk(null);
    setExportStatus('Fetching data…');

    const backup: { exported_at: string; tables: Record<string, unknown[]> } = {
      exported_at: new Date().toISOString(),
      tables: {},
    };
    let total = 0;
    const failed: string[] = [];

    for (const table of BACKUP_TABLES) {
      setExportStatus(`Fetching ${table}…`);
      try {
        const rows = await fetchAllRows(table);
        backup.tables[table] = rows;
        total += rows.length;
      } catch (e) {
        console.warn(`Backup: error fetching ${table}:`, e);
        failed.push(`${table} (${e instanceof Error ? e.message : 'error'})`);
      }
    }

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const fname = `tac_backup_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}${failed.length ? '_PARTIAL' : ''}.json`;
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.click();
    URL.revokeObjectURL(url);

    setExportBusy(false);
    if (failed.length) {
      setExportOk(false);
      setExportStatus(`Exported ${total.toLocaleString()} records → ${fname}\nINCOMPLETE — these tables could not be read:\n${failed.join('\n')}`);
    } else {
      setExportOk(true);
      setExportStatus(`Exported ${total.toLocaleString()} records from ${BACKUP_TABLES.length} tables → ${fname}`);
    }
  }

  async function handleRestoreFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    if (!window.confirm(
      `Restore from "${file.name}"?\n\nThis will upsert all rows from the backup into each table. Existing rows with matching IDs will be overwritten.\n\nAre you sure?`
    )) return;

    let text: string;
    try {
      if (file.name.toLowerCase().endsWith('.gz')) {
        // Daily backups from Google Drive are gzip-compressed
        const stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
        text = await new Response(stream).text();
      } else {
        text = await file.text();
      }
    } catch {
      setRestoreOk(false);
      setRestoreStatus('Could not read the file (is it a valid .json or .json.gz backup?).');
      return;
    }

    let backup: { tables?: Record<string, unknown[]> };
    try {
      backup = JSON.parse(text);
    } catch {
      setRestoreOk(false);
      setRestoreStatus('Invalid JSON file.');
      return;
    }

    if (!backup.tables) {
      setRestoreOk(false);
      setRestoreStatus('File does not appear to be a TAC backup.');
      return;
    }

    await doRestore(backup as { tables: Record<string, unknown[]> });
  }

  async function doRestore(backup: { tables: Record<string, unknown[]> }) {
    setRestoreBusy(true);
    setRestoreOk(null);
    setRestoreStatus('Starting restore…');

    // Restore in dependency order (parents first) so foreign keys resolve.
    const known = new Set<string>(BACKUP_TABLES);
    const tables = BACKUP_TABLES.filter(t => t in backup.tables && !RESTORE_SKIP.has(t));
    const unknown = Object.keys(backup.tables).filter(t => !known.has(t) && t !== 'backup_runs');

    let totalRestored = 0;
    const errors: string[] = [];

    for (const table of tables) {
      const rows = backup.tables[table] || [];
      if (!rows.length) {
        setRestoreStatus(`Skipping ${table} (empty)…`);
        continue;
      }
      setRestoreStatus(`Restoring ${table} (${rows.length} rows)…`);

      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { error } = await supabase.from(table).upsert(chunk as Record<string, unknown>[], { onConflict: keyOf(table) });
        if (error) {
          errors.push(`${table}: ${error.message}`);
          break;
        }
        totalRestored += chunk.length;
      }
    }

    setRestoreBusy(false);

    const note = unknown.length ? `\nNot restored (not managed by this page): ${unknown.join(', ')}` : '';
    if (errors.length) {
      setRestoreOk(false);
      setRestoreStatus('Restore completed with errors:\n' + errors.join('\n') + note);
    } else {
      setRestoreOk(true);
      setRestoreStatus(`Restore complete — ${totalRestored.toLocaleString()} records upserted across ${tables.length} tables.${note}`);
    }

    showToast('Restore complete', true);
  }

  const cardCls = `${css.autoCard} ${banner === 'warn' || banner === 'unknown' ? css.autoCardWarn : banner === 'err' ? css.autoCardErr : ''}`;
  const sizeMb = latest?.file_size ? (latest.file_size / 1048576).toFixed(1) : null;
  const issues = [...(latest?.errors ?? []), ...(latest?.warnings ?? [])];

  return (
    <div className={css.page}>
      <div className={css.hdr}>
        <h2>Backup &amp; Restore</h2>
        <p>Export all data to a JSON file, or restore from a previous backup.</p>
      </div>

      <div className={cardCls}>
        <div className={css.cloudEmoji}>{banner === 'ok' ? '☁️' : banner === 'err' ? '🚨' : '⚠️'}</div>
        <div className={css.autoBody}>
          <div className={css.autoTitle}>
            {banner === 'loading' && 'Automatic Backup — checking…'}
            {banner === 'ok'      && `Automatic Backup — Active ✅ (last backup ${lastGood ? ago(lastGood.run_at) : ''})`}
            {banner === 'warn'    && `Automatic Backup — Check needed (last good backup ${lastGood ? ago(lastGood.run_at) : '—'})`}
            {banner === 'err'     && (lastGood
              ? `Automatic Backup — PROBLEM (last good backup ${ago(lastGood.run_at)})`
              : 'Automatic Backup — PROBLEM (no successful backup found)')}
            {banner === 'unknown' && 'Automatic Backup — status not reporting yet'}
          </div>
          <div className={css.autoDesc}>
            {banner === 'unknown' ? (
              <>The backup log isn&apos;t available. Run migration <strong>014_backup_runs.sql</strong> and install the
              updated Apps Script (<strong>scripts/google-apps-script/README.md</strong>) — until then this page can&apos;t
              confirm that backups are really running.</>
            ) : (
              <>Every hour the whole database is backed up to Google Drive (<strong>TAC_Backups</strong> folder):
              the last <strong>48 hourly</strong> copies plus <strong>one daily copy for 365 days</strong> (in the
              <strong> Daily</strong> sub-folder). Runs 24/7 on Google&apos;s servers, whether or not any device is on.</>
            )}
          </div>
          {latest && (
            <div className={css.autoStats}>
              <span>Last run: <b>{ago(latest.run_at)}</b></span>
              {latest.table_count != null && <span>Tables: <b>{latest.table_count}</b></span>}
              {latest.total_records != null && <span>Records: <b>{latest.total_records.toLocaleString()}</b></span>}
              {sizeMb && <span>Size: <b>{sizeMb} MB</b></span>}
              {latest.hourly_kept != null && <span>Hourly copies: <b>{latest.hourly_kept}</b></span>}
              {latest.daily_kept != null && <span>Daily copies: <b>{latest.daily_kept}</b></span>}
            </div>
          )}
          {issues.length > 0 && <div className={css.autoIssues}>{issues.join('\n')}</div>}
          <a href={GDRIVE_URL} target="_blank" rel="noopener noreferrer" className={css.driveBtn}>
            <ExternalLinkIcon /> Open Google Drive Backups
          </a>
        </div>
      </div>

      <div className={css.card}>
        <div className={css.cardTitle}>Export Backup</div>
        <div className={css.cardDesc}>Downloads a complete snapshot of all tables as a single JSON file.</div>
        <div className={css.tableList}>Tables: {BACKUP_TABLES.join(', ')}</div>
        <button className={css.btnExport} onClick={exportBackup} disabled={exportBusy}>
          <DownloadIcon /> {exportBusy ? 'Exporting…' : 'Export Backup'}
        </button>
        {exportStatus && (
          <div className={`${css.status} ${exportOk === true ? css.statusOk : exportOk === false ? css.statusErr : ''}`}>
            {exportOk === true ? '✓ ' : exportOk === false ? '✗ ' : ''}
            {exportStatus.split('\n').map((line, i, arr) => (
              <span key={i}>{line}{i < arr.length - 1 && <br />}</span>
            ))}
          </div>
        )}
      </div>

      <div className={css.card}>
        <div className={css.cardTitle}>Restore Backup</div>
        <div className={css.cardDesc}>Upload a previously exported backup (<code>.json</code> or the daily <code>.json.gz</code>) to restore all data.</div>
        <div className={css.warnBox}>
          ⚠️ Restoring will upsert data from the backup file into each table. Existing rows with matching IDs will be overwritten.
        </div>
        <button className={css.btnRestore} onClick={() => fileRef.current?.click()} disabled={restoreBusy}>
          <UploadIcon /> {restoreBusy ? 'Restoring…' : 'Choose Backup File…'}
        </button>
        <input type="file" accept=".json,.gz" ref={fileRef} style={{ display: 'none' }} onChange={handleRestoreFile} />
        {restoreStatus && (
          <div className={`${css.status} ${restoreOk === true ? css.statusOk : restoreOk === false ? css.statusErr : ''}`}>
            {restoreOk === true ? '✓ ' : restoreOk === false ? '✗ ' : ''}
            {restoreStatus.split('\n').map((line, i, arr) => (
              <span key={i}>{line}{i < arr.length - 1 && <br />}</span>
            ))}
          </div>
        )}
      </div>

      {toast && createPortal(
        <div className={`${css.toast} ${toast.ok ? css.toastOk : css.toastErr}`}>{toast.msg}</div>,
        document.body,
      )}
    </div>
  );
}
