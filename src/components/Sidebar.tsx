import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { logActivity } from '../lib/activityLog';
import { sendPushToRoles } from '../lib/pushNotify';
import i18n from '../lib/i18n';
import styles from './Sidebar.module.css';
import tacLogoLight from '../assets/tac-logo-light.png';
import { SiteLookupIcon } from '../pages/SiteLookup';
import { ProfileIcon } from '../pages/MyProfile';
import { MySitesIcon } from '../pages/MySites';
import { FinanceIcon } from '../pages/FinTeam';
import { PROJ_NAMES, SEC_LABELS } from '../pages/NetworkScopes';
import { ensureSectionsLoaded, getSections, invalidateSections } from '../lib/sectionsCache';
import type { SectionMeta } from '../lib/sectionsCache';
import { ensureProjectsLoaded, getProjectKeys } from '../lib/projectsCache';
import { VIEW_CORE, VIEW_DAILY_WORK, VIEW_FINANCE, VIEW_HR, VIEW_ADMIN } from '../lib/permissionsCatalog';


const DEFAULT_SECTIONS: Record<string, string[]> = {
  zain:   ['ftk', 'tdd', 'addsector'],
  nokia:  ['ftk', 'tdd', 'addsector'],
  huawei: ['ftk', 'tdd', 'addsector'],
  ipt:    ['tdd'],
  moj:    ['ftk', 'tdd', 'addsector'],
};

const DEFAULT_HEADERS = ['Site ID', 'Governate', 'Delivery', 'Installation', 'Integration Status', 'ATP Status', 'Clearance & Tools', 'Final ATP'];

type MajorGroup = 'finance' | 'hr' | 'admin';

function getActiveGroupFromPath(pathname: string): MajorGroup | null {
  if (pathname.startsWith('/finance')) return 'finance';
  if (pathname === '/hr-profiles' || pathname === '/attendance-admin') return 'hr';
  if (
    pathname === '/live-trips' ||
    pathname === '/activity-log' ||
    pathname === '/user-management' ||
    pathname === '/backup-restore'
  ) return 'admin';
  return null;
}

// ── Collapse icon ─────────────────────────────────────────────────────────────

function CollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {collapsed ? (
        <>
          <path d="M13 17l5-5-5-5"/>
          <path d="M6 17l5-5-5-5"/>
        </>
      ) : (
        <>
          <path d="M11 17l-5-5 5-5"/>
          <path d="M18 17l-5-5 5-5"/>
        </>
      )}
    </svg>
  );
}

// ── Network Scopes sidebar tree ───────────────────────────────────────────────

function NetworkScopesTree() {
  const { hasPerm, currentUser } = useAuth();
  const { t } = useTranslation();
  const params = useParams<{ proj?: string; sec?: string }>();
  const navigate = useNavigate();
  const [sections, setSections] = useState<SectionMeta[]>([]);
  const [PROJECTS, setProjects] = useState<string[]>([]);

  useEffect(() => {
    ensureProjectsLoaded().then(() => setProjects(getProjectKeys()));
  }, []);

  // Accordion: only one project open at a time. Initialize from params (current route) or localStorage.
  const [openProj, setOpenProj] = useState<string | null>(() => {
    return params.proj ?? localStorage.getItem('sb_open_proj');
  });

  // Persist ns-section collapsed state across refreshes.
  const [nsCollapsed, setNsCollapsed] = useState(() => {
    return localStorage.getItem('sb_ns_collapsed') === 'true';
  });

  // Section management state
  const [addSecState, setAddSecState]       = useState<{ proj: string; name: string } | null>(null);
  const [renameSecState, setRenameSecState] = useState<{ proj: string; secId: string; sectionKey: string; name: string } | null>(null);
  const [deleteSecState, setDeleteSecState] = useState<{
    proj: string; secId: string; key: string; label: string; isCustom: boolean; typed: string;
  } | null>(null);
  const [secMenu, setSecMenu]         = useState<{ proj: string; key: string } | null>(null);
  const [secModalSaving, setSecModalSaving] = useState(false);
  const [secError, setSecError]       = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([ensureSectionsLoaded(), ensureProjectsLoaded()]).then(async () => {
      setSections(getSections());
      // Seed any default sections that don't yet have a DB row (e.g. newly added projects).
      const existing = getSections();
      const toInsert = getProjectKeys().flatMap(proj =>
        (DEFAULT_SECTIONS[proj] ?? [])
          .filter(key => !existing.some(s => s.project_name === proj && s.section_name === key))
          .map(key => ({
            project_name: proj,
            section_name: key,
            section_label: SEC_LABELS[key] ?? key,
            columns: DEFAULT_HEADERS,
            custom_columns: [] as string[],
            is_custom: false,
          }))
      );
      if (toInsert.length > 0) {
        await supabase.from('sections').insert(toInsert);
        invalidateSections();
        await ensureSectionsLoaded();
        setSections(getSections());
      }
    });
  }, []);

  // Auto-expand the active project when route changes.
  useEffect(() => {
    if (params.proj) setOpenProj(params.proj);
  }, [params.proj]);

  // Persist openProj to localStorage.
  useEffect(() => {
    if (openProj) localStorage.setItem('sb_open_proj', openProj);
    else localStorage.removeItem('sb_open_proj');
  }, [openProj]);

  // Persist nsCollapsed to localStorage.
  useEffect(() => {
    localStorage.setItem('sb_ns_collapsed', nsCollapsed ? 'true' : 'false');
  }, [nsCollapsed]);

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

  // Accordion: clicking an open project closes it (unless it's active); clicking a closed project opens it.
  function toggleProj(proj: string) {
    setOpenProj(prev => {
      if (prev === proj) {
        return params.proj === proj ? proj : null; // keep active project open
      }
      return proj;
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
    if (!name) { setSecError(t('sidebar_nameEmpty')); return; }
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
    void sendPushToRoles(['admin', 'engineer'], 'New Section Added', `${name} added to ${PROJ_NAMES[savedProj] || savedProj}`);
    logActivity({
      userFullName: currentUser?.full_name ?? currentUser?.username,
      action: 'Added Section',
      projectName: PROJ_NAMES[savedProj] || savedProj,
      sectionName: name,
      details: `New section: ${name} added to ${PROJ_NAMES[savedProj] || savedProj}`,
    });
  }

  async function ensureDefaultSectionRow(proj: string, sectionKey: string): Promise<string | null> {
    const { data, error } = await supabase.from('sections').insert({
      project_name: proj,
      section_name: sectionKey,
      section_label: SEC_LABELS[sectionKey] ?? sectionKey,
      columns: DEFAULT_HEADERS,
      custom_columns: [],
      is_custom: false,
    }).select('id').single();
    if (error || !data) return null;
    return (data as { id: string }).id;
  }

  async function confirmRenameSection() {
    if (!renameSecState) return;
    const label = renameSecState.name.trim();
    if (!label) { setSecError(t('sidebar_nameEmpty')); return; }
    setSecModalSaving(true);
    setSecError(null);
    let secId = renameSecState.secId;
    if (!secId) {
      const newId = await ensureDefaultSectionRow(renameSecState.proj, renameSecState.sectionKey);
      if (!newId) { setSecError('Failed to initialize section. Please try again.'); setSecModalSaving(false); return; }
      secId = newId;
    }
    const { error } = await supabase.from('sections')
      .update({ section_label: label })
      .eq('id', secId);
    setSecModalSaving(false);
    if (error) { setSecError(error.message); return; }
    await reloadSections();
    logActivity({
      userFullName: currentUser?.full_name ?? currentUser?.username,
      action: 'Renamed Section',
      projectName: PROJ_NAMES[renameSecState.proj] || renameSecState.proj,
      sectionName: label,
      details: `Renamed section to: "${label}"`,
    });
    setRenameSecState(null);
  }

  async function confirmDeleteSection() {
    if (!deleteSecState) return;
    if (deleteSecState.typed.toLowerCase() !== deleteSecState.label.toLowerCase()) {
      setSecError(t('sidebar_nameNoMatch'));
      return;
    }
    setSecModalSaving(true);
    setSecError(null);
    let saveErr: { message: string } | null = null;
    let secId = deleteSecState.secId;
    if (deleteSecState.isCustom) {
      const res = await supabase.from('sections').delete().eq('id', secId);
      saveErr = res.error;
    } else if (!secId) {
      // Default section with no DB row yet — insert it directly as deleted
      const res = await supabase.from('sections').insert({
        project_name: deleteSecState.proj,
        section_name: deleteSecState.key,
        section_label: deleteSecState.label,
        columns: DEFAULT_HEADERS,
        custom_columns: [],
        is_custom: false,
        is_deleted: true,
      });
      saveErr = res.error;
    } else {
      const res = await supabase.from('sections').update({ is_deleted: true }).eq('id', secId);
      saveErr = res.error;
    }
    setSecModalSaving(false);
    if (saveErr) { setSecError(saveErr.message); return; }
    if (params.proj === deleteSecState.proj && params.sec === deleteSecState.key) {
      navigate('/network-scopes');
    }
    await reloadSections();
    logActivity({
      userFullName: currentUser?.full_name ?? currentUser?.username,
      action: 'Deleted Section',
      projectName: PROJ_NAMES[deleteSecState.proj] || deleteSecState.proj,
      sectionName: deleteSecState.label,
      details: `Section: ${deleteSecState.label} deleted from ${PROJ_NAMES[deleteSecState.proj] || deleteSecState.proj}`,
    });
    setDeleteSecState(null);
  }

  const visibleProjects = PROJECTS.filter(p => hasPerm(`view_${p}`));
  if (visibleProjects.length === 0) return null;

  const canManageSec = hasPerm('sdb_rename_section') || hasPerm('sdb_delete_section');

  return (
    <div className={styles.nsSection}>
      <div className={styles.nsSectionHdr} onClick={() => setNsCollapsed(v => !v)}>
        <div className={styles.nsHdrLeft}>
          <GridTableIcon />
          <span>{t('sidebar_networkScopes')}</span>
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
            const secs   = getSectionsForProj(proj);
            const isOpen = openProj === proj;
            return (
              <div key={proj}>
                {pi > 0 && <div className={styles.nsDivider} />}
                <div className={styles.projGroup}>
                  <div className={styles.projHeader} onClick={() => toggleProj(proj)}>
                    <ProjIcon proj={proj} />
                    <span className={styles.projName}>{PROJ_NAMES[proj]}</span>
                    <span className={styles.projBadge}>{secs.length}</span>
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
                        const showMenu = canManageSec;
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
                                  title={t('sidebar_sectionOptions')}
                                >
                                  ⋮
                                </button>
                                {menuOpen && (
                                  <div ref={menuRef} className={styles.secMenuDropdown} onClick={e => e.stopPropagation()}>
                                    {hasPerm('sdb_rename_section') && (
                                      <button
                                        className={styles.secMenuItem}
                                        onClick={() => {
                                          setSecMenu(null);
                                          setSecError(null);
                                          setRenameSecState({ proj, secId: id, sectionKey: key, name: label });
                                        }}
                                      >
                                        {t('sidebar_rename')}
                                      </button>
                                    )}
                                    {hasPerm('sdb_delete_section') && (
                                      <button
                                        className={`${styles.secMenuItem} ${styles.secMenuItemDanger}`}
                                        onClick={() => {
                                          setSecMenu(null);
                                          setSecError(null);
                                          setDeleteSecState({ proj, secId: id, key, label, isCustom, typed: '' });
                                        }}
                                      >
                                        {t('sidebar_delete')}
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {hasPerm('sdb_add_section') && (
                        <button
                          className={styles.addSecBtn}
                          onClick={() => { setSecError(null); setAddSecState({ proj, name: '' }); }}
                        >
                          {t('sidebar_addSection')}
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
            <div className={styles.secModalTitle}>{t('sidebar_addSection')} — {PROJ_NAMES[addSecState.proj]}</div>
            <div className={styles.secModalDesc}>
              {t('sidebar_newSectionDesc')}
            </div>
            <input
              className={styles.secModalInput}
              placeholder={t('sidebar_sectionPh')}
              value={addSecState.name}
              autoFocus
              onChange={e => setAddSecState(s => s ? { ...s, name: e.target.value } : null)}
              onKeyDown={e => e.key === 'Enter' && confirmAddSection()}
            />
            {secError && <div className={styles.secModalError}>{secError}</div>}
            <div className={styles.secModalActions}>
              <button className={styles.sbBtnGreen} disabled={secModalSaving} onClick={confirmAddSection}>
                {secModalSaving ? t('sidebar_creating') : t('sidebar_createSection')}
              </button>
              <button className={styles.sbBtnGhost} disabled={secModalSaving} onClick={() => setAddSecState(null)}>
                {t('sidebar_cancel')}
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
            <div className={styles.secModalTitle}>{t('sidebar_renameSection')}</div>
            <input
              className={styles.secModalInput}
              placeholder={t('sidebar_sectionPh')}
              value={renameSecState.name}
              autoFocus
              onChange={e => setRenameSecState(s => s ? { ...s, name: e.target.value } : null)}
              onKeyDown={e => e.key === 'Enter' && confirmRenameSection()}
            />
            {secError && <div className={styles.secModalError}>{secError}</div>}
            <div className={styles.secModalActions}>
              <button className={styles.sbBtnGreen} disabled={secModalSaving} onClick={confirmRenameSection}>
                {secModalSaving ? t('sidebar_saving') : t('sidebar_rename')}
              </button>
              <button className={styles.sbBtnGhost} disabled={secModalSaving} onClick={() => setRenameSecState(null)}>
                {t('sidebar_cancel')}
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
            <div className={styles.secModalTitle}>{t('sidebar_deleteSection')}</div>
            <div className={styles.secModalDesc}>
              Type <strong>{deleteSecState.label}</strong> to confirm.
              {' '}
              {deleteSecState.isCustom
                ? 'All rows will be permanently deleted and cannot be recovered.'
                : 'This section will be hidden. Contact an admin to restore it.'}
            </div>
            <input
              className={styles.secModalInput}
              placeholder={t('sidebar_deleteSectionDesc')}
              value={deleteSecState.typed}
              autoFocus
              onChange={e => setDeleteSecState(s => s ? { ...s, typed: e.target.value } : null)}
              onKeyDown={e => e.key === 'Enter' && confirmDeleteSection()}
            />
            {secError && <div className={styles.secModalError}>{secError}</div>}
            <div className={styles.secModalActions}>
              <button className={styles.sbBtnDanger} disabled={secModalSaving} onClick={confirmDeleteSection}>
                {secModalSaving ? t('sidebar_deleting') : t('sidebar_deleteSection')}
              </button>
              <button className={styles.sbBtnGhost} disabled={secModalSaving} onClick={() => setDeleteSecState(null)}>
                {t('sidebar_cancel')}
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

interface NavGroupProps {
  isExpanded: boolean;
  onToggle: () => void;
}

function FinanceNavGroup({ isExpanded, onToggle }: NavGroupProps) {
  const { hasPerm } = useAuth();
  const { t } = useTranslation();

  const FIN_LINKS = VIEW_FINANCE.filter(({ key }) => hasPerm(key));

  if (FIN_LINKS.length === 0) return null;

  return (
    <div className={styles.nsSection}>
      <div className={styles.nsSectionHdr} onClick={onToggle}>
        <div className={styles.nsHdrLeft}>
          <FinanceIcon />
          <span>{t('sidebar_finance')}</span>
        </div>
        <svg
          className={`${styles.nsChevron} ${isExpanded ? '' : styles.nsChevronClosed}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          width="12" height="12"
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>
      {isExpanded && (
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

// ── HR nav group ──────────────────────────────────────────────────────────────

function HrNavGroup({ isExpanded, onToggle }: NavGroupProps) {
  const { hasPerm } = useAuth();
  const { t } = useTranslation();

  const HR_LINKS = [
    ...VIEW_HR.filter(({ key }) => hasPerm(key)),
  ];

  if (HR_LINKS.length === 0) return null;

  return (
    <div className={styles.nsSection}>
      <div className={styles.nsSectionHdr} onClick={onToggle}>
        <div className={styles.nsHdrLeft}>
          <HrGroupIcon />
          <span>{t('sidebar_hr')}</span>
        </div>
        <svg
          className={`${styles.nsChevron} ${isExpanded ? '' : styles.nsChevronClosed}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          width="12" height="12"
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>
      {isExpanded && (
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

function AdminNavGroup({ isExpanded, onToggle }: NavGroupProps) {
  const { currentUser, hasPerm } = useAuth();
  const { t } = useTranslation();
  const isAdmin = currentUser?.role === 'admin';

  const ADMIN_LINKS = [
    ...VIEW_ADMIN.filter(({ key }) => hasPerm(key)),
    ...(isAdmin ? [{ key: 'user_management', to: '/user-management', label: 'User Management' }] : []),
    ...(isAdmin ? [{ key: 'backup_restore', to: '/backup-restore', label: 'Backup & Restore' }] : []),
  ];

  if (ADMIN_LINKS.length === 0) return null;

  return (
    <div className={styles.nsSection}>
      <div className={styles.nsSectionHdr} onClick={onToggle}>
        <div className={styles.nsHdrLeft}>
          <AdminGroupIcon />
          <span>{t('sidebar_admin')}</span>
        </div>
        <svg
          className={`${styles.nsChevron} ${isExpanded ? '' : styles.nsChevronClosed}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          width="12" height="12"
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>
      {isExpanded && (
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

// ── Field-role nav ────────────────────────────────────────────────────────────

function LangToggle({ roleLower }: { roleLower: string | undefined }) {
  const { t, i18n: i18nInst } = useTranslation();
  const [lang, setLang] = useState(i18nInst.language === 'ar' ? 'ar' : 'en');

  // Keep local state in sync when language changes externally
  useEffect(() => {
    function onChanged(lng: string) { setLang(lng === 'ar' ? 'ar' : 'en'); }
    i18nInst.on('languageChanged', onChanged);
    return () => { i18nInst.off('languageChanged', onChanged); };
  }, [i18nInst]);

  if (roleLower !== 'technician') return null;

  function toggle() {
    const next = lang === 'en' ? 'ar' : 'en';
    setLang(next);
    i18n.changeLanguage(next);
    localStorage.setItem('tac_lang', next);
  }

  return (
    <button
      className={styles.langToggle}
      onClick={toggle}
      title={t('nav_myProfile')}
      aria-label="Toggle language"
    >
      <span style={{ opacity: lang === 'en' ? 1 : 0.45, fontWeight: lang === 'en' ? 700 : 400 }}>EN</span>
      <span style={{ margin: '0 4px', opacity: 0.35 }}>|</span>
      <span style={{ opacity: lang === 'ar' ? 1 : 0.45, fontWeight: lang === 'ar' ? 700 : 400 }}>AR</span>
    </button>
  );
}

function FieldRoleNav({ expandedGroup, toggleGroup, roleLower }: { expandedGroup: MajorGroup | null; toggleGroup: (group: MajorGroup) => void; roleLower: string | undefined }) {
  const { hasPerm } = useAuth();
  const { t } = useTranslation();
  const dashboardDef     = VIEW_CORE.find(d => d.key === 'view_dashboard')!;
  const dailyActivityDef = VIEW_DAILY_WORK.find(d => d.key === 'view_daily_activities')!;
  const siteLookupDef    = VIEW_DAILY_WORK.find(d => d.key === 'view_site_lookup')!;
  const routePlannerDef  = VIEW_DAILY_WORK.find(d => d.key === 'view_route_planner')!;
  const sitesDbDef       = VIEW_DAILY_WORK.find(d => d.key === 'view_sites_db')!;
  const myAttendanceDef  = VIEW_DAILY_WORK.find(d => d.key === 'view_my_attendance')!;
  const myTripsDef       = VIEW_DAILY_WORK.find(d => d.key === 'view_my_trips')!;

  return (
    <nav className={styles.nav} aria-label="Field navigation">
      <NavLink to="/my-work" className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}>
        <MyWorkIcon />
        <span className={styles.navLabel}>{t('nav_myWork')}</span>
      </NavLink>

      {hasPerm(dashboardDef.key) && (
        <NavLink to={dashboardDef.to} className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}>
          <GridIcon />
          <span className={styles.navLabel}>{t('nav_dashboard')}</span>
        </NavLink>
      )}

      <div className={styles.fieldNavLabel}>{t('nav_workLabel')}</div>

      {hasPerm(dailyActivityDef.key) && (
        <NavLink to="/daily-activities" className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}>
          <ActivityIcon />
          <span className={styles.navLabel}>{t('nav_dailyActivities')}</span>
        </NavLink>
      )}
      {hasPerm(myAttendanceDef.key) && (
        <NavLink to="/attendance" className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}>
          <ClockIcon />
          <span className={styles.navLabel}>{t('nav_myAttendance')}</span>
        </NavLink>
      )}
      {hasPerm(myTripsDef.key) && (
        <NavLink to="/my-trips" className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}>
          <CarIcon />
          <span className={styles.navLabel}>{t('nav_myTrips')}</span>
        </NavLink>
      )}
      {hasPerm(siteLookupDef.key) && (
        <NavLink to={siteLookupDef.to} className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}>
          <SiteLookupIcon />
          <span className={styles.navLabel}>{t('nav_siteLookup')}</span>
        </NavLink>
      )}
      {hasPerm(routePlannerDef.key) && (
        <NavLink to={routePlannerDef.to} className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}>
          <RouteIcon />
          <span className={styles.navLabel}>{t('nav_routePlanner')}</span>
        </NavLink>
      )}

      <div className={styles.fieldNavLabel}>{t('nav_sitesLabel')}</div>

      {hasPerm(sitesDbDef.key) && (
        <NavLink to={sitesDbDef.to} className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}>
          <DatabaseIcon />
          <span className={styles.navLabel}>{t('nav_networkScopes')}</span>
        </NavLink>
      )}
      <NavLink to="/my-sites" className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}>
        <MySitesIcon />
        <span className={styles.navLabel}>{t('nav_mySites')}</span>
      </NavLink>

      <NetworkScopesTree />

      <div className={styles.fieldNavLabel}>{t('nav_financeLabel')}</div>

      <NavLink to="/my-expenses" className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}>
        <ReceiptIcon />
        <span className={styles.navLabel}>{t('nav_myExpenses')}</span>
      </NavLink>

      {/* Finance/HR/Admin sub-page permissions (e.g. Revenue, Employee
          Profiles, Activity Log, Live Trips, Attendance) are granted
          per-user like any other permission and must reflect here too —
          these groups already self-hide (return null) when the user has
          none of their perms. Only User Management and Backup & Restore
          stay hardcoded admin-only (too high-risk to grant piecemeal), so
          mounting these groups for field roles only ever exposes what was
          actually granted. */}
      <FinanceNavGroup isExpanded={expandedGroup === 'finance'} onToggle={() => toggleGroup('finance')} />
      <HrNavGroup isExpanded={expandedGroup === 'hr'} onToggle={() => toggleGroup('hr')} />
      <AdminNavGroup isExpanded={expandedGroup === 'admin'} onToggle={() => toggleGroup('admin')} />

      <div className={styles.fieldNavLabel}>{t('nav_accountLabel')}</div>

      <NavLink to="/my-profile" className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}>
        <ProfileIcon />
        <span className={styles.navLabel}>{t('nav_myProfile')}</span>
      </NavLink>

      <LangToggle roleLower={roleLower} />
    </nav>
  );
}

// ── Main Sidebar ──────────────────────────────────────────────────────────────

interface SidebarProps {
  mobileOpen: boolean;
  onMobileClose: () => void;
}

export default function Sidebar({ mobileOpen, onMobileClose }: SidebarProps) {
  const { hasPerm, currentUser, logout } = useAuth();
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);

  async function handleSignOut() {
    onMobileClose();
    await logout();
    navigate('/login');
  }

  // Accordion state for Finance / HR / Admin: only one open at a time.
  // Initialize from active route first, then localStorage.
  const [expandedGroup, setExpandedGroup] = useState<MajorGroup | null>(() => {
    const activeGroup = getActiveGroupFromPath(location.pathname);
    if (activeGroup) return activeGroup;
    return localStorage.getItem('sb_expanded_group') as MajorGroup | null;
  });

  // Auto-expand the group containing the active route.
  useEffect(() => {
    const group = getActiveGroupFromPath(location.pathname);
    if (group) setExpandedGroup(group);
  }, [location.pathname]);

  // Persist expandedGroup to localStorage.
  useEffect(() => {
    if (expandedGroup) localStorage.setItem('sb_expanded_group', expandedGroup);
    else localStorage.removeItem('sb_expanded_group');
  }, [expandedGroup]);

  function toggleGroup(group: MajorGroup) {
    const activeGroup = getActiveGroupFromPath(location.pathname);
    setExpandedGroup(prev => {
      if (prev === group) {
        // Don't collapse the group you're actively navigating within.
        return activeGroup === group ? group : null;
      }
      return group;
    });
  }

  // Dashboard (analytics): unconditionally visible for admin/user roles
  // (unchanged from before), but for Engineer/Technician it now follows the
  // real per-user permission toggle in User Management — an admin can grant
  // a specific field-role user access to it, same as Sites DB/My Trips/etc.
  // Previously this was hardcoded hidden for field roles no matter what the
  // toggle said, which is why granting it from User Management had no effect.
  const roleLower = currentUser?.role?.toLowerCase();
  const isFieldRole = roleLower === 'engineer' || roleLower === 'technician';

  // Reset to English for non-technician roles so AR never leaks to Finance/HR/Admin
  useEffect(() => {
    if (roleLower && roleLower !== 'technician' && i18n.language !== 'en') {
      i18n.changeLanguage('en');
      localStorage.removeItem('tac_lang');
    }
  }, [roleLower]);

  const dashboardDef      = VIEW_CORE.find(d => d.key === 'view_dashboard')!;
  const dailyActivityDef  = VIEW_DAILY_WORK.find(d => d.key === 'view_daily_activities')!;
  const siteLookupDef     = VIEW_DAILY_WORK.find(d => d.key === 'view_site_lookup')!;
  const routePlannerDef   = VIEW_DAILY_WORK.find(d => d.key === 'view_route_planner')!;
  const sitesDbDef        = VIEW_DAILY_WORK.find(d => d.key === 'view_sites_db')!;
  const myAttendanceDef   = VIEW_DAILY_WORK.find(d => d.key === 'view_my_attendance')!;
  const myTripsDef        = VIEW_DAILY_WORK.find(d => d.key === 'view_my_trips')!;

  const NAV_TOP = [
    ...(!isFieldRole || hasPerm(dashboardDef.key) ? [{ to: dashboardDef.to, label: dashboardDef.label, icon: GridIcon }] : []),
  ];

  // Daily Activities / Sites DB / My Attendance / My Trips are now real,
  // per-user permission toggles (see User Management → Permissions → Daily
  // Work). Engineers/technicians keep default access to Sites DB, My
  // Attendance, and My Trips via FIELD_ROLE_DEFAULT_KEYS; Daily Activities
  // stays off by default for everyone until an admin grants it. My Profile
  // and My Expenses are intentionally left unconditional here (self-service
  // pages), matching prior behavior.
  //
  // Split into two groups (each with its own section label below) instead
  // of one flat list: work/data tools first, then personal/self-service
  // pages together under "My Space" — mirrors the WORK/SITES/ACCOUNT labels
  // FieldRoleNav already uses, so office and field roles share the same
  // grouping convention.
  const NAV_TOOLS = [
    ...(hasPerm(dailyActivityDef.key) ? [{ to: dailyActivityDef.to, label: dailyActivityDef.label, icon: ActivityIcon }] : []),
    ...(hasPerm(siteLookupDef.key)    ? [{ to: siteLookupDef.to,    label: siteLookupDef.label,    icon: SiteLookupIcon }] : []),
    ...(hasPerm(routePlannerDef.key)  ? [{ to: routePlannerDef.to,  label: routePlannerDef.label,  icon: RouteIcon }]      : []),
    ...(hasPerm(sitesDbDef.key)       ? [{ to: sitesDbDef.to,       label: sitesDbDef.label,       icon: DatabaseIcon }]   : []),
  ];

  const NAV_PERSONAL = [
    { to: '/my-profile',  label: t('nav_myProfile'),  icon: ProfileIcon },
    ...(hasPerm(myAttendanceDef.key)  ? [{ to: myAttendanceDef.to,  label: myAttendanceDef.label,  icon: ClockIcon }]      : []),
    ...(hasPerm(myTripsDef.key)       ? [{ to: myTripsDef.to,       label: myTripsDef.label,       icon: CarIcon }]        : []),
    { to: '/my-expenses', label: t('nav_myExpenses'), icon: ReceiptIcon },
  ];

  const navLinks = (items: typeof NAV_TOP) => items.map(({ to, label, icon: Icon }) => (
    <NavLink
      key={to}
      to={to}
      title={collapsed ? label : undefined}
      className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}
    >
      <Icon />
      <span className={styles.navLabel}>{label}</span>
    </NavLink>
  ));

  return (
    <>
      {mobileOpen && (
        <div className={styles.mobileBackdrop} onClick={onMobileClose} aria-hidden="true" />
      )}

      <aside
        className={[
          styles.sidebar,
          collapsed ? styles.sidebarCollapsed : '',
          mobileOpen ? styles.mobileOpen : '',
        ].join(' ')}
        aria-label="Main navigation"
      >
        <div className={styles.brand}>
          <div className={styles.brandIcon}>T</div>
          <img src={tacLogoLight} alt="TAC Network" className={styles.brandLogoImg} />
          <div className={styles.brandText}>
            <div className={styles.brandName}>TAC Network</div>
            <div className={styles.brandSub}>Telecom Mgmt</div>
          </div>
          <button
            className={styles.collapseBtn}
            onClick={() => setCollapsed(v => !v)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <CollapseIcon collapsed={collapsed} />
          </button>
        </div>

        {isFieldRole ? (
          <FieldRoleNav expandedGroup={expandedGroup} toggleGroup={toggleGroup} roleLower={roleLower} />
        ) : (
          <>
            <nav className={styles.nav} aria-label="Main">
              {navLinks(NAV_TOP)}
            </nav>

            <NetworkScopesTree />

            <nav className={styles.nav} aria-label="Tools">
              {NAV_TOOLS.length > 0 && <div className={styles.fieldNavLabel}>{t('sidebar_workTools')}</div>}
              {navLinks(NAV_TOOLS)}

              <div className={styles.fieldNavLabel}>{t('sidebar_mySpace')}</div>
              {navLinks(NAV_PERSONAL)}
            </nav>

            <FinanceNavGroup
              isExpanded={expandedGroup === 'finance'}
              onToggle={() => toggleGroup('finance')}
            />
            <HrNavGroup
              isExpanded={expandedGroup === 'hr'}
              onToggle={() => toggleGroup('hr')}
            />
            <AdminNavGroup
              isExpanded={expandedGroup === 'admin'}
              onToggle={() => toggleGroup('admin')}
            />
          </>
        )}

        {/* Mobile-only: the topbar's "Sign out" button is hidden on small
            screens to reduce crowding (hamburger/title/bell/avatar already
            fill that row) — sign out lives here instead, inside the drawer. */}
        <div className={styles.mobileFooter}>
          <div className={styles.mobileFooterUser}>
            <div className={styles.mobileFooterName}>{currentUser?.full_name || currentUser?.username}</div>
            <div className={styles.mobileFooterRole}>{currentUser?.role}</div>
          </div>
          <button className={styles.mobileSignOutBtn} onClick={handleSignOut} title="Sign out">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span className={styles.mobileSignOutLabel}>{t('sidebar_signOut')}</span>
          </button>
        </div>
      </aside>
    </>
  );
}

function MyWorkIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" rx="1"/>
      <rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="14" y="14" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/>
    </svg>
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
