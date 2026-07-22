import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import css from './BackupRestore.module.css';

const BACKUP_TABLES = [
  'users', 'sections', 'rows', 'activity_log', 'general_expenses',
  'team_members', 'revenue', 'project_expenses', 'expense_claims', 'employee_documents',
] as const;

const GDRIVE_URL = 'https://drive.google.com/drive/folders/1Iboi8xSHJkF4KcPVptkcIj2AznMO-CRJ?usp=share_link';

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

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  if (!currentUser || currentUser.role !== 'admin') {
    return <div className={css.page}><p className={css.denied}>Admin access only.</p></div>;
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

    for (const table of BACKUP_TABLES) {
      setExportStatus(`Fetching ${table}…`);
      try {
        const { data, error } = await supabase.from(table).select('*');
        if (error) {
          console.warn(`Backup: error fetching ${table}:`, error.message);
          backup.tables[table] = [];
        } else {
          backup.tables[table] = data || [];
          total += (data || []).length;
        }
      } catch {
        backup.tables[table] = [];
      }
    }

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const fname = `tac_backup_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}.json`;
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.click();
    URL.revokeObjectURL(url);

    setExportBusy(false);
    setExportOk(true);
    setExportStatus(`Exported ${total.toLocaleString()} total records → ${fname}`);
  }

  async function handleRestoreFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    if (!window.confirm(
      `Restore from "${file.name}"?\n\nThis will upsert all rows from the backup into each table. Existing rows with matching IDs will be overwritten.\n\nAre you sure?`
    )) return;

    const text = await file.text();
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

    // activity_log is deliberately excluded from restore — restoring history isn't the same as restoring live data
    const tables = Object.keys(backup.tables).filter(
      t => (BACKUP_TABLES as readonly string[]).includes(t) && t !== 'activity_log',
    );

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
        const { error } = await supabase.from(table).upsert(chunk as Record<string, unknown>[], { onConflict: 'id' });
        if (error) {
          errors.push(`${table}: ${error.message}`);
          break;
        }
        totalRestored += chunk.length;
      }
    }

    setRestoreBusy(false);

    if (errors.length) {
      setRestoreOk(false);
      setRestoreStatus('Restore completed with errors:\n' + errors.join('\n'));
    } else {
      setRestoreOk(true);
      setRestoreStatus(`Restore complete — ${totalRestored.toLocaleString()} records upserted across ${tables.length} tables.`);
    }

    showToast('Restore complete', true);
  }

  return (
    <div className={css.page}>
      <div className={css.hdr}>
        <h2>Backup &amp; Restore</h2>
        <p>Export all data to a JSON file, or restore from a previous backup.</p>
      </div>

      <div className={css.autoCard}>
        <div className={css.cloudEmoji}>☁️</div>
        <div className={css.autoBody}>
          <div className={css.autoTitle}>Automatic Backup — Active ✅</div>
          <div className={css.autoDesc}>
            Your data is automatically backed up every hour to Google Drive (<strong>TAC_Backups</strong> folder).
            The last 48 backups are kept (2 days of history). Backups run 24/7 on Google's servers
            regardless of whether your device is on or off.
          </div>
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
            {exportOk === true ? '✓ ' : exportOk === false ? '✗ ' : ''}{exportStatus}
          </div>
        )}
      </div>

      <div className={css.card}>
        <div className={css.cardTitle}>Restore Backup</div>
        <div className={css.cardDesc}>Upload a previously exported JSON backup file to restore all data.</div>
        <div className={css.warnBox}>
          ⚠️ Restoring will upsert data from the backup file into each table. Existing rows with matching IDs will be overwritten.
        </div>
        <button className={css.btnRestore} onClick={() => fileRef.current?.click()} disabled={restoreBusy}>
          <UploadIcon /> {restoreBusy ? 'Restoring…' : 'Choose Backup File…'}
        </button>
        <input type="file" accept=".json" ref={fileRef} style={{ display: 'none' }} onChange={handleRestoreFile} />
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
