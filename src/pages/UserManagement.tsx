import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { PROJ_NAMES } from './NetworkScopes';
import { logActivity } from '../lib/activityLog';
import { sendPushToRoles } from '../lib/pushNotify';
import { VIEW_CORE, VIEW_DAILY_WORK, VIEW_FINANCE, VIEW_HR, VIEW_ADMIN, VIEW_OTHER, ACTION_DEFS, ACTION_SCOPES, LEGACY_ACTION_KEY, FIELD_ROLE_DEFAULT_KEYS, type PermDef } from '../lib/permissionsCatalog';
import css from './UserManagement.module.css';

async function extractFnError(error: unknown, data: unknown): Promise<string> {
  if (error && typeof error === 'object' && 'context' in error) {
    const ctx = (error as { context: unknown }).context;
    if (ctx && typeof ctx === 'object' && 'json' in ctx && typeof (ctx as { json: unknown }).json === 'function') {
      try {
        const body = await (ctx as { json: () => Promise<{ error?: string }> }).json();
        if (body?.error) return body.error;
      } catch {
        // response body wasn't JSON or already consumed — fall through
      }
    }
  }
  if (data && typeof data === 'object' && 'error' in data) {
    const e = (data as { error: unknown }).error;
    if (typeof e === 'string' && e) return e;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const m = (error as { message: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return 'Unknown error';
}

interface UserRow {
  id: string;
  username: string;
  full_name: string | null;
  role: string;
  permissions: Record<string, boolean>;
  auth_user_id: string | null;
  created_at: string;
}

interface TeamMember { id: string; full_name: string; }

// ── Permission definitions (sourced from the shared catalog — see
// src/lib/permissionsCatalog.ts, also used by Sidebar.tsx for nav gating) ──

// Finance/HR/My Expenses/Activity Log view perms grouped under one
// "Finance & Admin" heading in the UI, matching the sidebar's grouping.
const VIEW_FINANCE_ADMIN = [...VIEW_FINANCE, ...VIEW_HR, ...VIEW_OTHER, ...VIEW_ADMIN];

function projPermKey(name: string): string {
  return 'view_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function projPermLabel(name: string): string {
  return PROJ_NAMES[name] || name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Toggle switch ─────────────────────────────────────────────────────────────
function Toggle({ id, checked, onChange }: { id: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={css.togSw}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} id={id} />
      <span className={css.togSl} />
    </label>
  );
}

// ── Role helpers ──────────────────────────────────────────────────────────────
const ROLE_LABELS: Record<string, string> = { admin: 'Admin', engineer: 'Engineer', technician: 'Technician', user: 'User' };
const ROLE_AV_CLS: Record<string, string> = { admin: css.avAdmin, engineer: css.avEngineer, technician: css.avTechnician, user: css.avUser };
const ROLE_BADGE_CLS: Record<string, string> = { admin: css.roleAdmin, engineer: css.roleEngineer, technician: css.roleTech, user: css.roleUser };

function initials(name: string | null, username: string): string {
  return (name || username || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function suggestUsername(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  const raw = parts.length >= 2 ? parts[0] + '.' + parts[parts.length - 1] : parts[0];
  return raw.toLowerCase().replace(/[^a-z0-9.]/g, '');
}

// ── Add User form state ───────────────────────────────────────────────────────
interface AddForm { fullName: string; username: string; password: string; role: string; }
const EMPTY_ADD: AddForm = { fullName: '', username: '', password: '', role: 'user' };

// ── Edit perm state (flat map key→boolean) ────────────────────────────────────
type PermMap = Record<string, boolean>;

export default function UserManagement() {
  const { currentUser, refreshProfile } = useAuth();
  if (currentUser?.role !== 'admin') return <div className={css.errorMsg}>Access denied. Admin only.</div>;

  const [users,    setUsers]    = useState<UserRow[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');
  const [search,   setSearch]   = useState('');
  const [members,  setMembers]  = useState<TeamMember[]>([]);

  // Add modal
  const [addOpen,  setAddOpen]  = useState(false);
  const [addForm,  setAddForm]  = useState<AddForm>(EMPTY_ADD);
  const [addErr,   setAddErr]   = useState('');
  const [addSaving,setAddSaving]= useState(false);

  // Edit modal
  const [editId,     setEditId]    = useState<string | null>(null);
  const [editFull,         setEditFull]         = useState('');
  const [editUser,         setEditUser]         = useState('');
  const [editOriginalUser, setEditOriginalUser] = useState('');
  const [editPw,           setEditPw]           = useState('');
  const [editRole,         setEditRole]         = useState('user');
  const [editErr,    setEditErr]   = useState('');
  const [editSaving, setEditSaving]= useState(false);
  const [dbProjects, setDbProjects]= useState<string[]>([]);
  const [perms,      setPerms]     = useState<PermMap>({});
  // Keys the admin has actually clicked in this edit session — see saveEdit()
  // for why this matters (only touched keys get persisted as explicit
  // overrides; untouched keys keep falling back to the code-level default).
  const [touchedPerms, setTouchedPerms] = useState<Set<string>>(new Set());

  const [toast,    setToast]    = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  async function load() {
    setLoading(true);
    setError('');
    const { data, error: e } = await supabase.from('users').select('*').order('created_at', { ascending: true });
    if (e) { setError(e.message); setLoading(false); return; }
    setUsers(data || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  // ── Filtered users (search) ────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return users;
    return users.filter(u =>
      (u.full_name || '').toLowerCase().includes(q) ||
      (u.username || '').toLowerCase().includes(q)
    );
  }, [users, search]);

  // ── Stat counts ────────────────────────────────────────────────────────────
  const counts = useMemo(() => {
    const c: Record<string, number> = { admin: 0, engineer: 0, technician: 0, user: 0 };
    users.forEach(u => { c[u.role] = (c[u.role] || 0) + 1; });
    return c;
  }, [users]);

  // ── Current VIEW defs (dynamic, rebuilt when edit modal opens) ─────────────
  const viewDefs = useMemo(() => {
    const projectDefs = [...new Set(dbProjects.filter(Boolean))].sort().map(name => ({
      key: projPermKey(name), label: projPermLabel(name),
    }));
    return [
      ...VIEW_CORE,
      ...VIEW_DAILY_WORK,
      ...projectDefs,
      ...VIEW_FINANCE_ADMIN,
    ];
  }, [dbProjects]);

  // ── Open add modal ─────────────────────────────────────────────────────────
  async function openAdd() {
    setAddForm(EMPTY_ADD);
    setAddErr('');
    // Fetch active team members for datalist
    const { data } = await supabase.from('team_members').select('id, full_name').eq('is_active', true).order('full_name');
    setMembers((data || []) as TeamMember[]);
    setAddOpen(true);
  }

  function onNameChange(val: string) {
    setAddForm(f => {
      const next = { ...f, fullName: val };
      if (!f.username.trim() && val) next.username = suggestUsername(val);
      return next;
    });
  }

  // ── Save new user ──────────────────────────────────────────────────────────
  async function saveAdd() {
    setAddErr('');
    const { fullName, username, password, role } = addForm;
    if (!fullName.trim()) { setAddErr('Full name is required.'); return; }
    if (!username.trim()) { setAddErr('Username is required.'); return; }
    if (!password)        { setAddErr('Password is required.'); return; }
    if (users.some(u => u.username === username.trim())) { setAddErr('Username already exists.'); return; }

    setAddSaving(true);
    const { data, error: e } = await supabase.functions.invoke('admin-user-ops', {
      body: { op: 'create', fullName: fullName.trim(), username: username.trim(), password, role },
    });
    setAddSaving(false);

    if (e || data?.error) { setAddErr('Create failed: ' + await extractFnError(e, data)); return; }

    const newRow = data?.data as UserRow;
    setUsers(us => [...us, newRow]);
    setAddOpen(false);
    showToast(`User "${username.trim()}" created`, true);
    void sendPushToRoles(['admin'], 'User Updated', `User account ${username.trim()} was created`);
    logActivity({
      userFullName: currentUser?.full_name ?? currentUser?.username,
      action: 'Add User',
      sectionName: 'User Management',
      details: `Created user: ${fullName.trim()} (${username.trim()}), role: ${role}`,
    });
  }

  // ── Open edit modal ────────────────────────────────────────────────────────
  async function openEdit(uid: string) {
    const u = users.find(x => x.id === uid);
    if (!u) return;
    setEditId(uid);
    setEditFull(u.full_name || '');
    setEditUser(u.username || '');
    setEditOriginalUser(u.username || '');
    setEditPw('');
    setEditRole(u.role || 'user');
    setEditErr('');

    // Initialize perms from saved permissions. For keys in FIELD_ROLE_DEFAULT_KEYS
    // that this user has never had explicitly set, show the effective default
    // (granted for Engineer/Technician) rather than a misleading "off" toggle —
    // this mirrors hasPerm()'s fallback logic in AuthContext.tsx. Saving still
    // writes an explicit true/false, so the default only applies until the
    // admin's first save.
    const saved = u.permissions || {};
    const editRoleLower = (u.role || '').toLowerCase();
    const isEditFieldRole = editRoleLower === 'engineer' || editRoleLower === 'technician';
    const initPerms: PermMap = {};
    [...VIEW_CORE, ...VIEW_DAILY_WORK, ...VIEW_FINANCE_ADMIN, ...ACTION_DEFS].forEach(({ key }) => {
      const stored = saved[key];
      if (typeof stored === 'boolean') {
        initPerms[key] = stored;
        return;
      }
      // Scoped action keys (da_add_rows, sdb_add_rows, …) show the legacy
      // global action value (add_rows, …) if that's the only thing set for
      // this user — matches hasPerm()'s fallback so the modal reflects what
      // the user can actually do right now, not a misleading "off" toggle.
      const legacyKey = LEGACY_ACTION_KEY[key];
      const legacyStored = legacyKey ? saved[legacyKey] : undefined;
      initPerms[key] = typeof legacyStored === 'boolean'
        ? legacyStored
        : isEditFieldRole && FIELD_ROLE_DEFAULT_KEYS.includes(key);
    });
    setPerms(initPerms);
    setTouchedPerms(new Set());

    // Fetch DB projects in background, then update
    supabase.from('sections').select('project_name').neq('project_name', null).then(({ data }) => {
      if (data) {
        const projs = [...new Set(data.map((r: { project_name: string }) => r.project_name).filter(Boolean))].sort() as string[];
        setDbProjects(projs);
        // Add any project perm keys that aren't in the initial map
        setPerms(prev => {
          const updated = { ...prev };
          projs.forEach(name => {
            const key = projPermKey(name);
            if (!(key in updated)) updated[key] = saved[key] === true;
          });
          return updated;
        });
      }
    });
  }

  function togglePerm(key: string, val: boolean) {
    setPerms(p => ({ ...p, [key]: val }));
    setTouchedPerms(t => new Set(t).add(key));
  }

  function togAll(defs: PermDef[], val: boolean) {
    setPerms(p => {
      const next = { ...p };
      defs.forEach(({ key }) => { next[key] = val; });
      return next;
    });
    setTouchedPerms(t => {
      const next = new Set(t);
      defs.forEach(({ key }) => next.add(key));
      return next;
    });
  }

  // ── Save edit ──────────────────────────────────────────────────────────────
  async function saveEdit() {
    setEditErr('');
    if (!editFull.trim()) { setEditErr('Full name is required.'); return; }
    if (!editUser.trim()) { setEditErr('Username is required.'); return; }
    const conflict = users.find(u => u.username === editUser.trim() && u.id !== editId);
    if (conflict) { setEditErr('Username already taken by another user.'); return; }

    // Merge, don't overwrite: start from whatever is already stored for this
    // user and only write keys the admin actually toggled in this session.
    // Untouched keys keep falling through to the code-level field-role
    // default in hasPerm() — otherwise every save would freeze the entire
    // permission set as explicit values (whatever the UI happened to show at
    // open time), silently shadowing any future default change for keys the
    // admin never meant to touch. See touchedPerms above.
    const editingUser = users.find(u => u.id === editId);
    const permissions: PermMap = { ...(editingUser?.permissions || {}) };
    [...viewDefs, ...ACTION_DEFS].forEach(({ key }) => {
      if (touchedPerms.has(key)) permissions[key] = perms[key] === true;
    });

    setEditSaving(true);

    // Run admin-gated Edge Function ops FIRST, while the caller's DB role is still
    // whatever it was before this save — avoids a self-demote (admin -> non-admin
    // in the same save) locking the caller out of their own remaining sync calls.

    // Sync Supabase Auth email only if the username actually changed
    if (editUser.trim() !== editOriginalUser) {
      const { data: userData, error: userErr } = await supabase.functions.invoke('admin-user-ops', {
        body: { op: 'update_username', userId: editId, newUsername: editUser.trim() },
      });
      if (userErr || userData?.error) {
        setEditErr('Username sync failed: ' + await extractFnError(userErr, userData));
        setEditSaving(false);
        return;
      }
    }

    // Password reset via Edge Function if entered
    if (editPw) {
      const { data: pwData, error: pwErr } = await supabase.functions.invoke('admin-user-ops', {
        body: { op: 'reset_password', userId: editId, newPassword: editPw },
      });
      if (pwErr || pwData?.error) {
        setEditErr('Password reset failed: ' + await extractFnError(pwErr, pwData));
        setEditSaving(false);
        return;
      }
    }

    // Plain profile row update last (may include the caller's own role change)
    const { data: updData, error: updErr } = await supabase
      .from('users')
      .update({ full_name: editFull.trim(), username: editUser.trim(), role: editRole, permissions })
      .eq('id', editId!)
      .select()
      .single();

    setEditSaving(false);

    if (updErr) { setEditErr('Profile save failed (username/password changes above already applied): ' + updErr.message); return; }

    setUsers(us => us.map(u => u.id === editId ? (updData as UserRow) : u));

    // If editing own profile, refresh auth context so permission/role changes take effect immediately
    if (editId === currentUser?.id) {
      await refreshProfile();
    }

    setEditId(null);
    showToast(`User "${editUser.trim()}" updated`, true);
    void sendPushToRoles(['admin'], 'User Updated', `User account ${editUser.trim()} was modified`);
    logActivity({
      userFullName: currentUser?.full_name ?? currentUser?.username,
      action: 'Edit User',
      sectionName: 'User Management',
      details: `Updated user: ${editFull.trim()} (${editUser.trim()}), role: ${editRole}`,
    });
  }

  // ── Delete ─────────────────────────────────────────────────────────────────
  async function deleteUser(id: string, username: string) {
    if (id === currentUser?.id) { showToast('Cannot delete your own account', false); return; }
    if (!window.confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    const { data, error: e } = await supabase.functions.invoke('admin-user-ops', {
      body: { op: 'delete', userId: id },
    });
    if (e || data?.error) { showToast('Delete failed: ' + await extractFnError(e, data), false); return; }
    setUsers(us => us.filter(u => u.id !== id));
    showToast(`User "${username}" deleted`, true);
    logActivity({
      userFullName: currentUser?.full_name ?? currentUser?.username,
      action: 'Delete User',
      sectionName: 'User Management',
      details: `Deleted user: ${username}`,
    });
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) return <div className={css.placeholder}>Loading users…</div>;
  if (error)   return <div className={css.errorMsg}>Failed to load users: {error}</div>;

  // Dynamic project defs for perm UI in edit modal
  const projDefs = [...new Set(dbProjects.filter(Boolean))].sort().map(name => ({
    key: projPermKey(name), label: projPermLabel(name),
  }));

  return (
    <div className={css.page}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className={css.hdr}>
        <div className={css.hdrText}>
          <h2>User Management</h2>
          <p>Manage users and their permissions</p>
        </div>
        <button className={css.btnAdd} onClick={openAdd}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add User
        </button>
      </div>

      {/* ── Stat cards ─────────────────────────────────────────── */}
      <div className={css.stats}>
        <div className={`${css.statCard} ${css.statTotal}`}><div className={css.statVal}>{users.length}</div><div className={css.statLbl}>Total Users</div></div>
        <div className={`${css.statCard} ${css.statAdmin}`}><div className={css.statVal}>{counts.admin || 0}</div><div className={css.statLbl}>Admins</div></div>
        <div className={`${css.statCard} ${css.statEng}`}><div className={css.statVal}>{counts.engineer || 0}</div><div className={css.statLbl}>Engineers</div></div>
        <div className={`${css.statCard} ${css.statTech}`}><div className={css.statVal}>{(counts.technician || 0) + (counts.user || 0)}</div><div className={css.statLbl}>Technicians / Users</div></div>
      </div>

      {/* ── Search ─────────────────────────────────────────────── */}
      <div className={css.searchWrap}>
        <span className={css.searchIcon}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        </span>
        <input
          className={css.searchInp}
          type="search"
          placeholder="Search by name or username…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* ── Cards grid ─────────────────────────────────────────── */}
      <div className={css.cardsGrid}>
        {filtered.length === 0
          ? <div className={css.emptyState}>No users found.</div>
          : filtered.map(u => {
              const isSelf = u.id === currentUser?.id;
              const role   = u.role || 'user';
              const init   = initials(u.full_name, u.username);
              return (
                <div key={u.id} className={`${css.userCard} ${isSelf ? css.userCardSelf : ''}`}>
                  <div className={`${css.avatar} ${ROLE_AV_CLS[role] || css.avUser}`}>{init}</div>
                  <div className={css.cardInfo}>
                    <div className={css.nameLine}>
                      <span className={css.cardName}>{u.full_name || u.username}</span>
                      {isSelf && <span className={css.youBadge}>You</span>}
                    </div>
                    <div className={css.cardUname}>@{u.username}</div>
                    <span className={`${css.roleBadge} ${ROLE_BADGE_CLS[role] || css.roleUser}`}>
                      {ROLE_LABELS[role] || 'User'}
                    </span>
                  </div>
                  <div className={css.cardActions}>
                    <button className={css.editBtn} onClick={() => openEdit(u.id)}>Edit</button>
                    {!isSelf && (
                      <button className={css.delBtn} title="Delete user" onClick={() => deleteUser(u.id, u.username)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                      </button>
                    )}
                  </div>
                </div>
              );
            })
        }
      </div>

      {/* ── Add User Modal ──────────────────────────────────────── */}
      {addOpen && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setAddOpen(false); }}>
          <div className={css.modal}>
            <div className={css.modalTitle}>Add User</div>
            <div className={css.formGrid}>
              <div className={`${css.formField} ${css.span2}`}>
                <label htmlFor="add-fullname">Full Name *</label>
                <input
                  id="add-fullname"
                  className={css.formInp}
                  list="um-fullname-list"
                  placeholder="Full name…"
                  value={addForm.fullName}
                  onChange={e => onNameChange(e.target.value)}
                />
                <datalist id="um-fullname-list">
                  {members.map(m => <option key={m.id} value={m.full_name} />)}
                </datalist>
              </div>
              <div className={css.formField}>
                <label htmlFor="add-username">Username *</label>
                <input
                  id="add-username"
                  className={css.formInp}
                  placeholder="e.g. ali.jasim"
                  value={addForm.username}
                  onChange={e => setAddForm(f => ({ ...f, username: e.target.value }))}
                />
              </div>
              <div className={css.formField}>
                <label htmlFor="add-role">Role *</label>
                <select id="add-role" className={css.formSel} value={addForm.role} onChange={e => setAddForm(f => ({ ...f, role: e.target.value }))}>
                  <option value="user">User</option>
                  <option value="technician">Technician</option>
                  <option value="engineer">Engineer</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div className={`${css.formField} ${css.span2}`}>
                <label htmlFor="add-password">Password *</label>
                <input
                  id="add-password"
                  className={css.formInp}
                  type="password"
                  placeholder="Password…"
                  value={addForm.password}
                  onChange={e => setAddForm(f => ({ ...f, password: e.target.value }))}
                />
              </div>
            </div>
            {addErr && <div className={css.formErr}>{addErr}</div>}
            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setAddOpen(false)}>Cancel</button>
              <button className={css.btnSave} disabled={addSaving} onClick={saveAdd}>
                {addSaving ? 'Creating…' : 'Create User'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Edit User Modal ─────────────────────────────────────── */}
      {editId !== null && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setEditId(null); }}>
          <div className={`${css.modal} ${css.modalLg}`}>
            <div className={css.modalTitle}>Edit User</div>
            <div className={css.modalSubtitle}>{editFull || editUser}</div>

            <div className={css.formGrid}>
              <div className={`${css.formField} ${css.span2}`}>
                <label htmlFor="edit-fullname">Full Name *</label>
                <input id="edit-fullname" className={css.formInp} value={editFull} onChange={e => setEditFull(e.target.value)} />
              </div>
              <div className={css.formField}>
                <label htmlFor="edit-username">Username *</label>
                <input id="edit-username" className={css.formInp} value={editUser} onChange={e => setEditUser(e.target.value)} />
              </div>
              <div className={css.formField}>
                <label htmlFor="edit-role">Role *</label>
                <select id="edit-role" className={css.formSel} value={editRole} onChange={e => setEditRole(e.target.value)}>
                  <option value="user">User</option>
                  <option value="technician">Technician</option>
                  <option value="engineer">Engineer</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div className={`${css.formField} ${css.span2}`}>
                <label htmlFor="edit-password">New Password</label>
                <input id="edit-password" className={css.formInp} type="password" placeholder="Leave blank to keep current…" value={editPw} onChange={e => setEditPw(e.target.value)} />
                <span className={css.formHint}>Only fill in to change the password.</span>
              </div>
            </div>

            {/* Permissions */}
            <div className={css.permSection}>
              <div className={css.permTitle}>Permissions</div>
              <div className={css.permCols}>
                {/* VIEW column */}
                <div className={css.permCol}>
                  <div className={css.permColHdr}>
                    <span className={css.permColTitle}>View</span>
                    <div className={css.togAllBtns}>
                      <button className={css.togAllBtn} onClick={() => togAll(viewDefs, true)}>All</button>
                      <span style={{ color: '#cbd5e1' }}>·</span>
                      <button className={css.togAllBtn} onClick={() => togAll(viewDefs, false)}>None</button>
                    </div>
                  </div>
                  {VIEW_CORE.map(({ key, label }) => (
                    <div key={key} className={css.togWrap}>
                      <span className={css.togLabel}>{label}</span>
                      <Toggle id={`ump-${key}`} checked={perms[key] === true} onChange={v => togglePerm(key, v)} />
                    </div>
                  ))}
                  <div className={css.permGroupLbl}>Daily Work</div>
                  {VIEW_DAILY_WORK.map(({ key, label }) => (
                    <div key={key} className={css.togWrap}>
                      <span className={css.togLabel}>{label}</span>
                      <Toggle id={`ump-${key}`} checked={perms[key] === true} onChange={v => togglePerm(key, v)} />
                    </div>
                  ))}
                  {projDefs.length > 0 && (
                    <>
                      <div className={css.permGroupLbl}>Projects</div>
                      {projDefs.map(({ key, label }) => (
                        <div key={key} className={css.togWrap}>
                          <span className={css.togLabel}>{label}</span>
                          <Toggle id={`ump-${key}`} checked={perms[key] === true} onChange={v => togglePerm(key, v)} />
                        </div>
                      ))}
                    </>
                  )}
                  <div className={css.permGroupLbl}>Finance &amp; Admin</div>
                  {VIEW_FINANCE_ADMIN.map(({ key, label }) => (
                    <div key={key} className={css.togWrap}>
                      <span className={css.togLabel}>{label}</span>
                      <Toggle id={`ump-${key}`} checked={perms[key] === true} onChange={v => togglePerm(key, v)} />
                    </div>
                  ))}
                </div>

                {/* ACTIONS column — scoped per page so e.g. Daily Activities
                    CRUD can be granted without also granting it on Sites DB */}
                <div className={css.permCol}>
                  <div className={css.permColHdr}>
                    <span className={css.permColTitle}>Actions</span>
                    <div className={css.togAllBtns}>
                      <button className={css.togAllBtn} onClick={() => togAll(ACTION_DEFS, true)}>All</button>
                      <span style={{ color: '#cbd5e1' }}>·</span>
                      <button className={css.togAllBtn} onClick={() => togAll(ACTION_DEFS, false)}>None</button>
                    </div>
                  </div>
                  {ACTION_SCOPES.map(scope => (
                    <div key={scope.id}>
                      <div className={css.permColHdr} style={{ margin: '10px 0 4px' }}>
                        <span className={css.permGroupLbl} style={{ padding: 0 }}>{scope.label}</span>
                        <div className={css.togAllBtns}>
                          <button className={css.togAllBtn} onClick={() => togAll(scope.actions, true)}>All</button>
                          <span style={{ color: '#cbd5e1' }}>·</span>
                          <button className={css.togAllBtn} onClick={() => togAll(scope.actions, false)}>None</button>
                        </div>
                      </div>
                      {scope.actions.map(({ key, label }) => (
                        <div key={key} className={css.togWrap}>
                          <span className={css.togLabel}>{label}</span>
                          <Toggle id={`ump-${key}`} checked={perms[key] === true} onChange={v => togglePerm(key, v)} />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {editErr && <div className={css.formErr}>{editErr}</div>}
            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setEditId(null)}>Cancel</button>
              <button className={css.btnSave} disabled={editSaving} onClick={saveEdit}>
                {editSaving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {toast && createPortal(
        <div className={`${css.toast} ${toast.ok ? css.toastOk : css.toastErr}`}>{toast.msg}</div>,
        document.body
      )}
    </div>
  );
}
