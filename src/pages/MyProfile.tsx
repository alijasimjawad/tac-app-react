import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';
import { logActivity } from '../lib/activityLog';
import styles from './MyProfile.module.css';

// Photo crop/zoom modal — viewport size (px) and output image size (px)
const CROP_VIEW = 260;
const CROP_OUT = 480;

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

interface HrLinkedInfo {
  phone: string | null;
  national_id: string | null;
  date_of_birth: string | null;
  address: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  start_date: string | null;
  notes: string | null;
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
  const { t } = useTranslation();
  const { currentUser, refreshProfile } = useAuth();
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<EditForm>(() => formFromUser());
  const [editErr, setEditErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // ── HR-linked profile (read-only source when this user has a matching team_members row) ──
  const [hrInfo, setHrInfo] = useState<HrLinkedInfo | null>(null);
  const [hrChecked, setHrChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadHrLink() {
      if (!currentUser) return;
      const cols = 'phone, national_id, date_of_birth, address, emergency_contact_name, emergency_contact_phone, start_date, notes';
      let row: HrLinkedInfo | null = null;
      if (currentUser.username) {
        const { data } = await supabase.from('team_members').select(cols).ilike('username', currentUser.username).limit(1).maybeSingle();
        if (data) row = data as HrLinkedInfo;
      }
      if (!row && currentUser.full_name) {
        const { data } = await supabase.from('team_members').select(cols).ilike('full_name', currentUser.full_name).limit(1).maybeSingle();
        if (data) row = data as HrLinkedInfo;
      }
      if (!cancelled) { setHrInfo(row); setHrChecked(true); }
    }
    loadHrLink();
    return () => { cancelled = true; };
  }, [currentUser?.username, currentUser?.full_name]);

  // ── Change Password modal state ────────────────────────────────────────────
  const [pwOpen, setPwOpen] = useState(false);
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwErr, setPwErr] = useState('');
  const [pwSaving, setPwSaving] = useState(false);

  // ── Photo crop/zoom modal state ────────────────────────────────────────────
  const [cropOpen, setCropOpen] = useState(false);
  const [cropImgUrl, setCropImgUrl] = useState<string | null>(null);
  const [cropZoom, setCropZoom] = useState(1);
  const [cropPos, setCropPos] = useState({ x: 0, y: 0 });
  const [coverScale, setCoverScale] = useState(1);
  const cropImgElRef = useRef<HTMLImageElement>(null);
  const pendingFileRef = useRef<File | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

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

  const isHrLinked = !!hrInfo;
  // Display source: HR profile wins (read-only) when linked, otherwise this user's own record.
  const disp: HrLinkedInfo = isHrLinked ? hrInfo : {
    phone: currentUser.phone,
    national_id: currentUser.national_id,
    date_of_birth: currentUser.date_of_birth,
    address: currentUser.address,
    emergency_contact_name: currentUser.emergency_contact_name,
    emergency_contact_phone: currentUser.emergency_contact_phone,
    start_date: currentUser.start_date,
    notes: currentUser.notes,
  };

  // ── Photo upload (opens crop/zoom modal first) ────────────────────────────

  function onPhotoFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { showToast('Photo must be under 10 MB', false); return; }
    if (cropImgUrl) URL.revokeObjectURL(cropImgUrl);
    pendingFileRef.current = file;
    setCropImgUrl(URL.createObjectURL(file));
    setCropZoom(1);
    setCropPos({ x: 0, y: 0 });
    setCoverScale(1);
    setCropOpen(true);
  }

  function closeCropModal() {
    if (photoUploading) return;
    if (cropImgUrl) URL.revokeObjectURL(cropImgUrl);
    setCropOpen(false);
    setCropImgUrl(null);
    pendingFileRef.current = null;
    dragRef.current = null;
  }

  function onCropImgLoad() {
    const img = cropImgElRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    setCoverScale(Math.max(CROP_VIEW / img.naturalWidth, CROP_VIEW / img.naturalHeight));
  }

  function clampCropPos(p: { x: number; y: number }, zoom: number) {
    const img = cropImgElRef.current;
    if (!img || !img.naturalWidth) return p;
    const totalScale = coverScale * zoom;
    const dW = img.naturalWidth * totalScale;
    const dH = img.naturalHeight * totalScale;
    const maxX = Math.max(0, (dW - CROP_VIEW) / 2);
    const maxY = Math.max(0, (dH - CROP_VIEW) / 2);
    return { x: Math.min(maxX, Math.max(-maxX, p.x)), y: Math.min(maxY, Math.max(-maxY, p.y)) };
  }

  function onCropZoomChange(z: number) {
    setCropZoom(z);
    setCropPos(p => clampCropPos(p, z));
  }

  function onCropPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: cropPos.x, origY: cropPos.y };
  }
  function onCropPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setCropPos(clampCropPos({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy }, cropZoom));
  }
  function onCropPointerUp() { dragRef.current = null; }

  async function handleCropSave() {
    const img = cropImgElRef.current;
    const file = pendingFileRef.current;
    if (!img || !file || !img.naturalWidth) return;
    const totalScale = coverScale * cropZoom;
    const dW = img.naturalWidth * totalScale;
    const dH = img.naturalHeight * totalScale;
    const imgLeft = CROP_VIEW / 2 - dW / 2 + cropPos.x;
    const imgTop = CROP_VIEW / 2 - dH / 2 + cropPos.y;
    const sx = -imgLeft / totalScale;
    const sy = -imgTop / totalScale;
    const sSize = CROP_VIEW / totalScale;
    const canvas = document.createElement('canvas');
    canvas.width = CROP_OUT;
    canvas.height = CROP_OUT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, CROP_OUT, CROP_OUT);
    canvas.toBlob(blob => { if (blob) uploadPhotoBlob(blob, file.name); }, 'image/jpeg', 0.92);
  }

  async function uploadPhotoBlob(blob: Blob, origName: string) {
    if (!currentUser) return;
    const ext = origName.split('.').pop()?.toLowerCase() === 'png' ? 'png' : 'jpg';
    const path = `owner-photos/${currentUser.id}_${Date.now()}.${ext}`;
    setPhotoUploading(true);
    try {
      const { error: upErr } = await supabase.storage.from('employee-docs').upload(path, blob, { upsert: true, contentType: blob.type });
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
      setPhotoUploading(false);
      closeCropModal();
    } catch (e: unknown) {
      showToast('Upload failed: ' + (e instanceof Error ? e.message : String(e)), false);
      setPhotoUploading(false);
    }
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

  // ── Change password ───────────────────────────────────────────────────────

  function openPwModal() {
    setPwCurrent(''); setPwNew(''); setPwConfirm(''); setPwErr(''); setPwOpen(true);
  }
  function closePwModal() {
    if (pwSaving) return;
    setPwOpen(false);
  }

  async function handleChangePassword() {
    if (!currentUser) return;
    setPwErr('');
    if (!pwCurrent) { setPwErr('Enter your current password'); return; }
    if (pwNew.length < 6) { setPwErr('New password must be at least 6 characters'); return; }
    if (pwNew !== pwConfirm) { setPwErr('New password and confirmation do not match'); return; }

    setPwSaving(true);
    const email = `${currentUser.username.trim().toLowerCase()}@tac.internal`;
    const { error: authErr } = await supabase.auth.signInWithPassword({ email, password: pwCurrent });
    if (authErr) {
      setPwSaving(false);
      setPwErr('Current password is incorrect');
      return;
    }
    const { error: updErr } = await supabase.auth.updateUser({ password: pwNew });
    setPwSaving(false);
    if (updErr) { setPwErr(updErr.message); return; }
    setPwOpen(false);
    showToast('Password changed', true);
    logActivity({
      userFullName: currentUser.full_name ?? currentUser.username,
      action: 'Changed Password',
      sectionName: 'Profile',
      details: `Changed own password: ${currentUser.full_name}`,
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
            {disp.start_date && (
              <span className={styles.bannerStart}>Joined {fmtDate(disp.start_date)}</span>
            )}
          </div>
        </div>
        <div className={styles.bannerActions}>
          <button className={styles.editBtnSecondary} onClick={openPwModal}>
            {t('prof_changePassword')}
          </button>
          {hrChecked && !isHrLinked && (
            <button className={styles.editBtn} onClick={() => { setEditForm(formFromUser()); setEditErr(''); setEditOpen(true); }}>
              {t('prof_editProfile')}
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className={styles.tabBody}>
        <div className={styles.sectionTitle}>{t('prof_personalInfo')}</div>
        <div className={styles.fields}>
          <Field label={t('prof_fullName')} value={currentUser.full_name} />
          <Field label={t('prof_phone')} value={disp.phone} />
          <Field label={t('prof_nationalId')} value={disp.national_id} />
          <Field label={t('prof_dob')} value={fmtDate(disp.date_of_birth) || null} />
          <Field label={t('prof_address')} value={disp.address} />
          <Field label={t('prof_emergencyName')} value={disp.emergency_contact_name} />
          <Field label={t('prof_emergencyPhone')} value={disp.emergency_contact_phone} />
        </div>

        <div className={styles.sectionTitleSpaced}>{t('prof_additionalInfo')}</div>
        <div className={styles.fields}>
          <Field label={t('prof_startDate')} value={fmtDate(disp.start_date) || null} />
          <Field label={t('prof_notes')} value={disp.notes} />
        </div>
      </div>

      {/* Edit modal */}
      {editOpen && (
        <div className={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setEditOpen(false); }}>
          <div className={styles.modal}>
            <div className={styles.modalHeader}>
              <div className={styles.modalTitle}>{t('prof_editProfile')}</div>
              <button className={styles.modalClose} onClick={() => setEditOpen(false)}>×</button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.modalSection}>{t('prof_personalInfo')}</div>
              <div className={styles.modalGrid}>
                <div className={styles.modalField}>
                  <label>{t('prof_phone')}</label>
                  <input value={editForm.phone} onChange={e => setEditForm(f => ({ ...f, phone: e.target.value }))} />
                </div>
                <div className={styles.modalField}>
                  <label>{t('prof_nationalId')}</label>
                  <input value={editForm.national_id} onChange={e => setEditForm(f => ({ ...f, national_id: e.target.value }))} />
                </div>
                <div className={styles.modalField}>
                  <label>{t('prof_dob')}</label>
                  <input type="date" value={editForm.date_of_birth} onChange={e => setEditForm(f => ({ ...f, date_of_birth: e.target.value }))} />
                </div>
                <div className={styles.modalField}>
                  <label>{t('prof_startDate')}</label>
                  <input type="date" value={editForm.start_date} onChange={e => setEditForm(f => ({ ...f, start_date: e.target.value }))} />
                </div>
                <div className={`${styles.modalField} ${styles.modalFieldFull}`}>
                  <label>{t('prof_address')}</label>
                  <input value={editForm.address} onChange={e => setEditForm(f => ({ ...f, address: e.target.value }))} />
                </div>
                <div className={styles.modalField}>
                  <label>{t('prof_emergencyName')}</label>
                  <input value={editForm.emergency_contact_name} onChange={e => setEditForm(f => ({ ...f, emergency_contact_name: e.target.value }))} />
                </div>
                <div className={styles.modalField}>
                  <label>{t('prof_emergencyPhone')}</label>
                  <input value={editForm.emergency_contact_phone} onChange={e => setEditForm(f => ({ ...f, emergency_contact_phone: e.target.value }))} />
                </div>
                <div className={`${styles.modalField} ${styles.modalFieldFull}`}>
                  <label>{t('prof_notes')}</label>
                  <textarea value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} />
                </div>
              </div>
              {editErr && <div className={styles.modalErr}>{editErr}</div>}
            </div>
            <div className={styles.modalFooter}>
              <button className={styles.modalCancelBtn} onClick={() => setEditOpen(false)}>{t('prof_cancel')}</button>
              <button className={styles.modalSaveBtn} onClick={handleSave} disabled={saving}>
                {saving ? t('prof_saving') : t('prof_saveProfile')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Change Password modal */}
      {pwOpen && (
        <div className={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) closePwModal(); }}>
          <div className={styles.modal} style={{ maxWidth: 420 }}>
            <div className={styles.modalHeader}>
              <div className={styles.modalTitle}>{t('prof_changePassword')}</div>
              <button className={styles.modalClose} onClick={closePwModal} disabled={pwSaving}>×</button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.modalGrid} style={{ gridTemplateColumns: '1fr' }}>
                <div className={styles.modalField}>
                  <label>{t('prof_currentPw')}</label>
                  <input type="password" value={pwCurrent} onChange={e => setPwCurrent(e.target.value)} autoComplete="current-password" />
                </div>
                <div className={styles.modalField}>
                  <label>{t('prof_newPw')}</label>
                  <input type="password" value={pwNew} onChange={e => setPwNew(e.target.value)} autoComplete="new-password" />
                </div>
                <div className={styles.modalField}>
                  <label>{t('prof_confirmPw')}</label>
                  <input type="password" value={pwConfirm} onChange={e => setPwConfirm(e.target.value)} autoComplete="new-password" />
                </div>
              </div>
              {pwErr && <div className={styles.modalErr}>{pwErr}</div>}
            </div>
            <div className={styles.modalFooter}>
              <button className={styles.modalCancelBtn} onClick={closePwModal} disabled={pwSaving}>{t('prof_cancel')}</button>
              <button className={styles.modalSaveBtn} onClick={handleChangePassword} disabled={pwSaving}>
                {pwSaving ? t('prof_updating') : t('prof_updatePw')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Photo crop/zoom modal */}
      {cropOpen && cropImgUrl && (
        <div className={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) closeCropModal(); }}>
          <div className={styles.cropModal}>
            <div className={styles.modalHeader}>
              <div className={styles.modalTitle}>{t('prof_adjustPhoto')}</div>
              <button className={styles.modalClose} onClick={closeCropModal} disabled={photoUploading}>×</button>
            </div>
            <div className={styles.cropBody}>
              <div
                className={styles.cropViewport}
                onPointerDown={onCropPointerDown}
                onPointerMove={onCropPointerMove}
                onPointerUp={onCropPointerUp}
                onPointerLeave={onCropPointerUp}
              >
                <img
                  ref={cropImgElRef}
                  src={cropImgUrl}
                  alt=""
                  draggable={false}
                  onLoad={onCropImgLoad}
                  className={styles.cropImg}
                  style={
                    cropImgElRef.current?.naturalWidth
                      ? {
                          width: cropImgElRef.current.naturalWidth * coverScale * cropZoom,
                          height: cropImgElRef.current.naturalHeight * coverScale * cropZoom,
                          transform: `translate(calc(-50% + ${cropPos.x}px), calc(-50% + ${cropPos.y}px))`,
                        }
                      : undefined
                  }
                />
              </div>
              <div className={styles.cropZoomRow}>
                <ZoomOutIcon />
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={0.01}
                  value={cropZoom}
                  onChange={e => onCropZoomChange(Number(e.target.value))}
                  className={styles.cropZoomSlider}
                />
                <ZoomInIcon />
              </div>
              <div className={styles.cropHint}>Drag the photo to reposition, use the slider to zoom</div>
            </div>
            <div className={styles.modalFooter}>
              <button className={styles.modalCancelBtn} onClick={closeCropModal} disabled={photoUploading}>{t('prof_cancel')}</button>
              <button className={styles.modalSaveBtn} onClick={handleCropSave} disabled={photoUploading}>
                {photoUploading ? 'Saving…' : 'Save Photo'}
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
function ZoomInIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}
function ZoomOutIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /><line x1="8" y1="11" x2="14" y2="11" />
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
