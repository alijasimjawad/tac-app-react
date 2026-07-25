import { useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { logActivity } from '../lib/activityLog';
import styles from './MyProfile.module.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface EditForm {
  phone: string;
  national_id: string;
  date_of_birth: string;
  address: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  start_date: string;
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

function roleHash(role: string | null | undefined): number {
  if (!role) return 0;
  let h = 0;
  for (let i = 0; i < role.length; i++) h = (h * 31 + role.charCodeAt(i)) & 0xFFFF;
  return h;
}
function avatarGrad(role: string | null | undefined) { return GRAD_PALETTE[roleHash(role) % GRAD_PALETTE.length]; }
function badgeColors(role: string | null | undefined) { return BADGE_PALETTE[roleHash(role) % BADGE_PALETTE.length]; }
function initialsOf(name: string | null | undefined) {
  return (name || '?').trim().split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
}
function fmtDate(d: string | null | undefined): string {
  if (!d) return '';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className={styles.fieldItem}>
      <div className={styles.fieldLabel}>{label}</div>
      {value ? <div className={styles.fieldValue}>{value}</div> : <div className={styles.fieldEmpty}>—</div>}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MyProfile() {
  const { currentUser, refreshProfile } = useAuth();
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<EditForm>(() => formFromUser());
  const [editErr, setEditErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  function formFromUser(): EditForm {
    return {
      phone: currentUser?.phone ?? '',
      national_id: currentUser?.national_id ?? '',
      date_of_birth: currentUser?.date_of_birth ?? '',
      address: currentUser?.address ?? '',
      emergency_contact_name: currentUser?.emergency_contact_name ?? '',
      emergency_contact_phone: currentUser?.emergency_contact_phone ?? '',
      start_date: currentUser?.start_date ?? '',
      notes: currentUser?.notes ?? '',
    };
  }

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  if (!currentUser) return null;

  // ── Photo upload (direct — no crop) ──────────────────────────────────────

  async function onPhotoFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !currentUser) return;
    if (file.size > 10 * 1024 * 1024) { showToast('Photo must be under 10 MB', false); return; }
    const ext = file.name.split('.').pop()?.toLowerCase() === 'png' ? 'png' : 'jpg';
    const path = `owner-photos/${currentUser.id}_${Date.now()}.${ext}`;
    setPhotoUploading(true);
    try {
      const { error: upErr } = await supabase.storage.from('employee-docs').upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) throw upErr;
      const photoUrl = supabase.storage.from('employee-docs').getPublicUrl(path).data.publicUrl;
      const { error: dbErr } = await supabase.from('users').update({ profile_photo_url: photoUrl }).eq('id', currentUser.id);
      if (dbErr) throw dbErr;
      await refreshProfile();
      showToast('Photo updated', true);
      logActivity({
        userFullName: currentUser.full_name ?? currentUser.username,
        action: 'Edited My Profile',
        sectionName: 'Profile',
        details: `Updated photo: ${currentUser.full_name}`,
      });
    } catch (e: unknown) {
      showToast('Upload failed: ' + (e instanceof Error ? e.message : String(e)), false);
    }
    setPhotoUploading(false);
  }

  // ── Edit save ─────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!currentUser) return;
    setEditErr('');
    const payload = {
      phone: editForm.phone.trim() || null,
      national_id: editForm.national_id.trim() || null,
      date_of_birth: editForm.date_of_birth || null,
      address: editForm.address.trim() || null,
      emergency_contact_name: editForm.emergency_contact_name.trim() || null,
      emergency_contact_phone: editForm.emergency_contact_phone.trim() || null,
      start_date: editForm.start_date || null,
      notes: editForm.notes.trim() || null,
    };
    setSaving(true);
    const { error } = await supabase.from('users').update(payload).eq('id', currentUser.id);
    setSaving(false);
    if (error) { setEditErr(error.message); return; }
    await refreshProfile();
    setEditOpen(false);
    showToast('Profile saved', true);
    logActivity({
      userFullName: currentUser.full_name ?? currentUser.username,
      action: 'Edited My Profile',
      sectionName: 'Profile',
      details: `Edited own profile: ${currentUser.full_name}`,
    });
  }

  const grad = avatarGrad(currentUser.role);
  const bc = badgeColors(currentUser.role);

  return (
    <div className={styles.page}>
      {toast && <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`}>{toast.msg}</div>}

      {/* Banner */}
      <div className={styles.banner}>
        <div className={styles.bannerAvWrap}>
          {currentUser.profile_photo_url
            ? <img className={styles.bannerPhoto} src={currentUser.profile_photo_url} alt="" />
            : <div className={styles.bannerAvatar} style={{ background: grad }}>{initialsOf(currentUser.full_name)}</div>}
          <button
            className={styles.photoBtn}
            onClick={() => photoInputRef.current?.click()}
            title={photoUploading ? 'Uploading…' : 'Change photo'}
            disabled={photoUploading}
          >
            <CameraIcon />
          </button>
          <input ref={photoInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onPhotoFileSelected} />
        </div>
        <div className={styles.bannerInfo}>
          <div className={styles.bannerName}>{currentUser.full_name || currentUser.username}</div>
          <div className={styles.bannerMeta}>
            {currentUser.role && (
              <span className={styles.bannerBadge} style={{ background: bc.bg, color: bc.color }}>{currentUser.role}</span>
            )}
            {currentUser.start_date && (
              <span className={styles.bannerStart}>Joined {fmtDate(currentUser.start_date)}</span>
            )}
          </div>
        </div>
        <button className={styles.editBtn} onClick={() => { setEditForm(formFromUser()); setEditErr(''); setEditOpen(true); }}>
          Edit Profile
        </button>
      </div>

      {/* Body */}
      <div className={styles.tabBody}>
        <div className={styles.sectionTitle}>Personal Information</div>
        <div className={styles.fields}>
          <Field label="Full Name" value={currentUser.full_name} />
          <Field label="Phone" value={currentUser.phone} />
          <Field label="National ID" value={currentUser.national_id} />
          <Field label="Date of Birth" value={fmtDate(currentUser.date_of_birth) || null} />
          <Field label="Address" value={currentUser.address} />
          <Field label="Emergency Contact Name" value={currentUser.emergency_contact_name} />
          <Field label="Emergency Contact Phone" value={currentUser.emergency_contact_phone} />
        </div>

        <div className={styles.sectionTitleSpaced}>Additional Information</div>
        <div className={styles.fields}>
          <Field label="Start Date" value={fmtDate(currentUser.start_date) || null} />
          <Field label="Notes" value={currentUser.notes} />
        </div>
      </div>

      {/* Edit modal */}
      {editOpen && (
        <div className={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setEditOpen(false); }}>
          <div className={styles.modal}>
            <div className={styles.modalHeader}>
              <div className={styles.modalTitle}>Edit My Profile</div>
              <button className={styles.modalClose} onClick={() => setEditOpen(false)}>×</button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.modalSection}>Personal Information</div>
              <div className={styles.modalGrid}>
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
                <div className={styles.modalField}>
                  <label>Start Date</label>
                  <input type="date" value={editForm.start_date} onChange={e => setEditForm(f => ({ ...f, start_date: e.target.value }))} />
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

// ── Icons ─────────────────────────────────────────────────────────────────────

function CameraIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

export function ProfileIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}
