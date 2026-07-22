import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import styles from './Sidebar.module.css';
import { SiteLookupIcon } from '../pages/SiteLookup';
import { FinanceIcon } from '../pages/FinTeam';
import { PROJ_NAMES, SEC_LABELS } from '../pages/NetworkScopes';
import { ensureSectionsLoaded, getSections, invalidateSections } from '../lib/sectionsCache';
import type { SectionMeta } from '../lib/sectionsCache';


const DEFAULT_SECTIONS: Record<string, string[]> = {
  zain:   ['ftk', 'tdd', 'addsector'],
  nokia:  ['ftk', 'tdd', 'addsector'],
  huawei: ['ftk', 'tdd', 'addsector'],
  ipt:    ['tdd'],
};

const DEFAULT_HEADERS = ['Site ID', 'Governate', 'Imp. Date', 'ATP Status', 'Comment'];

const PROJECTS = ['zain', 'nokia', 'huawei', 'ipt'] as const;

// ── Network Scopes sidebar tree ───────────────────────────────────────────────

function NetworkScopesTree() {
  const { hasPerm } = useAuth();
  const params = useParams<{ proj?: string; sec?: string }>();
  const navigate = useNavigate();
  const [sections, setSections] = useState<SectionMeta[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [nsCollapsed, setNsCollapsed] = useState(false);

  // Section management state
  const [addSecState, setAddSecState]       = useState<{ proj: string; name: string } | null>(null);
  const [renameSecState, setRenameSecState] = useState<{ proj: string; secId: string; name: string } | null>(null);
  const [deleteSecState, setDeleteSecState] = useState<{
    proj: string; secId: string; key: string; label: string; isCustom: boolean; typed: string;
  } | null>(null);
  const [secMenu, setSecMenu]         = useState<{ proj: string; key: string } | null>(null);
  const [secModalSaving, setSecModalSaving] = useState(false);
  const [secError, setSecError]       = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureSectionsLoaded().then(() => setSections(getSections()));
  }, []);

  // Close section menu on outside click
  useEffect(() => {
    if (!secMenu) return;
    function onOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setSecMenu(null);
    }
    setTimeout(() => document.addEventListener('click', onOutside), 10);
    return () => document.removeEventListener('click', onOutside);
  }, [secMenu]);

  async function reloadSections() {
    invalidateSections();
    await ensureSectionsLoaded();
    setSections(getSections());
  }

  function toggleProj(proj: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(proj)) next.delete(proj);
      else next.add(proj);
      return next;
    });
  }

  function getSectionsForProj(proj: string): Array<{ key: string; label: string; isCustom: boolean; id: string }> {
    const dbSecs = sections.filter(s => s.project_name === proj && !s.is_deleted);
    const dbMap  = new Map(dbSecs.map(s => [s.section_name, s]));
    const result: Array<{ key: string; label: string; isCustom: boolean; id: string }> = [];

    for (const key of DEFAULT_SECTIONS[proj] ?? []) {
      const deleted = sections.find(s => s.project_name === proj && s.section_name === key && s.is_deleted);
      if (deleted) continue;
      const dbSec = dbMap.get(key);
      result.push({
        key,
        label: dbSec?.section_label ?? SEC_LABELS[key] ?? key,
        isCustom: false,
        id: dbSec?.id ?? '',
      });
    }

    for (const s of dbSecs) {
      if (s.is_custom) {
        result.push({ key: s.section_name, label: s.section_label, isCustom: true, id: s.id });
      }
    }

    return result;
  }

  async function confirmAddSection() {
    if (!addSecState) return;
    const name = addSecState.name.trim();
    if (!name) { setSecError('Name cannot be empty'); return; }
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'section';
    const key  = base + '_' + Date.now().toString(36);
    setSecModalSaving(true);
    setSecError(null);
    const { error } = await supabase.from('sections').insert({
      project_name: addSecState.proj,
      section_name: key,
      section_label: name,
      columns: DEFAULT_HEADERS,
      custom_columns: [],
      is_custom: true,
    });
    setSecModalSaving(false);
    if (error) { setSecError(error.message); return; }
    const savedProj = addSecState.proj;
    await reloadSections();
    setAddSecState(null);
    navigate(`/network-scopes/${savedProj}/${key}`);
  }

  async function confirmRenameSection() {
    if (!renameSecState) return;
    const label = renameSecState.name.trim();
    if (!label) { setSecError('Name cannot be empty'); return; }
    setSecModalSaving(true);
    setSecError(null);
    const { error } = await supabase.from('sections')
      .update({ section_label: label })
      .eq('id', renameSecState.secId);
    setSecModalSaving(false);
    if (error) { setSecError(error.message); return; }
    await reloadSections();
    setRenameSecState(null);
  }

  async function confirmDeleteSection() {
    if (!deleteSecState) return;
    if (deleteSecState.typed.toLowerCase() !== deleteSecState.label.toLowerCase()) {
      setSecError('Section name does not match');
      return;
    }
    setSecModalSaving(true);
    setSecError(null);
    let saveErr: { message: string } | null = null;
    if (deleteSecState.isCustom) {
      const res = await supabase.from('sections').delete().eq('id', deleteSecState.secId);
      saveErr = res.error;
    } else {
      const res = await supabase.from('sections').update({ is_deleted: true }).eq('id', deleteSecState.secId);
      saveErr = res.error;
    }
    setSecModalSaving(false);
    if (saveErr) { setSecError(saveErr.message); return; }
    if (params.proj === deleteSecState.proj && params.sec === deleteSecState.key) {
      navigate('/network-scopes');
    }
    await reloadSections();
    setDeleteSecState(null);
  }

  const visibleProjects = PROJECTS.filter(p => hasPerm(`view_${p}`));
  if (visibleProjects.length === 0) return null;

  const canManageSec = hasPerm('rename_section') || hasPerm('delete_section');

  return (
    <div className={styles.nsSection}>
      <div className={styles.nsSectionHdr} onClick={() => setNsCollapsed(v => !v)}>
        <div className={styles.nsHdrLeft}>
          <GridTableIcon />
          <span>Network Scopes</span>
        </div>
        <svg
          className={`${styles.nsChevron} ${nsCollapsed ? styles.nsChevronClosed : ''}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          width="12" height="12"
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>

      {!nsCollapsed && (
        <div className={styles.nsBody}>
          {visibleProjects.map((proj, pi) => {
            const secs  = getSectionsForProj(proj);
            const isOpen = !collapsed.has(proj);
            return (
              <div key={proj}>
                {pi > 0 && <div className={styles.nsDivider} />}
                <div className={styles.projGroup}>
                  <div className={styles.projHeader} onClick={() => toggleProj(proj)}>
                    <ProjIcon proj={proj} />
                    <div className={styles.projHeaderText}>
                      <span className={styles.projName}>{PROJ_NAMES[proj]}</span>
                      <span className={styles.projSub}>{secs.length} section{secs.length !== 1 ? 's' : ''}</span>
                    </div>
                    <svg
                      className={`${styles.projChevron} ${isOpen ? '' : styles.projChevronClosed}`}
                      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                      width="11" height="11"
                    >
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </div>
                  {isOpen && (
                    <div className={styles.projChildren}>
                      {secs.map(({ key, label, isCustom, id }) => {
                        const isActive = params.proj === proj && params.sec === key;
                        const menuOpen = secMenu?.proj === proj && secMenu?.key === key;
                        const showMenu = canManageSec && id !== '';
                        return (
                          <div key={key} className={styles.secLinkWrap}>
                            <NavLink
                              to={`/network-scopes/${proj}/${key}`}
                              className={`${styles.secLink} ${isActive ? styles.secLinkActive : ''}`}
                              onClick={() => setSecMenu(null)}
                            >
                              <span className={`${styles.secDot} ${isActive ? styles.secDotActive : ''}`} />
                              <span className={styles.secLinkLabel}>{label}</span>
                              <span className={styles.secArr}>›</span>
                            </NavLink>
                            {showMenu && (
                              <div style={{ position: 'relative', flexShrink: 0 }}>
                                <button
                                  className={styles.secMenuBtn}
                                  onClick={e => {
                                    e.stopPropagation();
                                    setSecMenu(menuOpen ? null : { proj, key });
                                    setSecError(null);
                                  }}
                                  title="Section options"
                                >
                                  ⋮
                                </button>
                                {menuOpen && (
                                  <div ref={menuRef} className={styles.secMenuDropdown} onClick={e => e.stopPropagation()}>
                                    {hasPerm('rename_section') && (
                                      <button
                                        className={styles.secMenuItem}
                                        onClick={() => {
                                          setSecMenu(null);
                                          setSecError(null);
                                          setRenameSecState({ proj, secId: id, name: label });
                                        }}
                                      >
                                        Rename
                                      </button>
                                    )}
                                    {hasPerm('delete_section') && (
                                      <button
                                        className={`${styles.secMenuItem} ${styles.secMenuItemDanger}`}
                                        onClick={() => {
                                          setSecMenu(null);
                                          setSecError(null);
                                          setDeleteSecState({ proj, secId: id, key, label, isCustom, typed: '' });
                                        }}
                                      >
                                        Delete
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {hasPerm('add_section') && (
                        <button
                          className={styles.addSecBtn}
                          onClick={() => { setSecError(null); setAddSecState({ proj, name: '' }); }}
                        >
                          + Add Section
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Add Section modal ──────────────────────────────────────────────── */}
      {addSecState && createPortal(
        <div className={styles.secModalOverlay} onClick={() => !secModalSaving && setAddSecState(null)}>
          <div className={styles.secModal} onClick={e => e.stopPropagation()}>
            <div className={styles.secModalTitle}>Add Section — {PROJ_NAMES[addSecState.proj]}</div>
            <div className={styles.secModalDesc}>
              Enter a name for the new section. It will appear in the sidebar immediately.
            </div>
            <input
              className={styles.secModalInput}
              placeholder="Section name"
              value={addSecState.name}
              autoFocus
              onChange={e => setAddSecState(s => s ? { ...s, name: e.target.value } : null)}
              onKeyDown={e => e.key === 'Enter' && confirmAddSection()}
            />
            {secError && <div className={styles.secModalError}>{secError}</div>}
            <div className={styles.secModalActions}>
              <button className={styles.sbBtnGreen} disabled={secModalSaving} onClick={confirmAddSection}>
                {secModalSaving ? 'Creating…' : 'Create Section'}
              </button>
              <button className={styles.sbBtnGhost} disabled={secModalSaving} onClick={() => setAddSecState(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Rename Section modal ───────────────────────────────────────────── */}
      {renameSecState && createPortal(
        <div className={styles.secModalOverlay} onClick={() => !secModalSaving && setRenameSecState(null)}>
          <div className={styles.secModal} onClick={e => e.stopPropagation()}>
            <div className={styles.secModalTitle}>Rename Section</div>
            <input
              className={styles.secModalInput}
              placeholder="New section name"
              value={renameSecState.name}
              autoFocus
              onChange={e => setRenameSecState(s => s ? { ...s, name: e.target.value } : null)}
              onKeyDown={e => e.key === 'Enter' && confirmRenameSection()}
            />
            {secError && <div className={styles.secModalError}>{secError}</div>}
            <div className={styles.secModalActions}>
              <button className={styles.sbBtnGreen} disabled={secModalSaving} onClick={confirmRenameSection}>
                {secModalSaving ? 'Saving…' : 'Rename'}
              </button>
              <button className={styles.sbBtnGhost} disabled={secModalSaving} onClick={() => setRenameSecState(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Delete Section modal ───────────────────────────────────────────── */}
      {deleteSecState && createPortal(
        <div className={styles.secModalOverlay} onClick={() => !secModalSaving && setDeleteSecState(null)}>
          <div className={styles.secModal} onClick={e => e.stopPropagation()}>
            <div className={styles.secModalTitle}>Delete Section</div>
            <div className={styles.secModalDesc}>
              Type <strong>{deleteSecState.label}</strong> to confirm.
              {' '}
              {deleteSecState.isCustom
                ? 'All rows will be permanently deleted and cannot be recovered.'
                : 'This section will be hidden. Contact an admin to restore it.'}
            </div>
            <input
              className={styles.secModalInput}
              placeholder="Type section name to confirm"
              value={deleteSecState.typed}
              autoFocus
              onChange={e => setDeleteSecState(s => s ? { ...s, typed: e.target.value } : null)}
              onKeyDown={e => e.key === 'Enter' && confirmDeleteSection()}
            />
            {secError && <div className={styles.secModalError}>{secError}</div>}
            <div className={styles.secModalActions}>
              <button className={styles.sbBtnDanger} disabled={secModalSaving} onClick={confirmDeleteSection}>
                {secModalSaving ? 'Deleting…' : 'Delete Section'}
              </button>
              <button className={styles.sbBtnGhost} disabled={secModalSaving} onClick={() => setDeleteSecState(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Project icon ──────────────────────────────────────────────────────────────

function ProjIcon({ proj }: { proj: string }) {
  if (proj === 'zain') return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={styles.projIcon}>
      <path d="M1.5 8.5a13 13 0 0 1 21 0"/><path d="M5 12a9 9 0 0 1 14 0"/>
      <path d="M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none"/>
    </svg>
  );
  if (proj === 'nokia') return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={styles.projIcon}>
      <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>
    </svg>
  );
  if (proj === 'huawei') return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={styles.projIcon}>
      <rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/>
      <line x1="9" y1="2" x2="9" y2="4"/><line x1="15" y1="2" x2="15" y2="4"/>
      <line x1="9" y1="20" x2="9" y2="22"/><line x1="15" y1="20" x2="15" y2="22"/>
      <line x1="20" y1="9" x2="22" y2="9"/><line x1="20" y1="14" x2="22" y2="14"/>
      <line x1="2" y1="9" x2="4" y2="9"/><line x1="2" y1="14" x2="4" y2="14"/>
    </svg>
  );
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={styles.projIcon}>
      <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
    </svg>
  );
}

function GridTableIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <line x1="3" y1="9" x2="21" y2="9"/>
      <line x1="9" y1="21" x2="9" y2="9"/>
    </svg>
  );
}

// ── Finance nav group ─────────────────────────────────────────────────────────

function FinanceNavGroup() {
  const { hasPerm } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  const FIN_LINKS = [
    ...(hasPerm('view_fin_team')      ? [{ to: '/finance/team',              label: 'Team Members' }]      : []),
    ...(hasPerm('view_fin_revenue')   ? [{ to: '/finance/revenue',           label: 'Revenue' }]           : []),
    ...(hasPerm('view_fin_genexp')    ? [{ to: '/finance/general-expenses',  label: 'General Expenses' }]  : []),
    ...(hasPerm('view_fin_projexp')   ? [{ to: '/finance/project-expenses',  label: 'Project Expenses' }]  : []),
    ...(hasPerm('view_fin_dashboard') ? [{ to: '/finance/dashboard',         label: 'Finance Dashboard' }] : []),
    ...(hasPerm('view_fin_report')    ? [{ to: '/finance/monthly-report',    label: 'Monthly Report' }]    : []),
    ...(hasPerm('view_fin_clients')   ? [{ to: '/finance/clients',           label: 'Clients' }]            : []),
    ...(hasPerm('view_fin_invoices')  ? [{ to: '/finance/invoices',          label: 'Invoices' }]           : []),
    ...(hasPerm('view_exp_claims')    ? [{ to: '/finance/expense-claims',    label: 'Expense Claims' }]      : []),
  ];

  if (FIN_LINKS.length === 0) return null;

  return (
    <div className={styles.nsSection}>
      <div className={styles.nsSectionHdr} onClick={() => setCollapsed(v => !v)}>
        <div className={styles.nsHdrLeft}>
          <FinanceIcon />
          <span>Finance</span>
        </div>
        <svg
          className={`${styles.nsChevron} ${collapsed ? styles.nsChevronClosed : ''}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          width="12" height="12"
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>
      {!collapsed && (
        <div className={styles.nsBody}>
          <div className={styles.projGroup}>
            <div className={styles.projChildren}>
              {FIN_LINKS.map(({ to, label }) => (
                <div key={to} className={styles.secLinkWrap}>
                  <NavLink
                    to={to}
                    className={({ isActive }) =>
                      `${styles.secLink} ${isActive ? styles.secLinkActive : ''}`
                    }
                  >
                    <span className={`${styles.secDot}`} />
                    <span className={styles.secLinkLabel}>{label}</span>
                    <span className={styles.secArr}>›</span>
                  </NavLink>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── HR nav group ──────────────────────────────────────────────────────────────

function HrNavGroup() {
  const { currentUser, hasPerm } = useAuth();
  const isAdmin = currentUser?.role === 'admin';
  const [collapsed, setCollapsed] = useState(false);

  const HR_LINKS = [
    ...(hasPerm('view_hr_profiles') ? [{ to: '/hr-profiles',      label: 'Employee Profiles' }] : []),
    ...(isAdmin                     ? [{ to: '/attendance-admin', label: 'Attendance' }]         : []),
  ];

  if (HR_LINKS.length === 0) return null;

  return (
    <div className={styles.nsSection}>
      <div className={styles.nsSectionHdr} onClick={() => setCollapsed(v => !v)}>
        <div className={styles.nsHdrLeft}>
          <HrGroupIcon />
          <span>HR</span>
        </div>
        <svg
          className={`${styles.nsChevron} ${collapsed ? styles.nsChevronClosed : ''}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          width="12" height="12"
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>
      {!collapsed && (
        <div className={styles.nsBody}>
          <div className={styles.projGroup}>
            <div className={styles.projChildren}>
              {HR_LINKS.map(({ to, label }) => (
                <div key={to} className={styles.secLinkWrap}>
                  <NavLink
                    to={to}
                    className={({ isActive }) =>
                      `${styles.secLink} ${isActive ? styles.secLinkActive : ''}`
                    }
                  >
                    <span className={styles.secDot} />
                    <span className={styles.secLinkLabel}>{label}</span>
                    <span className={styles.secArr}>›</span>
                  </NavLink>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Admin nav group ───────────────────────────────────────────────────────────

function AdminNavGroup() {
  const { currentUser, hasPerm } = useAuth();
  const isAdmin = currentUser?.role === 'admin';
  const [collapsed, setCollapsed] = useState(false);

  const ADMIN_LINKS = [
    ...(isAdmin                      ? [{ to: '/live-trips',      label: 'Live Trips' }]       : []),
    ...(hasPerm('view_activity_log') ? [{ to: '/activity-log',    label: 'Activity Log' }]     : []),
    ...(isAdmin                      ? [{ to: '/user-management', label: 'User Management' }]  : []),
    ...(isAdmin                      ? [{ to: '/backup-restore',  label: 'Backup & Restore' }] : []),
  ];

  if (ADMIN_LINKS.length === 0) return null;

  return (
    <div className={styles.nsSection}>
      <div className={styles.nsSectionHdr} onClick={() => setCollapsed(v => !v)}>
        <div className={styles.nsHdrLeft}>
          <AdminGroupIcon />
          <span>Admin</span>
        </div>
        <svg
          className={`${styles.nsChevron} ${collapsed ? styles.nsChevronClosed : ''}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          width="12" height="12"
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>
      {!collapsed && (
        <div className={styles.nsBody}>
          <div className={styles.projGroup}>
            <div className={styles.projChildren}>
              {ADMIN_LINKS.map(({ to, label }) => (
                <div key={to} className={styles.secLinkWrap}>
                  <NavLink
                    to={to}
                    className={({ isActive }) =>
                      `${styles.secLink} ${isActive ? styles.secLinkActive : ''}`
                    }
                  >
                    <span className={styles.secDot} />
                    <span className={styles.secLinkLabel}>{label}</span>
                    <span className={styles.secArr}>›</span>
                  </NavLink>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Sidebar ──────────────────────────────────────────────────────────────

export default function Sidebar() {
  const { hasPerm } = useAuth();

  const NAV_TOP = [
    { to: '/dashboard', label: 'Dashboard', icon: GridIcon },
  ];

  const NAV_MID = [
    { to: '/daily-activities', label: 'Daily Activities', icon: ActivityIcon },
    ...(hasPerm('view_site_lookup')   ? [{ to: '/site-lookup',   label: 'Site Lookup',   icon: SiteLookupIcon }] : []),
    ...(hasPerm('view_route_planner') ? [{ to: '/route-planner', label: 'Route Planner', icon: RouteIcon }]      : []),
    { to: '/sites-db',    label: 'Sites DB',      icon: DatabaseIcon },
    { to: '/attendance',  label: 'My Attendance', icon: ClockIcon },
    { to: '/my-trips',    label: 'My Trips',      icon: CarIcon },
    { to: '/my-expenses', label: 'My Expenses',   icon: ReceiptIcon },
  ];

  const navLinks = (items: typeof NAV_TOP) => items.map(({ to, label, icon: Icon }) => (
    <NavLink
      key={to}
      to={to}
      className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}
    >
      <Icon />
      <span>{label}</span>
    </NavLink>
  ));

  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <div className={styles.brandIcon}>T</div>
        <div>
          <div className={styles.brandName}>TAC Network</div>
          <div className={styles.brandSub}>Telecom Mgmt</div>
        </div>
      </div>

      <nav className={styles.nav}>{navLinks(NAV_TOP)}</nav>

      <NetworkScopesTree />

      <nav className={styles.nav}>{navLinks(NAV_MID)}</nav>

      <FinanceNavGroup />
      <HrNavGroup />
      <AdminNavGroup />
    </aside>
  );
}

function DatabaseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <ellipse cx="12" cy="5" rx="9" ry="3"/>
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
    </svg>
  );
}

function ActivityIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
      <rect x="9" y="3" width="6" height="4" rx="2"/>
      <line x1="9" y1="12" x2="15" y2="12"/>
      <line x1="9" y1="16" x2="13" y2="16"/>
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  );
}

function CarIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="1" y="11" width="22" height="9" rx="2"/>
      <path d="M5 11V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4"/>
      <circle cx="7.5" cy="17.5" r="1.5"/>
      <circle cx="16.5" cy="17.5" r="1.5"/>
    </svg>
  );
}

function ReceiptIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 2v20l3-2 2 2 2-2 2 2 2-2 3 2V2z"/>
      <line x1="9" y1="9" x2="15" y2="9"/>
      <line x1="9" y1="13" x2="15" y2="13"/>
      <line x1="9" y1="17" x2="12" y2="17"/>
    </svg>
  );
}

function RouteIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="6" cy="19" r="3"/>
      <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/>
      <circle cx="18" cy="5" r="3"/>
    </svg>
  );
}

function HrGroupIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
  );
}

function AdminGroupIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z"/>
    </svg>
  );
}
