import { useEffect, useRef, useState } from 'react';
import { useProject } from '../context/ProjectContext';
import styles from './ProjectSelector.module.css';

// ── SVG primitives ─────────────────────────────────────────────────────────────

const FolderIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

const ChevronDownIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

const CheckIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const PlusIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

// ── Component ──────────────────────────────────────────────────────────────────

export default function ProjectSelector() {
  const { projects, loading, selectedProjectId, selectedProject, setSelectedProjectId, createProject } = useProject();

  const [open,       setOpen]       = useState(false);
  const [adding,     setAdding]     = useState(false);
  const [newName,    setNewName]    = useState('');
  const [saving,     setSaving]     = useState(false);

  const wrapRef  = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Outside-click to close — same pattern as NotificationBell.tsx
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setAdding(false);
        setNewName('');
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  if (loading && projects.length === 0) return null; // nothing to pick yet

  async function handleCreate() {
    const name = newName.trim();
    if (!name || saving) return;
    setSaving(true);
    const created = await createProject(name);
    setSaving(false);
    if (created) {
      setAdding(false);
      setNewName('');
      setOpen(false);
    }
  }

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(v => !v)}
        aria-label="Select project"
        aria-expanded={open}
        aria-haspopup="true"
        title="Select project"
      >
        <FolderIcon />
        <span className={styles.triggerLabel}>{selectedProject?.name || 'Select project'}</span>
        <ChevronDownIcon />
      </button>

      {open && (
        <div className={styles.dropdown} role="dialog" aria-label="Projects panel">
          <div className={styles.dropHeader}>
            <span className={styles.dropTitle}>Projects</span>
          </div>

          <div className={styles.list} role="list">
            {projects.length === 0 ? (
              <div className={styles.empty}>No projects yet</div>
            ) : projects.map(p => {
              const isSelected = p.id === selectedProjectId;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="listitem"
                  className={`${styles.item} ${isSelected ? styles.itemSelected : ''}`}
                  onClick={() => { setSelectedProjectId(p.id); setOpen(false); }}
                >
                  <span className={styles.itemCheck}>{isSelected && <CheckIcon />}</span>
                  <span className={styles.itemName}>{p.name}</span>
                  {p.is_current && <span className={styles.currentBadge}>current</span>}
                </button>
              );
            })}
          </div>

          <div className={styles.footer}>
            {adding ? (
              <div className={styles.addRow}>
                <input
                  ref={inputRef}
                  type="text"
                  className={styles.addInput}
                  placeholder="e.g. Capex27"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void handleCreate();
                    if (e.key === 'Escape') { setAdding(false); setNewName(''); }
                  }}
                  disabled={saving}
                />
                <button type="button" className={styles.addSaveBtn} onClick={() => void handleCreate()} disabled={saving || !newName.trim()}>
                  {saving ? '…' : 'Add'}
                </button>
              </div>
            ) : (
              <button type="button" className={styles.manageLink} onClick={() => setAdding(true)}>
                <PlusIcon />
                Manage projects / New
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
