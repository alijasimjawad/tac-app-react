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

const PencilIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </svg>
);

const TrashIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

// ── Component ──────────────────────────────────────────────────────────────────

export default function ProjectSelector() {
  const {
    projects, loading, selectedProjectId, selectedProject,
    setSelectedProjectId, createProject, renameProject, deleteProject,
  } = useProject();

  const [open,       setOpen]       = useState(false);
  const [adding,     setAdding]     = useState(false);
  const [newName,    setNewName]    = useState('');
  const [saving,     setSaving]     = useState(false);

  const [editingId,  setEditingId]  = useState<string | null>(null);
  const [editName,   setEditName]   = useState('');
  const [editSaving, setEditSaving] = useState(false);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting,        setDeleting]        = useState(false);

  const wrapRef  = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  function resetRowState() {
    setEditingId(null);
    setEditName('');
    setConfirmDeleteId(null);
  }

  // Outside-click to close — same pattern as NotificationBell.tsx
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setAdding(false);
        setNewName('');
        resetRowState();
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  useEffect(() => {
    if (editingId) editInputRef.current?.focus();
  }, [editingId]);

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

  function startEdit(e: React.MouseEvent, id: string, currentName: string) {
    e.stopPropagation();
    setConfirmDeleteId(null);
    setEditingId(id);
    setEditName(currentName);
  }

  async function handleRename() {
    if (!editingId || editSaving) return;
    const name = editName.trim();
    if (!name) return;
    setEditSaving(true);
    const ok = await renameProject(editingId, name);
    setEditSaving(false);
    if (ok) resetRowState();
  }

  function startDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    setEditingId(null);
    setConfirmDeleteId(id);
  }

  async function handleDelete(id: string) {
    if (deleting) return;
    setDeleting(true);
    const ok = await deleteProject(id);
    setDeleting(false);
    if (ok) resetRowState();
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

              if (editingId === p.id) {
                return (
                  <div key={p.id} className={styles.editRow}>
                    <input
                      ref={editInputRef}
                      type="text"
                      className={styles.addInput}
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') void handleRename();
                        if (e.key === 'Escape') resetRowState();
                      }}
                      disabled={editSaving}
                    />
                    <button type="button" className={styles.addSaveBtn} onClick={() => void handleRename()} disabled={editSaving || !editName.trim()}>
                      {editSaving ? '…' : 'Save'}
                    </button>
                    <button type="button" className={styles.cancelBtn} onClick={resetRowState} disabled={editSaving}>
                      Cancel
                    </button>
                  </div>
                );
              }

              if (confirmDeleteId === p.id) {
                return (
                  <div key={p.id} className={styles.deleteConfirmRow}>
                    <span className={styles.deleteConfirmText}>
                      Delete "{p.name}"? Its site data stays but won't be tied to any project.
                    </span>
                    <div className={styles.deleteConfirmActions}>
                      <button type="button" className={styles.cancelBtn} onClick={resetRowState} disabled={deleting}>
                        Cancel
                      </button>
                      <button type="button" className={styles.dangerBtn} onClick={() => void handleDelete(p.id)} disabled={deleting}>
                        {deleting ? '…' : 'Delete'}
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div key={p.id} className={`${styles.item} ${isSelected ? styles.itemSelected : ''}`}>
                  <button
                    type="button"
                    role="listitem"
                    className={styles.itemMain}
                    onClick={() => { setSelectedProjectId(p.id); setOpen(false); }}
                  >
                    <span className={styles.itemCheck}>{isSelected && <CheckIcon />}</span>
                    <span className={styles.itemName}>{p.name}</span>
                    {p.is_current && <span className={styles.currentBadge}>current</span>}
                  </button>
                  <span className={styles.itemActions}>
                    <button type="button" className={styles.iconBtn} onClick={e => startEdit(e, p.id, p.name)} aria-label={`Rename ${p.name}`} title="Rename">
                      <PencilIcon />
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={e => startDelete(e, p.id)}
                      aria-label={`Delete ${p.name}`}
                      title={projects.length <= 1 ? "Can't delete the only project" : 'Delete'}
                      disabled={projects.length <= 1}
                    >
                      <TrashIcon />
                    </button>
                  </span>
                </div>
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
