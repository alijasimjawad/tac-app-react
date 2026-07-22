import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import styles from './MyExpenses.module.css';

const FIN_PROJECTS = ['Zain Project', 'Nokia Project', 'Huawei Project', 'IPT Project', 'General'];

const QUICK_CATEGORIES = [
  'Accommodation', 'Fuel', 'Tools & Materials', 'Communication', 'Parking',
  'Refreshments', 'Equipment Rental', 'Other',
];

interface ExpenseClaim {
  id: string;
  member_id: string;
  activity_date: string;
  submitted_at: string;
  project_name: string | null;
  site_id: string | null;
  description: string | null;
  transport_amount: number | null;
  food_amount: number | null;
  extra_categories: ExtraRow[] | null; // jsonb — already parsed by Supabase client
  employee_ids: string[] | null;       // jsonb — already parsed by Supabase client
  notes: string | null;
  status: string;
  total_amount: number | null;
  rejection_reason: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

interface ExtraRow {
  category: string;
  amount: number | string;
}

interface TeamMember {
  id: string;
  full_name: string;
  username: string;
  is_active: boolean | null;
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function fmtDate(iso: string) {
  const [yr, mo, dy] = iso.split('-');
  return `${dy}/${mo}/${yr}`;
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtAmt(n: number | null | undefined) {
  return (n ?? 0).toLocaleString('en-US');
}

function parseExtra(raw: ExtraRow[] | null): ExtraRow[] {
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [];
}

function parseEmployeeIds(raw: string[] | null): string[] {
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [];
}

export default function MyExpenses() {
  const { currentUser, hasPerm } = useAuth();
  const [memberId, setMemberId] = useState<string | null>(null);
  const [memberResolved, setMemberResolved] = useState(false);
  const [claims, setClaims] = useState<ExpenseClaim[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // ── modal state ──
  const [modalOpen, setModalOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  // form fields
  const [fProject, setFProject] = useState('');
  const [fSiteId, setFSiteId] = useState('');
  const [fDesc, setFDesc] = useState('');
  const [fDate, setFDate] = useState(today());
  const [fTransport, setFTransport] = useState<string>('');
  const [fFood, setFFood] = useState<string>('');
  const [fExtra, setFExtra] = useState<ExtraRow[]>([]);
  const [fNotes, setFNotes] = useState('');
  const [fEmployeeIds, setFEmployeeIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState('');
  const [quickOpen, setQuickOpen] = useState(false);
  const [empDropOpen, setEmpDropOpen] = useState(false);
  const empDropRef = useRef<HTMLDivElement>(null);

  // ── detail / view modal ──
  const [detailClaim, setDetailClaim] = useState<ExpenseClaim | null>(null);

  // ── delete confirm ──
  const [deleteId, setDeleteId] = useState<string | null>(null);

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }

  // resolve member_id
  useEffect(() => {
    if (!currentUser) return;
    async function resolve() {
      const { data } = await supabase
        .from('team_members')
        .select('id, full_name, username, is_active')
        .order('full_name');
      if (!data) { setLoading(false); setMemberResolved(true); return; }
      setTeamMembers(data.filter((m: TeamMember) => m.is_active !== false));
      const name = (currentUser?.full_name || '').trim().toLowerCase();
      const uname = (currentUser?.username || '').trim().toLowerCase();
      const match = data.find((m: TeamMember) =>
        (name && m.full_name?.trim().toLowerCase() === name) ||
        (uname && m.username?.trim().toLowerCase() === uname),
      );
      setMemberId(match?.id ?? null);
      setMemberResolved(true);
    }
    resolve();
  }, [currentUser]);

  // load claims — only runs once member resolution is settled and we have a real id
  useEffect(() => {
    if (!memberResolved) return;
    if (!memberId) { setLoading(false); return; }
    loadClaims();
  }, [memberResolved, memberId]);

  async function loadClaims() {
    if (!memberId) return;
    setLoading(true);
    const { data } = await supabase
      .from('expense_claims')
      .select('*')
      .eq('member_id', memberId)
      .order('submitted_at', { ascending: false });
    setClaims((data as ExpenseClaim[]) ?? []);
    setLoading(false);
  }

  // close emp dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (empDropRef.current && !empDropRef.current.contains(e.target as Node)) {
        setEmpDropOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── total calc ──
  function calcTotal(): number {
    const t = parseFloat(fTransport as string) || 0;
    const f = parseFloat(fFood as string) || 0;
    const ex = fExtra.reduce((s, r) => s + (parseFloat(r.amount as string) || 0), 0);
    return t + f + ex;
  }

  // ── open new modal ──
  function openNew() {
    setEditId(null);
    setFProject('');
    setFSiteId('');
    setFDesc('');
    setFDate(today());
    setFTransport('');
    setFFood('');
    setFExtra([]);
    setFNotes('');
    setFEmployeeIds([]);
    setFormErr('');
    setQuickOpen(false);
    setEmpDropOpen(false);
    setModalOpen(true);
  }

  // ── open edit modal ──
  function openEdit(c: ExpenseClaim) {
    setEditId(c.id);
    setFProject(c.project_name ?? '');
    setFSiteId(c.site_id ?? '');
    setFDesc(c.description ?? '');
    setFDate(c.activity_date ?? today());
    setFTransport(c.transport_amount != null ? String(c.transport_amount) : '');
    setFFood(c.food_amount != null ? String(c.food_amount) : '');
    setFExtra(parseExtra(c.extra_categories));
    setFNotes(c.notes ?? '');
    setFEmployeeIds(parseEmployeeIds(c.employee_ids));
    setFormErr('');
    setQuickOpen(false);
    setEmpDropOpen(false);
    setModalOpen(true);
  }

  // ── extra rows ──
  function addExtraRow() {
    setFExtra(prev => [...prev, { category: '', amount: '' }]);
  }
  function removeExtraRow(i: number) {
    setFExtra(prev => prev.filter((_, idx) => idx !== i));
  }
  function updateExtraRow(i: number, field: 'category' | 'amount', val: string) {
    setFExtra(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: val } : r));
  }
  function applyQuickAdd(cat: string) {
    setFExtra(prev => [...prev, { category: cat, amount: '' }]);
    setQuickOpen(false);
  }

  // ── employee multi-select ──
  function toggleEmployee(id: string) {
    setFEmployeeIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id],
    );
  }
  function getEmpName(id: string) {
    return teamMembers.find(m => m.id === id)?.full_name ?? id;
  }

  // ── save ──
  async function saveClaim() {
    setFormErr('');
    if (!fProject) { setFormErr('Please select a project.'); return; }
    if (!fSiteId.trim()) { setFormErr('Please enter a Site ID.'); return; }
    if (!fDesc.trim()) { setFormErr('Please enter a description.'); return; }
    if (!fDate) { setFormErr('Please select an activity date.'); return; }

    // duplicate check for new claims
    if (!editId) {
      const dup = claims.find(c =>
        c.site_id === fSiteId.trim() &&
        c.activity_date === fDate &&
        c.status !== 'rejected',
      );
      if (dup) {
        setFormErr('A claim for this site and date already exists (non-rejected).');
        return;
      }
    }

    setSaving(true);
    const extraRows = fExtra.filter(r => r.category.trim());
    const payload = {
      member_id: memberId,
      project_name: fProject,
      site_id: fSiteId.trim(),
      description: fDesc.trim(),
      activity_date: fDate,
      transport_amount: parseFloat(fTransport as string) || 0,
      food_amount: parseFloat(fFood as string) || 0,
      extra_categories: extraRows,
      employee_ids: fEmployeeIds,
      notes: fNotes.trim() || null,
      total_amount: calcTotal(),
      status: 'pending',
    };

    let error: { message: string } | null = null;
    if (editId) {
      const res = await supabase.from('expense_claims').update(payload).eq('id', editId);
      error = res.error;
    } else {
      const res = await supabase.from('expense_claims').insert({ ...payload, submitted_at: new Date().toISOString() });
      error = res.error;
    }

    setSaving(false);
    if (error) { setFormErr(error.message); return; }
    setModalOpen(false);
    showToast(editId ? 'Claim resubmitted.' : 'Claim submitted.', true);
    loadClaims();
  }

  // ── delete ──
  async function confirmDelete() {
    if (!deleteId) return;
    const { error } = await supabase.from('expense_claims').delete().eq('id', deleteId);
    setDeleteId(null);
    if (error) { showToast('Delete failed: ' + error.message, false); return; }
    showToast('Claim deleted.', true);
    setClaims(prev => prev.filter(c => c.id !== deleteId));
  }

  if (!hasPerm('view_my_expenses')) {
    return (
      <div className={styles.page}>
        <p style={{ color: 'var(--text-muted)', marginTop: 40 }}>
          You do not have permission to view this page.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* header */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>My Expenses</h1>
          <div className={styles.subtitle}>Submit and track your expense claims</div>
        </div>
        {memberResolved && memberId && (
          <button className={styles.newBtn} onClick={openNew}>
            <PlusIcon /> New Claim
          </button>
        )}
      </div>

      {/* not linked notice */}
      {memberResolved && !memberId && (
        <div className={styles.notLinked}>
          <strong>Account not linked to a team member profile.</strong>
          <p>Personal expense claims are for field engineers and technicians. Your admin account doesn't have a linked team member profile, so claims cannot be submitted or listed here.</p>
        </div>
      )}

      {/* table */}
      {(!memberResolved || loading) ? (
        <div className={styles.emptyState}>Loading…</div>
      ) : !memberId ? null : claims.length === 0 ? (
        <div className={styles.emptyState}>No expense claims yet. Submit your first claim.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Activity Date</th>
                <th>Submitted</th>
                <th>Site ID</th>
                <th>Project</th>
                <th>Description</th>
                <th>Total (IQD)</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {claims.map(c => (
                <tr key={c.id}>
                  <td>{fmtDate(c.activity_date)}</td>
                  <td className={styles.cellMuted}>{fmtDateTime(c.submitted_at)}</td>
                  <td><span className={styles.siteCode}>{c.site_id}</span></td>
                  <td>{c.project_name}</td>
                  <td className={styles.descCell}>{c.description}</td>
                  <td className={styles.amtCell}>{fmtAmt(c.total_amount)}</td>
                  <td><StatusBadge status={c.status} /></td>
                  <td>
                    <div className={styles.actionCol}>
                      <button className={styles.viewBtn} onClick={() => setDetailClaim(c)}>View</button>
                      {c.status === 'rejected' && (
                        <div className={styles.rejBox}>
                          {c.rejection_reason && (
                            <div className={styles.rejReason}>
                              <strong>Reason:</strong> {c.rejection_reason}
                            </div>
                          )}
                          <div className={styles.rejActions}>
                            <button className={styles.editBtn} onClick={() => openEdit(c)}>Edit &amp; Resubmit</button>
                            <button className={styles.deleteBtn} onClick={() => setDeleteId(c.id)}>Delete</button>
                          </div>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── New/Edit claim modal ── */}
      {modalOpen && (
        <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) setModalOpen(false); }}>
          <div className={styles.modal}>
            <div className={styles.modalHeader}>
              <h2 className={styles.modalTitle}>{editId ? 'Edit & Resubmit Claim' : 'New Expense Claim'}</h2>
              <button className={styles.closeBtn} onClick={() => setModalOpen(false)}>✕</button>
            </div>
            <div className={styles.modalBody}>

              {/* Activity Info */}
              <div className={styles.sectionLabel}>Activity Info</div>
              <div className={styles.formGrid2}>
                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel}>Project *</label>
                  <select className={styles.select} value={fProject} onChange={e => setFProject(e.target.value)}>
                    <option value="">Select project…</option>
                    {FIN_PROJECTS.map(p => <option key={p}>{p}</option>)}
                  </select>
                </div>
                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel}>Activity Date *</label>
                  <input type="date" className={styles.input} value={fDate} onChange={e => setFDate(e.target.value)} />
                </div>
              </div>
              <div className={styles.formGrid2}>
                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel}>Site ID *</label>
                  <input className={styles.input} placeholder="e.g. ZN-BGH-001" value={fSiteId} onChange={e => setFSiteId(e.target.value)} />
                </div>
                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel}>Description *</label>
                  <input className={styles.input} placeholder="Brief description of activity" value={fDesc} onChange={e => setFDesc(e.target.value)} />
                </div>
              </div>

              {/* Amounts */}
              <div className={styles.sectionLabel}>Amounts (IQD)</div>
              <div className={styles.formGrid2}>
                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel}>Transport</label>
                  <input type="number" min="0" className={styles.input} placeholder="0" value={fTransport} onChange={e => setFTransport(e.target.value)} />
                </div>
                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel}>Food & Meals</label>
                  <input type="number" min="0" className={styles.input} placeholder="0" value={fFood} onChange={e => setFFood(e.target.value)} />
                </div>
              </div>

              {/* Extra categories */}
              {fExtra.length > 0 && (
                <div className={styles.extraRows}>
                  {fExtra.map((row, i) => (
                    <div key={i} className={styles.extraCard}>
                      <div className={styles.fieldGroup}>
                        <label className={styles.fieldLabel}>Category</label>
                        <input className={styles.input} placeholder="e.g. Accommodation" value={row.category} onChange={e => updateExtraRow(i, 'category', e.target.value)} />
                      </div>
                      <div className={styles.fieldGroup}>
                        <label className={styles.fieldLabel}>Amount (IQD)</label>
                        <input type="number" min="0" className={styles.input} placeholder="0" value={row.amount} onChange={e => updateExtraRow(i, 'amount', e.target.value)} />
                      </div>
                      <button className={styles.removeRowBtn} onClick={() => removeExtraRow(i)} title="Remove">✕</button>
                    </div>
                  ))}
                </div>
              )}

              <div className={styles.extraRowActions}>
                <button className={styles.addRowBtn} onClick={addExtraRow}>+ Add Category</button>
                <button className={styles.addRowBtn} onClick={() => setQuickOpen(q => !q)}>⚡ Quick Add</button>
              </div>

              {quickOpen && (
                <div className={styles.quickPanel}>
                  <div className={styles.quickTitle}>Quick Add Category</div>
                  <div className={styles.quickGrid}>
                    {QUICK_CATEGORIES.map(cat => (
                      <button key={cat} className={styles.quickChip} onClick={() => applyQuickAdd(cat)}>{cat}</button>
                    ))}
                  </div>
                </div>
              )}

              {/* Total */}
              <div className={styles.totalBox}>
                <span className={styles.totalLabel}>Estimated Total</span>
                <span className={styles.totalAmount}>{calcTotal().toLocaleString('en-US')} IQD</span>
              </div>

              {/* Team members */}
              <div className={styles.sectionLabel}>Team Members (optional)</div>
              <div className={styles.empWrap} ref={empDropRef}>
                <div className={styles.empSelect} onClick={() => setEmpDropOpen(o => !o)}>
                  {fEmployeeIds.length === 0 && (
                    <span className={styles.empPlaceholder}>Select team members…</span>
                  )}
                  {fEmployeeIds.map(id => (
                    <span key={id} className={styles.empPill}>
                      {getEmpName(id)}
                      <button className={styles.pillRemove} onClick={e => { e.stopPropagation(); toggleEmployee(id); }}>×</button>
                    </span>
                  ))}
                  <span className={styles.empChevron}>▾</span>
                </div>
                {empDropOpen && (
                  <div className={styles.empDropdown}>
                    {teamMembers.map(m => (
                      <div
                        key={m.id}
                        className={`${styles.empOption} ${fEmployeeIds.includes(m.id) ? styles.empOptionSelected : ''}`}
                        onClick={() => toggleEmployee(m.id)}
                      >
                        {fEmployeeIds.includes(m.id) && <span className={styles.empCheck}>✓</span>}
                        {m.full_name}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Notes */}
              <div className={styles.sectionLabel}>Notes (optional)</div>
              <textarea className={styles.textarea} rows={3} placeholder="Any additional notes…" value={fNotes} onChange={e => setFNotes(e.target.value)} />

              {formErr && <div className={styles.formErr}>{formErr}</div>}
            </div>

            <div className={styles.modalFooter}>
              <button className={styles.cancelBtn} onClick={() => setModalOpen(false)}>Cancel</button>
              <button className={styles.submitBtn} onClick={saveClaim} disabled={saving}>
                {saving ? 'Submitting…' : editId ? 'Resubmit Claim' : 'Submit Claim'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Detail / view modal ── */}
      {detailClaim && (
        <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) setDetailClaim(null); }}>
          <div className={styles.modal}>
            <div className={styles.modalHeader}>
              <h2 className={styles.modalTitle}>Claim Details</h2>
              <button className={styles.closeBtn} onClick={() => setDetailClaim(null)}>✕</button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.detailGrid}>
                <div className={styles.detailItem}><span className={styles.detailKey}>Project</span><span>{detailClaim.project_name}</span></div>
                <div className={styles.detailItem}><span className={styles.detailKey}>Site ID</span><span className={styles.siteCode}>{detailClaim.site_id}</span></div>
                <div className={styles.detailItem}><span className={styles.detailKey}>Activity Date</span><span>{fmtDate(detailClaim.activity_date)}</span></div>
                <div className={styles.detailItem}><span className={styles.detailKey}>Submitted</span><span>{fmtDateTime(detailClaim.submitted_at)}</span></div>
                <div className={`${styles.detailItem} ${styles.detailFull}`}><span className={styles.detailKey}>Description</span><span>{detailClaim.description}</span></div>
              </div>

              <div className={styles.sectionLabel} style={{ marginTop: 16 }}>Amounts</div>
              <div className={styles.detailGrid}>
                <div className={styles.detailItem}><span className={styles.detailKey}>Transport</span><span>{fmtAmt(detailClaim.transport_amount)} IQD</span></div>
                <div className={styles.detailItem}><span className={styles.detailKey}>Food &amp; Meals</span><span>{fmtAmt(detailClaim.food_amount)} IQD</span></div>
                {parseExtra(detailClaim.extra_categories).map((r, i) => (
                  <div key={i} className={styles.detailItem}>
                    <span className={styles.detailKey}>{r.category}</span>
                    <span>{fmtAmt(parseFloat(r.amount as string) || 0)} IQD</span>
                  </div>
                ))}
              </div>

              <div className={styles.totalBox} style={{ marginTop: 12 }}>
                <span className={styles.totalLabel}>Total Amount</span>
                <span className={styles.totalAmount}>{fmtAmt(detailClaim.total_amount)} IQD</span>
              </div>

              {parseEmployeeIds(detailClaim.employee_ids).length > 0 && (
                <>
                  <div className={styles.sectionLabel} style={{ marginTop: 16 }}>Team Members</div>
                  <div className={styles.empTags}>
                    {parseEmployeeIds(detailClaim.employee_ids).map(id => (
                      <span key={id} className={styles.empTag}>{getEmpName(id)}</span>
                    ))}
                  </div>
                </>
              )}

              {detailClaim.notes && (
                <>
                  <div className={styles.sectionLabel} style={{ marginTop: 16 }}>Notes</div>
                  <p className={styles.notesText}>{detailClaim.notes}</p>
                </>
              )}

              {/* Status timeline */}
              <div className={styles.sectionLabel} style={{ marginTop: 20 }}>Status</div>
              <div className={styles.timeline}>
                <TimelineStep label="Submitted" sub={fmtDateTime(detailClaim.submitted_at)} />
                {detailClaim.status === 'approved' && (
                  <TimelineStep label="Approved" sub={detailClaim.reviewed_at ? fmtDateTime(detailClaim.reviewed_at) : ''} type="approved" />
                )}
                {detailClaim.status === 'rejected' && (
                  <TimelineStep label="Rejected" sub={detailClaim.rejection_reason ?? ''} type="rejected" />
                )}
                {detailClaim.status === 'pending' && (
                  <TimelineStep pending label="Pending Review" sub="Awaiting approval" />
                )}
              </div>
            </div>
            <div className={styles.modalFooter}>
              <button className={styles.cancelBtn} onClick={() => setDetailClaim(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete confirm ── */}
      {deleteId && (
        <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) setDeleteId(null); }}>
          <div className={styles.confirmModal}>
            <h3 className={styles.confirmTitle}>Delete Claim?</h3>
            <p className={styles.confirmText}>This action cannot be undone.</p>
            <div className={styles.confirmActions}>
              <button className={styles.cancelBtn} onClick={() => setDeleteId(null)}>Cancel</button>
              <button className={styles.dangerBtn} onClick={confirmDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast ── */}
      {toast && (
        <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const s = status?.toLowerCase();
  const cls = s === 'approved' ? styles.badgeApproved : s === 'rejected' ? styles.badgeRejected : styles.badgePending;
  return <span className={`${styles.badge} ${cls}`}>{status}</span>;
}

interface TimelineStepProps {
  label: string;
  sub: string;
  pending?: boolean;
  type?: 'approved' | 'rejected';
}

function TimelineStep({ label, sub, pending, type }: TimelineStepProps) {
  const dotCls = type === 'approved'
    ? styles.tlDotApproved
    : type === 'rejected'
    ? styles.tlDotRejected
    : pending
    ? styles.tlDotPending
    : styles.tlDotDone;

  return (
    <div className={styles.tlStep}>
      <div className={`${styles.tlDot} ${dotCls}`} />
      <div className={styles.tlContent}>
        <div className={styles.tlLabel}>{label}</div>
        {sub && <div className={styles.tlSub}>{sub}</div>}
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
