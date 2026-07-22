import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { type FieldTrip, type TripParticipant, fmtDate as fmtTripDate, buildTimeline } from '../lib/tripTypes';
import styles from './HrProfiles.module.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TeamMember {
  id: string;
  full_name: string;
  role: string | null;
  is_active: boolean;
  username: string | null;
  phone: string | null;
  national_id: string | null;
  date_of_birth: string | null;
  address: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  start_date: string | null;
  monthly_salary: number | null;
  notes: string | null;
  profile_photo_url: string | null;
}

interface EmployeeDocument {
  id: string;
  member_id: string;
  file_name: string;
  file_url: string;
  file_type: string | null;
  uploaded_by: string | null;
  uploaded_at: string | null;
  created_at: string | null;
}

type TabName = 'personal' | 'employment' | 'documents' | 'trips';

interface EditForm {
  full_name: string;
  phone: string;
  national_id: string;
  date_of_birth: string;
  address: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  role: string;
  monthly_salary: string;
  start_date: string;
  is_active: string;
  notes: string;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

const GRAD_PALETTE = [
  'linear-gradient(135deg,#2563eb,#1d4ed8)',
  'linear-gradient(135deg,#7c3aed,#6d28d9)',
  'linear-gradient(135deg,#059669,#047857)',
  'linear-gradient(135deg,#d97706,#b45309)',
  'linear-gradient(135deg,#0d9488,#0f766e)',
  'linear-gradient(135deg,#dc2626,#b91c1c)',
  'linear-gradient(135deg,#0891b2,#0e7490)',
  'linear-gradient(135deg,#65a30d,#4d7c0f)',
];
const BADGE_PALETTE = [
  { bg: '#dbeafe', color: '#1e40af' },
  { bg: '#ede9fe', color: '#5b21b6' },
  { bg: '#d1fae5', color: '#065f46' },
  { bg: '#fef3c7', color: '#92400e' },
  { bg: '#ccfbf1', color: '#134e4a' },
  { bg: '#fee2e2', color: '#991b1b' },
  { bg: '#cffafe', color: '#164e63' },
  { bg: '#ecfccb', color: '#365314' },
];

function roleHash(role: string | null): number {
  if (!role) return 0;
  let h = 0;
  for (let i = 0; i < role.length; i++) h = (h * 31 + role.charCodeAt(i)) & 0xFFFF;
  return h;
}
function avatarGrad(role: string | null) { return GRAD_PALETTE[roleHash(role) % GRAD_PALETTE.length]; }
function badgeColors(role: string | null) { return BADGE_PALETTE[roleHash(role) % BADGE_PALETTE.length]; }
function hrInitials(name: string | null) {
  return (name || '?').trim().split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
}
function fmtDateHr(d: string | null): string {
  if (!d) return '';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtIqd(n: number | null): string {
  if (n == null) return '—';
  const v = Math.round(n);
  return isNaN(v) ? '—' : v.toLocaleString('en-US') + ' IQD';
}
function docIconLabel(name: string): string {
  const ext = (name || '').split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'PDF';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'IMG';
  if (['doc', 'docx'].includes(ext)) return 'DOC';
  return 'FILE';
}
function docIconCls(name: string): string {
  const ext = (name || '').split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return styles.docIconPdf;
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return styles.docIconImg;
  if (['doc', 'docx'].includes(ext)) return styles.docIconDoc;
  return styles.docIconFile;
}
function memberToForm(m: TeamMember): EditForm {
  return {
    full_name: m.full_name ?? '',
    phone: m.phone ?? '',
    national_id: m.national_id ?? '',
    date_of_birth: m.date_of_birth ?? '',
    address: m.address ?? '',
    emergency_contact_name: m.emergency_contact_name ?? '',
    emergency_contact_phone: m.emergency_contact_phone ?? '',
    role: m.role ?? '',
    monthly_salary: m.monthly_salary != null ? String(m.monthly_salary) : '',
    start_date: m.start_date ?? '',
    is_active: String(m.is_active !== false),
    notes: m.notes ?? '',
  };
}

// ── Field display helper ──────────────────────────────────────────────────────

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className={styles.fieldItem}>
      <div className={styles.fieldLabel}>{label}</div>
      {value ? <div className={styles.fieldValue}>{value}</div> : <div className={styles.fieldEmpty}>—</div>}
    </div>
  );
}

// ── Member card (list) ────────────────────────────────────────────────────────

function MemberCard({
  member, docCount, onView, onViewDocs,
}: {
  member: TeamMember;
  docCount: number;
  onView: () => void;
  onViewDocs: () => void;
}) {
  const grad = avatarGrad(member.role);
  const bc = badgeColors(member.role);
  return (
    <div className={styles.card}>
      <div className={styles.avWrap}>
        {member.profile_photo_url
          ? <img className={styles.avatarImg} src={member.profile_photo_url} alt="" />
          : <div className={styles.avatar} style={{ background: grad }}>{hrInitials(member.full_name)}</div>}
        <span className={`${styles.statusDot} ${member.is_active !== false ? styles.statusActive : styles.statusInactive}`} />
      </div>
      <div className={styles.cardName}>{member.full_name || '—'}</div>
      {member.role
        ? <span className={styles.roleBadge} style={{ background: bc.bg, color: bc.color }}>{member.role}</span>
        : <span style={{ height: 22, display: 'block' }} />}
      {member.phone
        ? <div className={styles.cardPhone}><PhoneIcon /> {member.phone}</div>
        : <div style={{ height: 20 }} />}
      <div className={styles.cardBtns}>
        <button className={styles.viewBtn} onClick={onView}>View Profile</button>
        <button
          className={`${styles.docBtn} ${docCount > 0 ? styles.docBtnHasDocs : ''}`}
          onClick={onViewDocs}
          title="Documents"
        >
          <DocSmallIcon /> {docCount > 0 ? docCount : ''}
        </button>
      </div>
    </div>
  );
}

// ── Profile detail (full-page replacement) ────────────────────────────────────

function ProfileDetail({
  member: initialMember,
  initialTab,
  currentUser,
  onBack,
  onMemberUpdated,
}: {
  member: TeamMember;
  initialTab: TabName;
  currentUser: { full_name?: string; username?: string } | null;
  onBack: () => void;
  onMemberUpdated: (m: TeamMember) => void;
}) {
  const [member, setMember] = useState(initialMember);
  const [activeTab, setActiveTab] = useState<TabName>(initialTab);
  const [docs, setDocs] = useState<EmployeeDocument[] | null>(null);
  const [docsLoading, setDocsLoading] = useState(false);
  const [trips, setTrips] = useState<FieldTrip[] | null>(null);
  const [tripPP, setTripPP] = useState<Record<string, TripParticipant[]>>({});
  const [tripsLoading, setTripsLoading] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<EditForm>(() => memberToForm(initialMember));
  const [editErr, setEditErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [docUploading, setDocUploading] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  // Lazy-load docs on Documents tab
  useEffect(() => {
    if (activeTab !== 'documents' || docs !== null) return;
    setDocsLoading(true);
    supabase.from('employee_documents')
      .select('*')
      .eq('member_id', member.id)
      .order('uploaded_at', { ascending: false })
      .then(({ data, error }) => {
        setDocsLoading(false);
        if (error) { showToast('Failed to load documents: ' + error.message, false); return; }
        setDocs((data ?? []) as EmployeeDocument[]);
      });
  }, [activeTab]);

  // Lazy-load trips on Trips tab
  useEffect(() => {
    if (activeTab !== 'trips' || trips !== null) return;
    setTripsLoading(true);
    supabase.from('field_trips')
      .select('*')
      .filter('team_member_ids', 'cs', JSON.stringify([member.id]))
      .order('date', { ascending: false })
      .limit(50)
      .then(async ({ data, error }) => {
        if (error) { setTripsLoading(false); showToast('Failed to load trips: ' + error.message, false); return; }
        const tripList = (data ?? []) as FieldTrip[];
        setTrips(tripList);
        if (tripList.length) {
          const ids = tripList.map(t => t.id);
          const { data: pp } = await supabase.from('trip_participants').select('*').in('trip_id', ids).order('joined_at');
          const ppMap: Record<string, TripParticipant[]> = {};
          ((pp ?? []) as TripParticipant[]).forEach(p => {
            (ppMap[p.trip_id] = ppMap[p.trip_id] ?? []).push(p);
          });
          setTripPP(ppMap);
        }
        setTripsLoading(false);
      });
  }, [activeTab]);

  // ── Photo upload ──────────────────────────────────────────────────────────

  async function handlePhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { showToast('Photo must be under 10 MB', false); return; }
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg';
    const path = `photos/${member.id}_${Date.now()}.${ext}`;
    setPhotoUploading(true);
    try {
      const { error: upErr } = await supabase.storage.from('employee-docs').upload(path, file, { upsert: true });
      if (upErr) throw upErr;
      const photoUrl = supabase.storage.from('employee-docs').getPublicUrl(path).data.publicUrl;
      const { error: dbErr } = await supabase.from('team_members').update({ profile_photo_url: photoUrl }).eq('id', member.id);
      if (dbErr) throw dbErr;
      const updated = { ...member, profile_photo_url: photoUrl };
      setMember(updated);
      onMemberUpdated(updated);
      showToast('Photo updated', true);
    } catch (e: unknown) {
      showToast('Upload failed: ' + (e instanceof Error ? e.message : String(e)), false);
    }
    setPhotoUploading(false);
  }

  // ── Document upload ───────────────────────────────────────────────────────

  async function handleDocUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { showToast('File must be under 20 MB', false); return; }
    const ext = file.name.split('.').pop() ?? '';
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${member.id}/${Date.now()}-${safeName}`;
    setDocUploading(true);
    showToast('Uploading…', true);
    try {
      const { error: upErr } = await supabase.storage.from('employee-docs').upload(path, file, { upsert: false });
      if (upErr) throw upErr;
      const { error: dbErr } = await supabase.from('employee_documents').insert({
        member_id: member.id,
        file_name: file.name,
        file_url: path,
        file_type: ext,
        uploaded_by: currentUser?.full_name ?? currentUser?.username ?? null,
      });
      if (dbErr) throw dbErr;
      setDocs(null); // force re-fetch
      showToast('Document uploaded', true);
    } catch (e: unknown) {
      showToast('Upload failed: ' + (e instanceof Error ? e.message : String(e)), false);
    }
    setDocUploading(false);
  }

  // ── Document delete ───────────────────────────────────────────────────────

  async function handleDocDelete(doc: EmployeeDocument) {
    if (!confirm('Delete this document? This cannot be undone.')) return;
    try {
      await supabase.storage.from('employee-docs').remove([doc.file_url]);
      const { error } = await supabase.from('employee_documents').delete().eq('id', doc.id);
      if (error) throw error;
      setDocs(prev => prev ? prev.filter(d => d.id !== doc.id) : null);
      showToast('Document deleted', true);
    } catch (e: unknown) {
      showToast('Delete failed: ' + (e instanceof Error ? e.message : String(e)), false);
    }
  }

  // ── Edit save ─────────────────────────────────────────────────────────────

  async function handleSave() {
    setEditErr('');
    const name = editForm.full_name.trim();
    if (!name) { setEditErr('Full Name is required.'); return; }
    const today = new Date().toISOString().split('T')[0];
    const newActive = editForm.is_active === 'true';
    const payload: Record<string, unknown> = {
      full_name: name,
      phone: editForm.phone.trim() || null,
      national_id: editForm.national_id.trim() || null,
      date_of_birth: editForm.date_of_birth || null,
      address: editForm.address.trim() || null,
      emergency_contact_name: editForm.emergency_contact_name.trim() || null,
      emergency_contact_phone: editForm.emergency_contact_phone.trim() || null,
      role: editForm.role.trim() || null,
      monthly_salary: Number(editForm.monthly_salary) || null,
      start_date: editForm.start_date || null,
      is_active: newActive,
      notes: editForm.notes.trim() || null,
    };
    if (member.is_active !== newActive) {
      if (newActive) { payload.activated_at = today; payload.deactivated_at = null; }
      else { payload.deactivated_at = today; }
    }
    setSaving(true);
    const { error } = await supabase.from('team_members').update(payload).eq('id', member.id);
    setSaving(false);
    if (error) { setEditErr(error.message); return; }
    const updated: TeamMember = { ...member, ...(payload as Partial<TeamMember>) };
    setMember(updated);
    onMemberUpdated(updated);
    setEditOpen(false);
    showToast('Profile saved', true);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const grad = avatarGrad(member.role);
  const bc = badgeColors(member.role);

  return (
    <div className={styles.page}>
      {toast && <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`}>{toast.msg}</div>}

      <button className={styles.backBtn} onClick={onBack}>
        <ChevronLeftIcon /> Back to Profiles
      </button>

      {/* Banner */}
      <div className={styles.banner}>
        <div className={styles.bannerAvWrap}>
          {member.profile_photo_url
            ? <img className={styles.bannerPhoto} src={member.profile_photo_url} alt="" />
            : <div className={styles.bannerAvatar} style={{ background: grad }}>{hrInitials(member.full_name)}</div>}
          <button
            className={styles.photoBtn}
            onClick={() => photoInputRef.current?.click()}
            title={photoUploading ? 'Uploading…' : 'Change photo'}
            disabled={photoUploading}
          >
            <CameraIcon />
          </button>
          <input ref={photoInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handlePhotoUpload} />
        </div>
        <div className={styles.bannerInfo}>
          <div className={styles.bannerName}>{member.full_name}</div>
          <div className={styles.bannerMeta}>
            {member.role && (
              <span className={styles.bannerBadge} style={{ background: bc.bg, color: bc.color }}>{member.role}</span>
            )}
            <span className={`${styles.bannerStatus} ${member.is_active !== false ? styles.bannerStatusActive : styles.bannerStatusInactive}`}>
              ● {member.is_active !== false ? 'Active' : 'Inactive'}
            </span>
            {member.start_date && (
              <span className={styles.bannerStart}>Joined {fmtDateHr(member.start_date)}</span>
            )}
          </div>
        </div>
        <button className={styles.editBtn} onClick={() => { setEditForm(memberToForm(member)); setEditErr(''); setEditOpen(true); }}>
          Edit Profile
        </button>
      </div>

      {/* Tabs */}
      <div className={styles.tabs}>
        {(['personal', 'employment', 'documents', 'trips'] as TabName[]).map(tab => (
          <button
            key={tab}
            className={`${styles.tab} ${activeTab === tab ? styles.tabActive : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'personal' ? 'Personal Info' : tab === 'employment' ? 'Employment' : tab === 'documents' ? 'Documents' : 'Field Trips'}
          </button>
        ))}
      </div>

      {/* Tab body */}
      <div className={styles.tabBody}>
        {activeTab === 'personal' && (
          <>
            <div className={styles.sectionTitle}>Personal Information</div>
            <div className={styles.fields}>
              <Field label="Full Name" value={member.full_name} />
              <Field label="Phone" value={member.phone} />
              <Field label="National ID" value={member.national_id} />
              <Field label="Date of Birth" value={fmtDateHr(member.date_of_birth) || null} />
              <Field label="Address" value={member.address} />
              <Field label="Emergency Contact Name" value={member.emergency_contact_name} />
              <Field label="Emergency Contact Phone" value={member.emergency_contact_phone} />
            </div>
          </>
        )}

        {activeTab === 'employment' && (
          <>
            <div className={styles.sectionTitle}>Employment Information</div>
            <div className={styles.fields}>
              <Field label="Job Title" value={member.role} />
              <Field label="Monthly Salary" value={member.monthly_salary != null ? fmtIqd(member.monthly_salary) : null} />
              <Field label="Start Date" value={fmtDateHr(member.start_date) || null} />
              <Field label="Status" value={member.is_active !== false ? 'Active' : 'Inactive'} />
              <Field label="Notes" value={member.notes} />
            </div>
          </>
        )}

        {activeTab === 'documents' && (
          <DocsTab
            docs={docs}
            loading={docsLoading}
            uploading={docUploading}
            onUpload={() => docInputRef.current?.click()}
            onDelete={handleDocDelete}
          />
        )}
        <input ref={docInputRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.docx" style={{ display: 'none' }} onChange={handleDocUpload} />

        {activeTab === 'trips' && (
          <TripsTab trips={trips} tripPP={tripPP} loading={tripsLoading} />
        )}
      </div>

      {/* Edit modal */}
      {editOpen && (
        <div className={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setEditOpen(false); }}>
          <div className={styles.modal}>
            <div className={styles.modalHeader}>
              <div className={styles.modalTitle}>Edit Profile</div>
              <button className={styles.modalClose} onClick={() => setEditOpen(false)}>×</button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.modalSection}>Personal Information</div>
              <div className={styles.modalGrid}>
                <div className={styles.modalField}>
                  <label>Full Name *</label>
                  <input value={editForm.full_name} onChange={e => setEditForm(f => ({ ...f, full_name: e.target.value }))} />
                </div>
                <div className={styles.modalField}>
                  <label>Phone</label>
                  <input value={editForm.phone} onChange={e => setEditForm(f => ({ ...f, phone: e.target.value }))} />
                </div>
                <div className={styles.modalField}>
                  <label>National ID</label>
                  <input value={editForm.national_id} onChange={e => setEditForm(f => ({ ...f, national_id: e.target.value }))} />
                </div>
                <div className={styles.modalField}>
                  <label>Date of Birth</label>
                  <input type="date" value={editForm.date_of_birth} onChange={e => setEditForm(f => ({ ...f, date_of_birth: e.target.value }))} />
                </div>
                <div className={`${styles.modalField} ${styles.modalFieldFull}`}>
                  <label>Address</label>
                  <input value={editForm.address} onChange={e => setEditForm(f => ({ ...f, address: e.target.value }))} />
                </div>
                <div className={styles.modalField}>
                  <label>Emergency Contact Name</label>
                  <input value={editForm.emergency_contact_name} onChange={e => setEditForm(f => ({ ...f, emergency_contact_name: e.target.value }))} />
                </div>
                <div className={styles.modalField}>
                  <label>Emergency Contact Phone</label>
                  <input value={editForm.emergency_contact_phone} onChange={e => setEditForm(f => ({ ...f, emergency_contact_phone: e.target.value }))} />
                </div>
              </div>
              <div className={styles.modalSection}>Employment</div>
              <div className={styles.modalGrid}>
                <div className={styles.modalField}>
                  <label>Job Title</label>
                  <input value={editForm.role} onChange={e => setEditForm(f => ({ ...f, role: e.target.value }))} />
                </div>
                <div className={styles.modalField}>
                  <label>Monthly Salary (IQD)</label>
                  <input type="number" value={editForm.monthly_salary} onChange={e => setEditForm(f => ({ ...f, monthly_salary: e.target.value }))} />
                </div>
                <div className={styles.modalField}>
                  <label>Start Date</label>
                  <input type="date" value={editForm.start_date} onChange={e => setEditForm(f => ({ ...f, start_date: e.target.value }))} />
                </div>
                <div className={styles.modalField}>
                  <label>Status</label>
                  <select value={editForm.is_active} onChange={e => setEditForm(f => ({ ...f, is_active: e.target.value }))}>
                    <option value="true">Active</option>
                    <option value="false">Inactive</option>
                  </select>
                </div>
                <div className={`${styles.modalField} ${styles.modalFieldFull}`}>
                  <label>Notes</label>
                  <textarea value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} />
                </div>
              </div>
              {editErr && <div className={styles.modalErr}>{editErr}</div>}
            </div>
            <div className={styles.modalFooter}>
              <button className={styles.modalCancelBtn} onClick={() => setEditOpen(false)}>Cancel</button>
              <button className={styles.modalSaveBtn} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save Profile'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Documents tab ─────────────────────────────────────────────────────────────

function DocsTab({
  docs, loading, uploading, onUpload, onDelete,
}: {
  docs: EmployeeDocument[] | null;
  loading: boolean;
  uploading: boolean;
  onUpload: () => void;
  onDelete: (doc: EmployeeDocument) => void;
}) {
  if (loading) return <div className={styles.tabEmpty}>Loading…</div>;
  const list = docs ?? [];
  return (
    <>
      <div className={styles.docsToolbar}>
        <span className={styles.docsCount}>{list.length} document{list.length !== 1 ? 's' : ''}</span>
        <button className={styles.uploadBtn} onClick={onUpload} disabled={uploading}>
          <UploadIcon /> Upload File
        </button>
      </div>
      <div className={styles.docList}>
        {list.length === 0 ? (
          <div className={styles.tabEmpty}>No documents uploaded yet.</div>
        ) : list.map(d => {
          const dt = (d.uploaded_at ?? d.created_at)
            ? new Date((d.uploaded_at ?? d.created_at)!).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
            : '';
          const url = supabase.storage.from('employee-docs').getPublicUrl(d.file_url).data.publicUrl;
          return (
            <div key={d.id} className={styles.docItem}>
              <div className={`${styles.docIcon} ${docIconCls(d.file_name)}`}>{docIconLabel(d.file_name)}</div>
              <div className={styles.docInfo}>
                <div className={styles.docName} title={d.file_name}>{d.file_name}</div>
                <div className={styles.docMeta}>{dt}{d.uploaded_by ? ` · ${d.uploaded_by}` : ''}</div>
              </div>
              <div className={styles.docActions}>
                <a className={styles.docDl} href={url} target="_blank" rel="noreferrer" download={d.file_name}>Download</a>
                <button className={styles.docDel} onClick={() => onDelete(d)} title="Delete">
                  <TrashIcon />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── Trips tab ─────────────────────────────────────────────────────────────────

function TripsTab({
  trips, tripPP, loading,
}: {
  trips: FieldTrip[] | null;
  tripPP: Record<string, TripParticipant[]>;
  loading: boolean;
}) {
  if (loading) return <div className={styles.tabEmpty}>Loading…</div>;
  const list = trips ?? [];
  if (!list.length) return <div className={styles.tabEmpty}>No field trips recorded.</div>;

  function statusBadgeCls(s: string) {
    if (s === 'active') return styles.badgeActive;
    if (s === 'departed') return styles.badgeDeparted;
    if (s === 'completed') return styles.badgeCompleted;
    return styles.badgePending;
  }

  return (
    <div>
      <div className={styles.tripsCount}>{list.length} trip{list.length !== 1 ? 's' : ''} found</div>
      {list.map(t => {
        const pp = tripPP[t.id] ?? [];
        const events = buildTimeline(t, pp);
        return (
          <div key={t.id} className={styles.tripCard}>
            <div className={styles.tripCardTop}>
              <div className={styles.tripTitle}>
                {t.project || '—'}{t.site_id ? ` · ${t.site_id}` : ''}
              </div>
              <span className={`${styles.tripBadge} ${statusBadgeCls(t.status)}`}>{t.status || 'pending'}</span>
            </div>
            <div className={styles.tripSub}>
              {t.date ? fmtTripDate(t.date) : '—'}{t.governate ? ` · ${t.governate}` : ''}
            </div>
            {events.length > 0 && (
              <div className={styles.tripTimeline}>
                <div className={styles.tripTlHdr}>Timeline</div>
                <ul className={styles.tripTlList}>
                  {events.map((ev, i) => (
                    <li key={i} className={styles.tripTlItem}>
                      <span>{ev.label}</span>
                      <span className={styles.tripTlTime}>{ev.time}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main page component ───────────────────────────────────────────────────────

export default function HrProfiles() {
  const { hasPerm, currentUser } = useAuth();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [initialTab, setInitialTab] = useState<TabName>('personal');
  const [docCounts, setDocCounts] = useState<Record<string, number>>({});
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  async function loadMembers() {
    setLoading(true);
    const { data, error } = await supabase
      .from('team_members')
      .select('id, full_name, role, is_active, username, phone, national_id, date_of_birth, address, emergency_contact_name, emergency_contact_phone, start_date, monthly_salary, notes, profile_photo_url')
      .order('full_name');
    if (error) { showToast('Failed to load members: ' + error.message, false); }
    setMembers((data ?? []) as TeamMember[]);
    setLoading(false);
    // Load doc counts (async, doesn't block list render)
    supabase.from('employee_documents').select('member_id').then(({ data: docs }) => {
      if (!docs) return;
      const counts: Record<string, number> = {};
      docs.forEach((d: { member_id: string }) => { counts[d.member_id] = (counts[d.member_id] || 0) + 1; });
      setDocCounts(counts);
    });
  }

  useEffect(() => { loadMembers(); }, []);

  function openProfile(id: string, tab: TabName = 'personal') {
    setSelectedId(id);
    setInitialTab(tab);
  }

  function handleMemberUpdated(updated: TeamMember) {
    setMembers(prev => prev.map(m => m.id === updated.id ? updated : m));
  }

  if (!hasPerm('view_hr_profiles')) {
    return (
      <div className={styles.page}>
        <div className={styles.denied}>You don't have permission to view this page.</div>
      </div>
    );
  }

  // Detail view
  if (selectedId) {
    const member = members.find(m => m.id === selectedId);
    if (!member) return null;
    return (
      <ProfileDetail
        member={member}
        initialTab={initialTab}
        currentUser={currentUser}
        onBack={() => setSelectedId(null)}
        onMemberUpdated={handleMemberUpdated}
      />
    );
  }

  // List view
  const filtered = members.filter(m => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (m.full_name || '').toLowerCase().includes(q) ||
           (m.role || '').toLowerCase().includes(q) ||
           (m.phone || '').toLowerCase().includes(q);
  });

  return (
    <div className={styles.page}>
      {toast && <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`}>{toast.msg}</div>}

      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Employee Profiles</h1>
          <div className={styles.subtitle}>Complete employee records · {members.length} employees</div>
        </div>
        <button className={styles.refreshBtn} onClick={loadMembers} disabled={loading}>
          <RefreshIcon /> {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div className={styles.searchWrap}>
        <SearchIcon />
        <input
          className={styles.searchInp}
          type="text"
          placeholder="Search by name, role, phone…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && <button className={styles.searchClear} onClick={() => setSearch('')}>×</button>}
      </div>

      {loading ? (
        <div className={styles.empty}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div className={styles.empty}>No employees found.</div>
      ) : (
        <div className={styles.cards}>
          {filtered.map(m => (
            <MemberCard
              key={m.id}
              member={m}
              docCount={docCounts[m.id] ?? 0}
              onView={() => openProfile(m.id, 'personal')}
              onViewDocs={() => openProfile(m.id, 'documents')}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
    </svg>
  );
}
function PhoneIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.37 2 2 0 0 1 3.59 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.54a16 16 0 0 0 6.55 6.55l.92-.93a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}
function DocSmallIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}
function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}
function CameraIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}
function UploadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}
function PeopleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
export { PeopleIcon };
