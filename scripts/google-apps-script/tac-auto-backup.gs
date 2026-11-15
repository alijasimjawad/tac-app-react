/**
 * TAC Auto Backup — Google Apps Script
 * ------------------------------------------------------------------
 * Runs hourly (time-driven trigger on tacAutoBackup) and:
 *   1. Backs up EVERY table in the Supabase database (tables are discovered
 *      automatically, so new tables are included without editing this file).
 *   2. Reads all rows (pages of 1000) so nothing is silently cut off.
 *   3. Keeps the last 48 hourly backups in  TAC_Backups/
 *   4. Keeps one daily copy (taken at 23:xx Baghdad time, gzip-compressed)
 *      for 365 days in  TAC_Backups/Daily/
 *   5. Logs every run to the backup_runs table (shown on the app's
 *      Backup & Restore page) and emails you if something fails.
 *
 * SETUP (once) — see scripts/google-apps-script/README.md
 *   Project Settings (gear icon) -> Script Properties -> add:
 *     SUPABASE_URL          https://<your-project>.supabase.co
 *     SUPABASE_SERVICE_KEY  the *secret* / service_role key (NOT the publishable key)
 *   The service key is needed because most tables are protected by row-level
 *   security that hides them from the public key.
 */

var CFG = {
  FOLDER_NAME:   'TAC_Backups',
  DAILY_FOLDER:  'Daily',
  KEEP_HOURLY:   48,
  KEEP_PARTIAL:  24,
  KEEP_DAILY:    365,
  DAILY_HOUR:    23,              // take the daily copy during this hour...
  TIMEZONE:      'Asia/Baghdad',  // ...in this time zone
  PAGE_SIZE:     1000,
  RETRIES:       3,
  ALERT_EVERY_H: 6,               // at most one failure email per N hours
  DROP_WARN_PCT: 50               // warn if records drop by more than this vs last run
};

// Used only if automatic table discovery fails.
var FALLBACK_TABLES = [
  'users','sections','rows','activity_log','sites','team_members','attendance',
  'clients','invoices','invoice_items','invoice_payments','daily_activities',
  'general_expenses','project_expenses','revenue','expense_claims',
  'employee_documents','salary_adjustments','push_subscriptions','projects',
  'capex_projects','cars','saved_points','field_trips','trip_participants',
  'advances','advance_distributions','app_settings','warehouses',
  'inventory_items','item_code_mappings','goods_receipts','goods_receipt_items',
  'receiving_scan_sessions','receiving_scan_log','goods_issues',
  'goods_issue_items','goods_issue_assets','inventory_assets','stock_balances',
  'stock_movements','smr_documents','smr_lines','smr_line_scans'
];

// Tables that are logs about the backup itself — not worth backing up.
var SKIP_TABLES = { backup_runs: true };

// ── Entry point (hourly trigger calls this) ───────────────────────────────────
function tacAutoBackup() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Another backup is still running — skipping.'); return; }

  var started = new Date();
  var run = {
    ok: false, partial: false, file_name: null, file_size: null,
    table_count: 0, total_records: 0, daily_file: null,
    hourly_kept: null, daily_kept: null, errors: [], warnings: [], duration_ms: 0
  };

  try {
    var cfg = getConfig_();
    var tables = discoverTables_(cfg, run);
    var backup = { exported_at: started.toISOString(), tables: {} };

    tables.forEach(function (t) {
      try {
        var rows = fetchAllRows_(cfg, t);
        backup.tables[t.name] = rows;
        run.total_records += rows.length;
        run.table_count++;
      } catch (e) {
        run.errors.push(t.name + ': ' + e.message);
        Logger.log('FAILED ' + t.name + ': ' + e.message);
      }
    });

    run.partial = run.errors.length > 0;
    var json = JSON.stringify(backup);

    // Hourly file
    var folder = getOrCreateFolder_(null, CFG.FOLDER_NAME);
    var stamp = Utilities.formatDate(started, 'UTC', 'yyyy-MM-dd_HH-mm');
    var fileName = 'tac_backup_' + stamp + (run.partial ? '_PARTIAL' : '') + '.json';
    var file = folder.createFile(fileName, json, MimeType.PLAIN_TEXT);
    run.file_name = fileName;
    run.file_size = file.getSize();
    run.hourly_kept = pruneHourly_(folder);

    // Daily file (gzip) — only from complete backups
    if (!run.partial) {
      var dailyFolder = getOrCreateFolder_(folder, CFG.DAILY_FOLDER);
      run.daily_file = maybeWriteDaily_(dailyFolder, json, started);
      run.daily_kept = pruneDaily_(dailyFolder);
    }

    // Sanity check vs the previous run
    var prev = getLastRun_(cfg);
    if (prev && prev.total_records > 100 && run.total_records < prev.total_records * (1 - CFG.DROP_WARN_PCT / 100)) {
      run.warnings.push('Total records dropped from ' + prev.total_records + ' to ' + run.total_records +
        ' since the previous backup. If this was not intentional, check the database before older backups expire.');
    }

    run.ok = !run.partial;
  } catch (e) {
    run.errors.push('Backup aborted: ' + e.message);
    Logger.log('ABORTED: ' + e.stack);
  }

  run.duration_ms = new Date().getTime() - started.getTime();

  try { logRun_(run); } catch (e) { Logger.log('Could not log run: ' + e.message); }
  if (!run.ok || run.warnings.length) { try { maybeAlert_(run); } catch (e) { Logger.log('Alert failed: ' + e.message); } }

  lock.releaseLock();
  if (!run.ok) throw new Error('Backup finished with problems: ' + run.errors.join(' | '));
}

// ── Config ────────────────────────────────────────────────────────────────────
function getConfig_() {
  var p = PropertiesService.getScriptProperties();
  var url = p.getProperty('SUPABASE_URL');
  var key = p.getProperty('SUPABASE_SERVICE_KEY');
  if (!url || !key) {
    throw new Error('Missing Script Properties SUPABASE_URL and/or SUPABASE_SERVICE_KEY (Project Settings -> Script Properties).');
  }
  return { url: url.replace(/\/+$/, ''), key: key };
}

function headers_(cfg, extra) {
  var h = { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key };
  for (var k in (extra || {})) h[k] = extra[k];
  return h;
}

// ── Table discovery ───────────────────────────────────────────────────────────
// PostgREST publishes an OpenAPI description at /rest/v1/ listing every table
// and its columns. Returns [{name, orderCol}].
function discoverTables_(cfg, run) {
  try {
    var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/', { method: 'get', headers: headers_(cfg), muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) throw new Error('HTTP ' + resp.getResponseCode());
    var spec = JSON.parse(resp.getContentText());
    var defs = spec.definitions || {};
    var out = [];
    Object.keys(defs).sort().forEach(function (name) {
      if (SKIP_TABLES[name]) return;
      var props = Object.keys((defs[name] && defs[name].properties) || {});
      out.push({ name: name, orderCol: props.indexOf('id') >= 0 ? 'id' : (props[0] || null) });
    });
    if (!out.length) throw new Error('no tables found in API description');
    return out;
  } catch (e) {
    run.warnings.push('Automatic table discovery failed (' + e.message + ') — used the built-in table list. New tables would be missed until this is fixed.');
    return FALLBACK_TABLES.map(function (n) { return { name: n, orderCol: 'id' }; });
  }
}

// ── Fetch every row of a table (paged, retried) ───────────────────────────────
function fetchAllRows_(cfg, table) {
  var all = [];
  var from = 0;
  while (true) {
    var page = fetchPage_(cfg, table, from, from + CFG.PAGE_SIZE - 1);
    for (var i = 0; i < page.length; i++) all.push(page[i]);
    if (page.length < CFG.PAGE_SIZE) break;
    from += CFG.PAGE_SIZE;
  }
  return all;
}

function fetchPage_(cfg, table, from, to) {
  var q = '?select=*' + (table.orderCol ? '&order=' + encodeURIComponent(table.orderCol) + '.asc' : '');
  var lastErr = '';
  for (var attempt = 1; attempt <= CFG.RETRIES; attempt++) {
    try {
      var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + table.name + q, {
        method: 'get',
        headers: headers_(cfg, { 'Range-Unit': 'items', Range: from + '-' + to }),
        muteHttpExceptions: true
      });
      var code = resp.getResponseCode();
      if (code === 200 || code === 206) return JSON.parse(resp.getContentText());
      // empty range past the end of the table
      if (code === 416) return [];
      lastErr = 'HTTP ' + code + ' ' + resp.getContentText().substring(0, 200);
      // ordering column missing -> retry once without ordering
      if (code === 400 && table.orderCol) { table.orderCol = null; q = '?select=*'; continue; }
    } catch (e) {
      lastErr = e.message;
    }
    Utilities.sleep(1000 * attempt);
  }
  throw new Error(lastErr || 'unknown error');
}

// ── Drive helpers ─────────────────────────────────────────────────────────────
function getOrCreateFolder_(parent, name) {
  var it = parent ? parent.getFoldersByName(name) : DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : (parent ? parent.createFolder(name) : DriveApp.createFolder(name));
}

function listFiles_(folder, prefix) {
  var out = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.getName().indexOf(prefix) === 0) out.push(f);
  }
  out.sort(function (a, b) { return a.getName() < b.getName() ? -1 : 1; }); // oldest first
  return out;
}

// Keep newest KEEP_HOURLY complete backups and newest KEEP_PARTIAL partial ones.
function pruneHourly_(folder) {
  var files = listFiles_(folder, 'tac_backup_');
  var complete = files.filter(function (f) { return f.getName().indexOf('_PARTIAL') < 0; });
  var partial  = files.filter(function (f) { return f.getName().indexOf('_PARTIAL') >= 0; });
  while (complete.length > CFG.KEEP_HOURLY) complete.shift().setTrashed(true);
  while (partial.length  > CFG.KEEP_PARTIAL) partial.shift().setTrashed(true);
  return complete.length;
}

function maybeWriteDaily_(dailyFolder, json, now) {
  var day  = Utilities.formatDate(now, CFG.TIMEZONE, 'yyyy-MM-dd');
  var hour = parseInt(Utilities.formatDate(now, CFG.TIMEZONE, 'H'), 10);
  var name = 'tac_daily_' + day + '.json.gz';
  var existing = dailyFolder.getFilesByName(name);
  if (existing.hasNext()) return null;
  var folderEmpty = !dailyFolder.getFiles().hasNext();
  if (hour !== CFG.DAILY_HOUR && !folderEmpty) return null;   // seed the very first daily copy immediately
  var gz = Utilities.gzip(Utilities.newBlob(json, 'application/json', 'tac_daily_' + day + '.json'), name);
  dailyFolder.createFile(gz);
  return name;
}

function pruneDaily_(dailyFolder) {
  var files = listFiles_(dailyFolder, 'tac_daily_');
  while (files.length > CFG.KEEP_DAILY) files.shift().setTrashed(true);
  return files.length;
}

// ── Run log (Supabase backup_runs table) ──────────────────────────────────────
function logRun_(run) {
  var cfg = getConfig_();
  UrlFetchApp.fetch(cfg.url + '/rest/v1/backup_runs', {
    method: 'post',
    contentType: 'application/json',
    headers: headers_(cfg, { Prefer: 'return=minimal' }),
    payload: JSON.stringify(run),
    muteHttpExceptions: true
  });
  // keep ~30 days of history
  var cutoff = new Date(new Date().getTime() - 30 * 24 * 3600 * 1000).toISOString();
  UrlFetchApp.fetch(cfg.url + '/rest/v1/backup_runs?run_at=lt.' + encodeURIComponent(cutoff), {
    method: 'delete', headers: headers_(cfg), muteHttpExceptions: true
  });
}

function getLastRun_(cfg) {
  var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/backup_runs?select=total_records,ok&ok=eq.true&order=run_at.desc&limit=1', {
    method: 'get', headers: headers_(cfg), muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) return null;
  var rows = JSON.parse(resp.getContentText());
  return rows.length ? rows[0] : null;
}

// ── Email alert (rate-limited) ────────────────────────────────────────────────
function maybeAlert_(run) {
  var props = PropertiesService.getScriptProperties();
  var last = parseInt(props.getProperty('LAST_ALERT_MS') || '0', 10);
  var now = new Date().getTime();
  if (now - last < CFG.ALERT_EVERY_H * 3600 * 1000) return;
  props.setProperty('LAST_ALERT_MS', String(now));
  var to = Session.getEffectiveUser().getEmail();
  var body = (run.ok ? 'Backup completed with warnings.\n\n' : 'The TAC backup has problems.\n\n') +
    (run.errors.length   ? 'ERRORS:\n  - ' + run.errors.join('\n  - ') + '\n\n' : '') +
    (run.warnings.length ? 'WARNINGS:\n  - ' + run.warnings.join('\n  - ') + '\n\n' : '') +
    'File: ' + (run.file_name || '(none)') + '\nTables: ' + run.table_count + '   Records: ' + run.total_records;
  MailApp.sendEmail(to, run.ok ? 'TAC backup warning' : 'TAC backup FAILED', body);
}

// ── Manual helpers (run from the editor) ──────────────────────────────────────
/** Run once from the editor to verify setup: lists the tables and row counts. */
function testBackupSetup() {
  var cfg = getConfig_();
  var run = { warnings: [] };
  var tables = discoverTables_(cfg, run);
  tables.forEach(function (t) {
    try { Logger.log(t.name + ': ' + fetchAllRows_(cfg, t).length + ' rows'); }
    catch (e) { Logger.log(t.name + ': ERROR ' + e.message); }
  });
  Logger.log('Warnings: ' + JSON.stringify(run.warnings));
}
