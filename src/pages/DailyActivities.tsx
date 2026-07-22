import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import styles from './DailyActivities.module.css';

const FIN_PROJECTS = ['Zain Project', 'Nokia Project', 'Huawei Project', 'IPT Project', 'General'];
const ACTIVITY_TYPES = ['Installation', 'Maintenance', 'Survey', 'Testing', 'Commissioning', 'Integration', 'Clearance'];
const STATUS_OPTIONS = ['In Progress', 'Completed', 'Blocked'];
const NAME_TO_KEY: Record<string, string> = {
  'Zain Project': 'zain',
  'Nokia Project': 'nokia',
  'Huawei Project': 'huawei',
  'IPT Project': 'ipt',
};

interface DailyActivity {
  id: string;
  date: string;
  project: string;
  site_id: string | null;
  governate: string | null;
  activity_type: string | null;
  status: string | null;
  notes: string | null;
  team_member_ids: string[] | null;
  team_member_names: string[] | null;
  created_by: string | null;
  created_at: string;
  is_edited: boolean | null;
  edit_reason: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

interface TeamMember {
  id: string;
  full_name: string;
  username: string;
  is_active: boolean | null;
}

interface SectionRow {
  id: string;
  section_label: string | null;
  section_name: string | null;
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function fmtDate(iso: string) {
  const [yr, mo, dy] = iso.split('-');
  return `${dy}/${mo}/${yr}`;
}

function initials(name: string) {
  return name.trim().split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase();
}

function buildWaMsg(
  date: string,
  project: string,
  sectionLabel: string,
  site_id: string,
  governate: string,
  teamNames: string[],
  activityType: string,
  status: string,
  notes: string,
) {
  const d = date ? fmtDate(date) : '—';
  const projLine = sectionLabel && !sectionLabel.startsWith('—')
    ? `${project || '—'} / ${sectionLabel}`
    : (project || '—');
  const teamLines = teamNames.length
    ? teamNames.map(n => `  › ${n}`).join('\n')
    : '  › —';
  return `◆ *TAC Network Tracker*\n━━━━━━━━━━━━\n◆ *DAILY ACTIVITY REPORT*\n━━━━━━━━━━━━\n\n◆ *Date:* ${d}\n◆ *Project:* ${projLine}\n◆ *Site ID:* ${site_id || '—'}  |  ◆ *Gov:* ${governate || '—'}\n\n━━━━━━━━━━━━\n◆ *Team*\n${teamLines}\n\n◆ *Activity:* ${activityType || '—'}\n◆ *Status:* ${status || '—'}\n\n◆ *Notes*\n${notes || '—'}\n━━━━━━━━━━━━\n_◆ TAC Network Operations Center_`;
}

async function ftCreateTrip(daId: string, v: FormVals, createdBy: string) {
  const tripPayload = {
    daily_activity_id: daId,
    date: v.date,
    project: v.project,
    site_id: v.site_id,
    governate: v.governate,
    notes: v.notes,
    team_member_ids: v.team_member_ids,
    team_member_names: v.team_member_names,
    status: 'pending',
    created_by: createdBy,
  };
  const { data: trip, error } = await supabase.from('field_trips').insert(tripPayload).select().single();
  if (error || !trip) return;
  if (v.team_member_ids.length) {
    const participants = v.team_member_ids.map((mid, i) => ({
      trip_id: trip.id,
      member_id: mid,
      member_name: v.team_member_names[i] || mid,
      status: 'pending',
    }));
    await supabase.from('trip_participants').insert(participants);
  }
}

async function ftSyncTrip(daId: string, v: FormVals, createdBy: string) {
  const { data: existing } = await supabase
    .from('field_trips').select('id,status').eq('daily_activity_id', daId).single();
  if (!existing) { await ftCreateTrip(daId, v, createdBy); return; }
  await supabase.from('field_trips').update({
    date: v.date, project: v.project, site_id: v.site_id,
    governate: v.governate, notes: v.notes,
    team_member_ids: v.team_member_ids, team_member_names: v.team_member_names,
  }).eq('id', existing.id);
  for (let i = 0; i < v.team_member_ids.length; i++) {
    const mid = v.team_member_ids[i];
    const { data: pp } = await supabase
      .from('trip_participants').select('id').eq('trip_id', existing.id).eq('member_id', mid).single();
    if (!pp) {
      await supabase.from('trip_participants').insert({
        trip_id: existing.id, member_id: mid,
        member_name: v.team_member_names[i] || mid, status: 'pending',
      });
    }
  }
}

interface FormVals {
  date: string;
  project: string;
  site_id: string;
  governate: string;
  activity_type: string;
  status: string;
  notes: string;
  team_member_ids: string[];
  team_member_names: string[];
}

export default function DailyActivities() {
  const { currentUser } = useAuth();

  // Data
  const [activities, setActivities] = useState<DailyActivity[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);

  // Form
  const [date, setDate] = useState(today());
  const [project, setProject] = useState(FIN_PROJECTS[0]);
  const [sections, setSections] = useState<SectionRow[]>([]);
  const [sectionId, setSectionId] = useState('');
  const [sectionLabel, setSectionLabel] = useState('');
  const [siteTags, setSiteTags] = useState<string[]>([]);
  const [siteInput, setSiteInput] = useState('');
  const [siteOptions, setSiteOptions] = useState<string[]>([]);
  const [siteDataMap, setSiteDataMap] = useState<Record<string, Record<string, unknown>>>({});
  const [governate, setGovernate] = useState('');
  const [activityType, setActivityType] = useState(ACTIVITY_TYPES[0]);
  const [status, setStatus] = useState(STATUS_OPTIONS[0]);
  const [notes, setNotes] = useState('');
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Modals / UI
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [reasonModal, setReasonModal] = useState(false);
  const [reasonVal, setReasonVal] = useState('');
  const [reasonErr, setReasonErr] = useState(false);
  const reasonResolve = useRef<((v: string | null) => void) | null>(null);
  const [viewActivity, setViewActivity] = useState<DailyActivity | null>(null);

  const siteInputRef = useRef<HTMLInputElement>(null);
  const formCardRef = useRef<HTMLDivElement>(null);

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }

  // ── Initial load ──
  useEffect(() => {
    Promise.all([loadActivities(), loadTeamMembers()]).then(() => setLoading(false));
  }, []);

  async function loadActivities() {
    const { data } = await supabase
      .from('daily_activities').select('*')
      .order('date', { ascending: false })
      .order('created_at', { ascending: false });
    setActivities(data || []);
  }

  async function loadTeamMembers() {
    const { data } = await supabase.from('team_members').select('id,full_name,username,is_active');
    setTeamMembers((data || []).filter((m: TeamMember) => m.is_active !== false));
  }

  // ── Sections load on project change ──
  useEffect(() => {
    setSectionId('');
    setSectionLabel('');
    setSiteOptions([]);
    setSiteDataMap({});
    setSiteTags([]);
    setSiteInput('');
    setGovernate('');
    if (!project) { setSections([]); return; }
    const projKey = NAME_TO_KEY[project] || project;
    supabase
      .from('sections')
      .select('id,section_label,section_name')
      .eq('project_name', projKey)
      .neq('is_deleted', true)
      .order('created_at', { ascending: true })
      .then(({ data }) => setSections(data || []));
  }, [project]);

  // ── Site IDs load on section change ──
  useEffect(() => {
    setSiteOptions([]);
    setSiteDataMap({});
    setSiteTags([]);
    setSiteInput('');
    setGovernate('');
    if (!sectionId) return;
    (async () => {
      const { data: secData } = await supabase.from('sections').select('columns').eq('id', sectionId).single();
      const columns: string[] = secData?.columns || [];
      const siteIdCol = columns[0] || 'Site ID';
      const { data: rowsData } = await supabase.from('rows')
        .select('data').eq('section_id', sectionId).order('row_order', { ascending: true });
      const seen = new Set<string>();
      const opts: string[] = [];
      const map: Record<string, Record<string, unknown>> = {};
      (rowsData || []).forEach((r: { data: Record<string, unknown> }) => {
        if (!r.data) return;
        const val = String(r.data[siteIdCol] ?? '').trim();
        if (val && val !== 'undefined' && val !== 'null' && !seen.has(val)) {
          seen.add(val);
          opts.push(val);
          map[val] = r.data;
        }
      });
      setSiteOptions(opts);
      setSiteDataMap(map);
    })();
  }, [sectionId]);

  // ── Auto-fill governate ──
  function autoFillGovernate(siteId: string) {
    const rowData = siteDataMap[siteId];
    if (!rowData) return;
    const keys = Object.keys(rowData);
    const govKey = keys.find(k => /^gov(ernate|ernorate)?$/i.test(k));
    if (govKey) setGovernate(String(rowData[govKey]).trim());
  }

  // ── Site tag input handlers ──
  function commitSiteInput() {
    const val = siteInput.trim();
    if (val && !siteTags.includes(val)) {
      const newTags = [...siteTags, val];
      setSiteTags(newTags);
      autoFillGovernate(val);
    }
    setSiteInput('');
  }

  function siteKeydown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitSiteInput();
    } else if (e.key === 'Backspace' && !siteInput && siteTags.length) {
      setSiteTags(siteTags.slice(0, -1));
    }
  }

  function removeSiteTag(idx: number) {
    setSiteTags(siteTags.filter((_, i) => i !== idx));
  }

  // ── Busy detection ──
  function getBusyMap() {
    const busyIds = new Set<string>();
    const busyInfo: Record<string, string[]> = {};
    activities
      .filter(a => a.date === date && a.id !== editingId)
      .forEach(a => {
        (a.team_member_ids || []).forEach(id => {
          busyIds.add(id);
          if (!busyInfo[id]) busyInfo[id] = [];
          busyInfo[id].push(`${a.project || '—'} – ${a.activity_type || 'an activity'} (Site ${a.site_id || '—'})`);
        });
      });
    return { busyIds, busyInfo };
  }

  function toggleMember(memberId: string, memberName: string, isBusy: boolean, busyInfo: string[]) {
    const next = new Set(selectedMemberIds);
    if (next.has(memberId)) {
      next.delete(memberId);
      setSelectedMemberIds(next);
      return;
    }
    if (isBusy) {
      const list = busyInfo.map((s, i) => `${i + 1}. ${s}`).join('\n');
      const ok = window.confirm(`${memberName} is already assigned to:\n${list}\n\nAdd them to this activity as well?`);
      if (!ok) return;
    }
    next.add(memberId);
    setSelectedMemberIds(next);
  }

  // ── Reason modal ──
  function promptReason(): Promise<string | null> {
    return new Promise(resolve => {
      reasonResolve.current = resolve;
      setReasonVal('');
      setReasonErr(false);
      setReasonModal(true);
    });
  }

  function confirmReason() {
    const val = reasonVal.trim();
    if (!val) { setReasonErr(true); return; }
    setReasonModal(false);
    reasonResolve.current?.(val);
    reasonResolve.current = null;
  }

  function cancelReason() {
    setReasonModal(false);
    reasonResolve.current?.(null);
    reasonResolve.current = null;
  }

  // ── Save ──
  async function save() {
    if (!date) { showToast('Please select a date.', false); return; }
    if (!project) { showToast('Please select a project.', false); return; }

    const allTags = siteInput.trim() && !siteTags.includes(siteInput.trim())
      ? [...siteTags, siteInput.trim()]
      : siteTags;
    const site_id = allTags.join(', ');

    const memberIds = [...selectedMemberIds];
    const memberNames = memberIds.map(id => teamMembers.find(m => m.id === id)?.full_name || id);

    const v: FormVals = {
      date, project, site_id, governate: governate.trim(),
      activity_type: activityType, status, notes: notes.trim(),
      team_member_ids: memberIds, team_member_names: memberNames,
    };

    const byUser = currentUser?.full_name || currentUser?.username || '';
    setSaving(true);

    if (editingId) {
      const reason = await promptReason();
      if (!reason) { showToast('Update cancelled — a reason is required.', false); setSaving(false); return; }
      const payload = {
        ...v, is_edited: true, edit_reason: reason,
        updated_at: new Date().toISOString(), updated_by: byUser,
      };
      const { error } = await supabase.from('daily_activities').update(payload).eq('id', editingId);
      if (error) { showToast(error.message, false); setSaving(false); return; }
      showToast('Activity updated!', true);
      ftSyncTrip(editingId, v, byUser).catch(() => {});
      setEditingId(null);
    } else {
      const payload = { ...v, created_by: byUser };
      const { data: inserted, error } = await supabase
        .from('daily_activities').insert(payload).select().single();
      if (error) { showToast(error.message, false); setSaving(false); return; }
      showToast('Activity saved!', true);
      if (inserted?.id) ftCreateTrip(inserted.id, v, byUser).catch(() => {});
    }

    setSaving(false);
    resetForm();
    await loadActivities();
  }

  function resetForm() {
    setDate(today());
    setProject(FIN_PROJECTS[0]);
    setSectionId('');
    setSectionLabel('');
    setSiteTags([]);
    setSiteInput('');
    setGovernate('');
    setActivityType(ACTIVITY_TYPES[0]);
    setStatus(STATUS_OPTIONS[0]);
    setNotes('');
    setSelectedMemberIds(new Set());
  }

  // ── Edit ──
  function startEdit(a: DailyActivity) {
    setEditingId(a.id);
    setDate(a.date || today());
    setProject(a.project || FIN_PROJECTS[0]);
    setSiteTags(String(a.site_id || '').split(',').map(s => s.trim()).filter(Boolean));
    setSiteInput('');
    setGovernate(a.governate || '');
    setActivityType(a.activity_type || ACTIVITY_TYPES[0]);
    setStatus(a.status || STATUS_OPTIONS[0]);
    setNotes(a.notes || '');
    setSelectedMemberIds(new Set(a.team_member_ids || []));
    formCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('Editing activity — update the form and click Update Activity.', true);
  }

  function cancelEdit() {
    setEditingId(null);
    resetForm();
    showToast('Edit cancelled.', true);
  }

  // ── Delete ──
  async function deleteActivity(id: string) {
    if (!window.confirm('Delete this activity?')) return;
    // Delete trip participants first (no guarantee of cascade), then trip, then activity
    const { data: trip } = await supabase.from('field_trips').select('id').eq('daily_activity_id', id).single();
    if (trip?.id) {
      await supabase.from('trip_participants').delete().eq('trip_id', trip.id);
      await supabase.from('field_trips').delete().eq('id', trip.id);
    }
    const { error } = await supabase.from('daily_activities').delete().eq('id', id);
    if (error) { showToast(error.message, false); return; }
    setActivities(prev => prev.filter(a => a.id !== id));
    showToast('Deleted.', true);
    if (editingId === id) { setEditingId(null); resetForm(); }
  }

  // ── WhatsApp ──
  function sendWa() {
    const allTags = siteInput.trim() && !siteTags.includes(siteInput.trim())
      ? [...siteTags, siteInput.trim()] : siteTags;
    const memberIds = [...selectedMemberIds];
    const memberNames = memberIds.map(id => teamMembers.find(m => m.id === id)?.full_name || id);
    const msg = buildWaMsg(date, project, sectionLabel, allTags.join(', '), governate, memberNames, activityType, status, notes);
    window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
  }

  function shareWa(a: DailyActivity) {
    const teamNames = Array.isArray(a.team_member_names) ? a.team_member_names : [];
    const msg = buildWaMsg(a.date, a.project, '', a.site_id || '', a.governate || '', teamNames, a.activity_type || '', a.status || '', a.notes || '');
    window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
  }

  // ── KPI counts ──
  const total = activities.length;
  const completed = activities.filter(a => a.status === 'Completed').length;
  const inProg = activities.filter(a => a.status === 'In Progress').length;
  const blocked = activities.filter(a => a.status === 'Blocked').length;

  const { busyIds, busyInfo } = getBusyMap();

  function statusPill(s: string | null) {
    if (s === 'Completed') return <span className={`${styles.pill} ${styles.pillDone}`}><span className={styles.dot} />{s}</span>;
    if (s === 'In Progress') return <span className={`${styles.pill} ${styles.pillInprog}`}><span className={styles.dot} />{s}</span>;
    if (s === 'Blocked') return <span className={`${styles.pill} ${styles.pillBlocked}`}><span className={styles.dot} />{s}</span>;
    return <span className={styles.pill}>{s || '—'}</span>;
  }

  return (
    <div className={styles.page}>
      {toast && (
        <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`}>
          {toast.msg}
        </div>
      )}

      {/* ── KPI Row ── */}
      <div className={styles.kpiRow}>
        <div className={`${styles.kpiCard} ${styles.kpiBlue}`}>
          <div className={styles.kpiIcon}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2">
              <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
              <rect x="9" y="3" width="6" height="4" rx="2"/>
              <line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>
            </svg>
          </div>
          <div><div className={styles.kpiLabel}>Total Activities</div><div className={styles.kpiValue}>{loading ? '—' : total}</div></div>
        </div>
        <div className={`${styles.kpiCard} ${styles.kpiGreen}`}>
          <div className={styles.kpiIcon}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </div>
          <div><div className={styles.kpiLabel}>Completed</div><div className={styles.kpiValue}>{loading ? '—' : completed}</div></div>
        </div>
        <div className={`${styles.kpiCard} ${styles.kpiAmber}`}>
          <div className={styles.kpiIcon}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
          </div>
          <div><div className={styles.kpiLabel}>In Progress</div><div className={styles.kpiValue}>{loading ? '—' : inProg}</div></div>
        </div>
        <div className={`${styles.kpiCard} ${styles.kpiRed}`}>
          <div className={styles.kpiIcon}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          </div>
          <div><div className={styles.kpiLabel}>Blocked</div><div className={styles.kpiValue}>{loading ? '—' : blocked}</div></div>
        </div>
      </div>

      {/* ── Form Card ── */}
      <div className={styles.formCard} ref={formCardRef}>
        <div className={styles.formHdr}>
          <div className={styles.formHdrIcon}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </div>
          <div>
            <div className={styles.formHdrTitle}>{editingId ? 'Edit Activity' : 'Log New Activity'}</div>
            <div className={styles.formHdrSub}>Fill in the details below to save or send to WhatsApp</div>
          </div>
        </div>

        <div className={styles.formBody}>
          {/* Location */}
          <div className={styles.formSection}>
            <div className={styles.secLabel}>Location</div>
            <div className={styles.grid3}>
              <div className={styles.field}>
                <label>Project</label>
                <select value={project} onChange={e => setProject(e.target.value)}>
                  {FIN_PROJECTS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className={styles.field}>
                <label>Section</label>
                <select
                  value={sectionId}
                  onChange={e => {
                    const opt = e.target.options[e.target.selectedIndex];
                    setSectionId(e.target.value);
                    setSectionLabel(opt.text || '');
                  }}
                >
                  <option value="">{sections.length === 0 ? '— Select project first —' : '— Select section —'}</option>
                  {sections.map(s => {
                    const lbl = s.section_label || s.section_name || '';
                    return <option key={s.id} value={s.id}>{lbl}</option>;
                  })}
                </select>
              </div>
              <div className={styles.field}>
                <label>Date</label>
                <input type="date" value={date} onChange={e => setDate(e.target.value)} />
              </div>
            </div>
            <div className={styles.grid2}>
              <div className={styles.field}>
                <label>Site ID</label>
                <div
                  className={styles.siteTagsWrap}
                  onClick={() => siteInputRef.current?.focus()}
                >
                  {siteTags.map((tag, i) => (
                    <span key={i} className={styles.siteTag}>
                      {tag}
                      <button type="button" onClick={e => { e.stopPropagation(); removeSiteTag(i); }}>×</button>
                    </span>
                  ))}
                  <input
                    ref={siteInputRef}
                    className={styles.siteInput}
                    type="text"
                    placeholder={siteTags.length ? '' : 'Type/select a site, Enter to add…'}
                    value={siteInput}
                    list="da-site-list"
                    autoComplete="off"
                    onChange={e => {
                      setSiteInput(e.target.value);
                      autoFillGovernate(e.target.value.trim());
                    }}
                    onKeyDown={siteKeydown}
                    onBlur={commitSiteInput}
                  />
                  <datalist id="da-site-list">
                    {siteOptions.map(o => <option key={o} value={o} />)}
                  </datalist>
                </div>
              </div>
              <div className={styles.field}>
                <label>Governate</label>
                <input
                  type="text"
                  placeholder="Auto-fills or type new…"
                  value={governate}
                  onChange={e => setGovernate(e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Activity */}
          <div className={styles.formSection}>
            <div className={styles.secLabel}>Activity</div>
            <div className={styles.grid3}>
              <div className={styles.field}>
                <label>Activity Type</label>
                <select value={activityType} onChange={e => setActivityType(e.target.value)}>
                  {ACTIVITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className={styles.field}>
                <label>Status</label>
                <select value={status} onChange={e => setStatus(e.target.value)}>
                  {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className={styles.field}>
                <label>Notes</label>
                <textarea
                  placeholder="Describe the work done…"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Team Members */}
          <div className={styles.formSection}>
            <div className={styles.secLabel}>Team Members</div>
            <div className={styles.teamChipsWrap}>
              {loading ? (
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading…</span>
              ) : teamMembers.length === 0 ? (
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>No active team members</span>
              ) : teamMembers.map(m => {
                const isBusy = busyIds.has(m.id);
                const isChecked = selectedMemberIds.has(m.id);
                return (
                  <label
                    key={m.id}
                    className={`${styles.teamChip} ${isBusy ? styles.chipBusy : ''} ${isChecked ? styles.chipSelected : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleMember(m.id, m.full_name, isBusy, busyInfo[m.id] || [])}
                    />
                    <span className={styles.chipAv}>{initials(m.full_name)}</span>
                    <span className={styles.chipName}>{m.full_name}</span>
                    {isBusy && <span className={styles.chipBusyTag}>Assigned</span>}
                  </label>
                );
              })}
            </div>
          </div>

          {/* Actions */}
          <div className={styles.formActions}>
            <button className={styles.btnPrimary} onClick={save} disabled={saving}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                <polyline points="17 21 17 13 7 13 7 21"/>
                <polyline points="7 3 7 8 15 8"/>
              </svg>
              {saving ? 'Saving…' : editingId ? 'Update Activity' : 'Save Activity'}
            </button>
            {editingId && (
              <button className={styles.btnGhost} onClick={cancelEdit}>Cancel Edit</button>
            )}
            <button className={`${styles.btnGhost} ${styles.btnWa}`} onClick={sendWa}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
              </svg>
              Send to WhatsApp
            </button>
          </div>
        </div>
      </div>

      {/* ── History Table ── */}
      <div className={styles.historyCard}>
        <div className={styles.historyHdr}>
          <div className={styles.historyTitle}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            Activity History
            <span className={styles.countBadge}>{total} records</span>
          </div>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Project</th>
                <th>Site ID</th>
                <th>Governate</th>
                <th>Team</th>
                <th>Activity</th>
                <th>Status</th>
                <th>Issued By</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className={styles.empty}>Loading…</td></tr>
              ) : activities.length === 0 ? (
                <tr><td colSpan={9} className={styles.empty}>No activities yet.</td></tr>
              ) : activities.map(a => {
                const teamNames = Array.isArray(a.team_member_names) ? a.team_member_names.join(', ') : (a.team_member_names || '');
                const updatedTitle = a.is_edited
                  ? `Updated by ${a.updated_by || 'Unknown'}${a.updated_at ? ' on ' + new Date(a.updated_at).toLocaleString() : ''} — ${a.edit_reason || 'No reason provided'}`
                  : '';
                return (
                  <tr key={a.id} className={a.is_edited ? styles.rowUpdated : ''}>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--slate-500)' }}>{fmtDate(a.date)}</td>
                    <td style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-700)' }}>{a.project || ''}</td>
                    <td><span className={styles.siteBadge} title={a.site_id || ''}>{a.site_id || '—'}</span></td>
                    <td style={{ fontSize: 13 }}>{a.governate || ''}</td>
                    <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--slate-500)' }} title={teamNames}>{teamNames || '—'}</td>
                    <td style={{ fontSize: 13 }}>{a.activity_type || ''}</td>
                    <td>
                      {statusPill(a.status)}
                      {a.is_edited && <span className={styles.updatedBadge} title={updatedTitle}>Updated</span>}
                    </td>
                    <td style={{ fontSize: 12.5, color: 'var(--slate-600)' }}>{a.created_by || '—'}</td>
                    <td>
                      <div className={styles.actBtns}>
                        <button className={styles.actBtn} title="Edit" onClick={() => startEdit(a)}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2.2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>
                          </svg>
                        </button>
                        <button className={styles.actBtn} title="View" onClick={() => setViewActivity(a)}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2.2">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                          </svg>
                        </button>
                        <button className={styles.actBtn} title="Share via WhatsApp" onClick={() => shareWa(a)}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.2">
                            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
                          </svg>
                        </button>
                        <button className={styles.actBtn} title="Delete" onClick={() => deleteActivity(a.id)}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2.2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6l-1 14H6L5 6"/>
                            <path d="M10 11v6"/><path d="M14 11v6"/>
                            <path d="M9 6V4h6v2"/>
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Reason Modal ── */}
      {reasonModal && (
        <div className={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) cancelReason(); }}>
          <div className={styles.modal}>
            <p className={styles.modalTitle}>Reason for Update</p>
            <p className={styles.modalSub}>Provide a mandatory reason before saving the edit.</p>
            <input
              className={styles.modalInput}
              type="text"
              placeholder="e.g. Corrected site ID…"
              value={reasonVal}
              autoFocus
              onChange={e => { setReasonVal(e.target.value); setReasonErr(false); }}
              onKeyDown={e => { if (e.key === 'Enter') confirmReason(); if (e.key === 'Escape') cancelReason(); }}
            />
            <div className={styles.modalErr}>{reasonErr ? 'A reason is required.' : ''}</div>
            <div className={styles.modalActions}>
              <button className={styles.btnGhost} onClick={cancelReason}>Cancel</button>
              <button className={styles.btnPrimary} onClick={confirmReason}>Confirm Update</button>
            </div>
          </div>
        </div>
      )}

      {/* ── View Modal ── */}
      {viewActivity && (
        <div className={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setViewActivity(null); }}>
          <div className={styles.modal} style={{ width: 500 }}>
            <p className={styles.modalTitle}>Activity Detail</p>
            <div className={styles.viewGrid}>
              <div className={styles.viewRow}>
                <span className={styles.viewLabel}>Date</span>
                <span className={styles.viewValue}>{viewActivity.date ? fmtDate(viewActivity.date) : '—'}</span>
              </div>
              <div className={styles.viewRow}>
                <span className={styles.viewLabel}>Project</span>
                <span className={styles.viewValue}>{viewActivity.project || '—'}</span>
              </div>
              <div className={styles.viewRow}>
                <span className={styles.viewLabel}>Site ID</span>
                <span className={styles.viewValue}>{viewActivity.site_id || '—'}</span>
              </div>
              <div className={styles.viewRow}>
                <span className={styles.viewLabel}>Governate</span>
                <span className={styles.viewValue}>{viewActivity.governate || '—'}</span>
              </div>
              <div className={styles.viewRow}>
                <span className={styles.viewLabel}>Activity</span>
                <span className={styles.viewValue}>{viewActivity.activity_type || '—'}</span>
              </div>
              <div className={styles.viewRow}>
                <span className={styles.viewLabel}>Status</span>
                <span className={styles.viewValue}>{statusPill(viewActivity.status)}</span>
              </div>
              <div className={`${styles.viewRow} ${styles.viewRowFull}`}>
                <span className={styles.viewLabel}>Team</span>
                <span className={styles.viewValue}>
                  {Array.isArray(viewActivity.team_member_names) ? viewActivity.team_member_names.join(', ') : (viewActivity.team_member_names || '—')}
                </span>
              </div>
              <div className={`${styles.viewRow} ${styles.viewRowFull}`}>
                <span className={styles.viewLabel}>Notes</span>
                <span className={styles.viewValue}>{viewActivity.notes || '—'}</span>
              </div>
              <div className={styles.viewRow}>
                <span className={styles.viewLabel}>Issued By</span>
                <span className={styles.viewValue}>{viewActivity.created_by || '—'}</span>
              </div>
            </div>
            {viewActivity.is_edited && (
              <div className={styles.viewEditNote}>
                ✏️ Last updated by {viewActivity.updated_by || '—'}
                {viewActivity.updated_at ? ' on ' + new Date(viewActivity.updated_at).toLocaleString() : ''}
                <br />📌 Reason: {viewActivity.edit_reason || '—'}
              </div>
            )}
            <div className={styles.modalActions} style={{ marginTop: 16 }}>
              <button className={styles.btnGhost} onClick={() => shareWa(viewActivity)}>
                Share WhatsApp
              </button>
              <button className={styles.btnPrimary} onClick={() => setViewActivity(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
