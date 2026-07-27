import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { logActivity } from '../lib/activityLog';
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
  role: string | null;
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

const AVATAR_COLORS = [
  { bg: '#dbeafe', fg: '#1e40af' },
  { bg: '#dcfce7', fg: '#166534' },
  { bg: '#fce7f3', fg: '#9d174d' },
  { bg: '#fef3c7', fg: '#92400e' },
  { bg: '#ede9fe', fg: '#5b21b6' },
  { bg: '#cffafe', fg: '#155e75' },
  { bg: '#ffe4e6', fg: '#9f1239' },
  { bg: '#e0e7ff', fg: '#3730a3' },
];

function avatarColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
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
  const { currentUser, hasPerm } = useAuth();

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
  const [memberSearch, setMemberSearch] = useState('');

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
  const memberSearchInputRef = useRef<HTMLInputElement>(null);
  const [memberDropdownOpen, setMemberDropdownOpen] = useState(false);

  // Inline form validation + unsaved-changes tracking
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formTouched, setFormTouched] = useState(false);
  const suppressDirty = useRef(true);

  // History table: search / filters / sort / pagination — initial values read from the URL
  // so filters survive a refresh or can be shared as a link.
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchQuery, setSearchQuery] = useState(() => searchParams.get('q') || '');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(() => searchParams.get('q') || '');
  const [filterProject, setFilterProject] = useState(() => searchParams.get('project') || 'All');
  const [filterStatus, setFilterStatus] = useState(() => searchParams.get('status') || 'All');
  const [dateFrom, setDateFrom] = useState(() => searchParams.get('from') || '');
  const [dateTo, setDateTo] = useState(() => searchParams.get('to') || '');
  const [sortColumn, setSortColumn] = useState<'date' | 'project' | 'status'>(() => {
    const s = searchParams.get('sort');
    return s === 'project' || s === 'status' ? s : 'date';
  });
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(() => (searchParams.get('dir') === 'asc' ? 'asc' : 'desc'));
  const [currentPage, setCurrentPage] = useState(() => Number(searchParams.get('page')) || 1);
  const [rowsPerPage, setRowsPerPage] = useState(() => Number(searchParams.get('rows')) || 10);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [filterActivityType, setFilterActivityType] = useState(() => searchParams.get('type') || 'All');
  const [filterIssuedBy, setFilterIssuedBy] = useState(() => searchParams.get('issuedBy') || '');

  // Debounce the search box so filtering doesn't re-run on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearchQuery(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearchQuery, filterProject, filterStatus, dateFrom, dateTo, rowsPerPage, filterActivityType, filterIssuedBy]);

  // Keep the URL query string in sync with the current filter/sort/page state.
  useEffect(() => {
    const params: Record<string, string> = {};
    if (searchQuery) params.q = searchQuery;
    if (filterProject !== 'All') params.project = filterProject;
    if (filterStatus !== 'All') params.status = filterStatus;
    if (dateFrom) params.from = dateFrom;
    if (dateTo) params.to = dateTo;
    if (sortColumn !== 'date') params.sort = sortColumn;
    if (sortDir !== 'desc') params.dir = sortDir;
    if (currentPage !== 1) params.page = String(currentPage);
    if (rowsPerPage !== 10) params.rows = String(rowsPerPage);
    if (filterActivityType !== 'All') params.type = filterActivityType;
    if (filterIssuedBy) params.issuedBy = filterIssuedBy;
    setSearchParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, filterProject, filterStatus, dateFrom, dateTo, sortColumn, sortDir, currentPage, rowsPerPage, filterActivityType, filterIssuedBy]);

  // Warn before leaving the page if the New Activity form has unsaved edits.
  useEffect(() => {
    function handler(e: BeforeUnloadEvent) {
      if (formTouched) {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [formTouched]);

  // Mark the form dirty whenever a field changes (skipping resets/edits-loads).
  useEffect(() => {
    if (suppressDirty.current) { suppressDirty.current = false; return; }
    setFormTouched(true);
  }, [date, project, sectionId, siteTags, siteInput, governate, activityType, status, notes, selectedMemberIds]);

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
    const { data } = await supabase.from('team_members').select('id,full_name,username,is_active,role');
    setTeamMembers((data || []).filter((m: TeamMember) => m.is_active !== false));
  }

  // Small sign shown on a member's avatar to flag Engineer vs Technician.
  function roleSign(role: string | null | undefined): { label: string; title: string; className: string } | null {
    if (!role) return null;
    const r = role.toLowerCase();
    if (r.includes('engineer')) return { label: 'E', title: role, className: styles.roleDotEngineer };
    if (r.includes('tech')) return { label: 'T', title: role, className: styles.roleDotTech };
    return null;
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

  // ── Inline field validation ──
  function validateForm(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (!date) errs.date = 'Date is required.';
    if (!project) errs.project = 'Project is required.';
    const hasSite = siteTags.length > 0 || siteInput.trim().length > 0;
    if (!hasSite) errs.site_id = 'At least one Site ID is required.';
    if (!activityType) errs.activityType = 'Activity type is required.';
    if (!status) errs.status = 'Status is required.';
    return errs;
  }

  // ── Save ──
  async function save() {
    const errs = validateForm();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      showToast('Please fix the highlighted fields.', false);
      return;
    }

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
    suppressDirty.current = true;
    setFormTouched(false);
    setFieldErrors({});
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
    setMemberSearch('');
  }

  // ── Edit ──
  function startEdit(a: DailyActivity) {
    suppressDirty.current = true;
    setFormTouched(false);
    setFieldErrors({});
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
    setMemberSearch('');
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
    const a = activities.find(x => x.id === id);
    // Delete trip participants first (no guarantee of cascade), then trip, then activity
    const { data: trip } = await supabase.from('field_trips').select('id').eq('daily_activity_id', id).single();
    if (trip?.id) {
      await supabase.from('trip_participants').delete().eq('trip_id', trip.id);
      await supabase.from('field_trips').delete().eq('id', trip.id);
    }
    const { error } = await supabase.from('daily_activities').delete().eq('id', id);
    if (error) { showToast(error.message, false); return; }
    setActivities(prev => prev.filter(x => x.id !== id));
    showToast('Deleted.', true);
    logActivity({
      userFullName: currentUser?.full_name ?? currentUser?.username,
      action: 'Deleted Daily Activity',
      projectName: a?.project,
      details: `Deleted activity: ${a?.project || '—'} — ${a?.activity_type || '—'} (${a?.date || '—'})`,
    });
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

  // ── Field-role scoping: Engineer/Technician only see activities they're
  // assigned to, matched the same way MyTrips.tsx resolves the current
  // user's team_members record (by full_name/username), not full company data.
  const roleLower = (currentUser?.role || '').toLowerCase();
  const isFieldRole = roleLower === 'engineer' || roleLower === 'technician';
  const myMemberId = (() => {
    if (!isFieldRole || !currentUser) return null;
    const name = (currentUser.full_name || '').trim().toLowerCase();
    const uname = (currentUser.username || '').trim().toLowerCase();
    const match = teamMembers.find(m =>
      (name && m.full_name?.trim().toLowerCase() === name) ||
      (uname && m.username?.trim().toLowerCase() === uname),
    );
    return match?.id ?? null;
  })();
  const visibleActivities = isFieldRole
    ? activities.filter(a => Array.isArray(a.team_member_ids) && !!myMemberId && a.team_member_ids.includes(myMemberId))
    : activities;

  // ── KPI counts ──
  const total = visibleActivities.length;
  const completed = visibleActivities.filter(a => a.status === 'Completed').length;
  const inProg = visibleActivities.filter(a => a.status === 'In Progress').length;
  const blocked = visibleActivities.filter(a => a.status === 'Blocked').length;
  const pct = (n: number) => total > 0 ? Math.round((n / total) * 100) : 0;

  const { busyIds, busyInfo } = getBusyMap();

  const filteredNonSelected = teamMembers
    .filter(m => !selectedMemberIds.has(m.id) && m.full_name.toLowerCase().includes(memberSearch.trim().toLowerCase()));

  function getSiteLabel(tag: string): string {
    const rowData = siteDataMap[tag];
    if (!rowData) return tag;
    const keys = Object.keys(rowData);
    const nameKey = keys.find(k => /^site[\s._-]*name$/i.test(k) || /^name$/i.test(k));
    if (nameKey) {
      const name = String(rowData[nameKey]).trim();
      if (name && name !== 'undefined' && name !== 'null') return `${tag} – ${name}`;
    }
    return tag;
  }

  function statusPill(s: string | null) {
    if (s === 'Completed') return <span className={`${styles.pill} ${styles.pillDone}`}><span className={styles.dot} />{s}</span>;
    if (s === 'In Progress') return <span className={`${styles.pill} ${styles.pillInprog}`}><span className={styles.dot} />{s}</span>;
    if (s === 'Blocked') return <span className={`${styles.pill} ${styles.pillBlocked}`}><span className={styles.dot} />{s}</span>;
    return <span className={styles.pill}>{s || '—'}</span>;
  }

  function teamAvatars(names: string[] | null) {
    const list = Array.isArray(names) ? names.filter(Boolean) : [];
    if (list.length === 0) return <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>;
    const shown = list.slice(0, 3);
    const extra = list.length - shown.length;
    return (
      <div className={styles.teamAvatars}>
        {shown.map((n, i) => {
          const c = avatarColor(n);
          return (
            <span key={i} className={styles.teamAvatar} style={{ background: c.bg, color: c.fg }} title={n}>
              {initials(n)}
            </span>
          );
        })}
        {extra > 0 && <span className={styles.teamAvatarMore} title={list.slice(3).join(', ')}>+{extra}</span>}
      </div>
    );
  }

  // ── History table: filter → sort → paginate ──
  const issuedByOptions = Array.from(
    new Set(visibleActivities.map(a => (a.created_by || '').trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));

  const filteredActivities = visibleActivities.filter(a => {
    if (filterProject !== 'All' && a.project !== filterProject) return false;
    if (filterStatus !== 'All' && a.status !== filterStatus) return false;
    if (filterActivityType !== 'All' && a.activity_type !== filterActivityType) return false;
    if (filterIssuedBy && a.created_by !== filterIssuedBy) return false;
    if (dateFrom && a.date < dateFrom) return false;
    if (dateTo && a.date > dateTo) return false;
    if (debouncedSearchQuery.trim()) {
      const q = debouncedSearchQuery.trim().toLowerCase();
      const teamNames = Array.isArray(a.team_member_names) ? a.team_member_names.join(' ') : '';
      const haystack = [a.project, a.site_id, a.governate, a.activity_type, teamNames, a.notes, a.created_by]
        .filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const sortedActivities = [...filteredActivities].sort((a, b) => {
    let cmp = 0;
    if (sortColumn === 'project') {
      cmp = (a.project || '').localeCompare(b.project || '');
    } else if (sortColumn === 'status') {
      cmp = (a.status || '').localeCompare(b.status || '');
    } else {
      cmp = a.date === b.date
        ? new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        : (a.date < b.date ? -1 : 1);
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const totalPages = Math.max(1, Math.ceil(sortedActivities.length / rowsPerPage));
  const safePage = Math.min(currentPage, totalPages);
  const pageStart = (safePage - 1) * rowsPerPage;
  const pagedActivities = sortedActivities.slice(pageStart, pageStart + rowsPerPage);
  const hasActiveFilters = !!(searchQuery || filterProject !== 'All' || filterStatus !== 'All' || dateFrom || dateTo || filterActivityType !== 'All' || filterIssuedBy);
  const hasAdvancedFilters = filterActivityType !== 'All' || !!filterIssuedBy;

  function clearFilters() {
    setSearchQuery('');
    setFilterProject('All');
    setFilterStatus('All');
    setDateFrom('');
    setDateTo('');
    setFilterActivityType('All');
    setFilterIssuedBy('');
  }

  function toggleSort(col: 'date' | 'project' | 'status') {
    if (sortColumn === col) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(col);
      setSortDir('asc');
    }
  }

  function sortIndicator(col: 'date' | 'project' | 'status') {
    if (sortColumn !== col) return null;
    return (
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 4, transform: sortDir === 'asc' ? 'rotate(180deg)' : 'none' }}>
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    );
  }

  // ── Date range quick presets ──
  function applyDatePreset(preset: 'today' | 'week' | 'month') {
    const now = new Date();
    if (preset === 'today') {
      const t = today();
      setDateFrom(t);
      setDateTo(t);
    } else if (preset === 'week') {
      const day = now.getDay();
      const diffToMonday = day === 0 ? -6 : 1 - day;
      const monday = new Date(now);
      monday.setDate(now.getDate() + diffToMonday);
      setDateFrom(monday.toISOString().split('T')[0]);
      setDateTo(today());
    } else {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      setDateFrom(first.toISOString().split('T')[0]);
      setDateTo(today());
    }
  }

  // ── Excel export of the currently filtered/sorted results ──
  function exportCsv() {
    const data = sortedActivities.map(a => ({
      'Date': a.date ? fmtDate(a.date) : '',
      'Project': a.project || '',
      'Site ID': a.site_id || '',
      'Governorate': a.governate || '',
      'Team': Array.isArray(a.team_member_names) ? a.team_member_names.join('; ') : '',
      'Activity': a.activity_type || '',
      'Status': a.status || '',
      'Issued By': a.created_by || '',
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [
      { wch: 12 }, { wch: 16 }, { wch: 20 }, { wch: 16 },
      { wch: 28 }, { wch: 16 }, { wch: 14 }, { wch: 18 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Daily Activities');
    XLSX.writeFile(wb, `Daily_Activities_${today()}.xlsx`);
  }

  // ── Active filter chips ──
  const activeFilterChips: { key: string; label: string; onRemove: () => void }[] = [];
  if (searchQuery) activeFilterChips.push({ key: 'q', label: `Search: "${searchQuery}"`, onRemove: () => setSearchQuery('') });
  if (filterProject !== 'All') activeFilterChips.push({ key: 'project', label: filterProject, onRemove: () => setFilterProject('All') });
  if (filterStatus !== 'All') activeFilterChips.push({ key: 'status', label: filterStatus, onRemove: () => setFilterStatus('All') });
  if (dateFrom || dateTo) activeFilterChips.push({
    key: 'date',
    label: `${dateFrom ? fmtDate(dateFrom) : '…'} → ${dateTo ? fmtDate(dateTo) : '…'}`,
    onRemove: () => { setDateFrom(''); setDateTo(''); },
  });
  if (filterActivityType !== 'All') activeFilterChips.push({ key: 'type', label: filterActivityType, onRemove: () => setFilterActivityType('All') });
  if (filterIssuedBy) activeFilterChips.push({ key: 'issuedBy', label: `By: ${filterIssuedBy}`, onRemove: () => setFilterIssuedBy('') });

  const pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1)
    .filter(p => p === 1 || p === totalPages || Math.abs(p - safePage) <= 1);

  if (!hasPerm('view_daily_activities')) {
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
      {toast && (
        <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`}>
          {toast.msg}
        </div>
      )}

      {/* ── Page Header ── */}
      <div className={styles.pageHdr}>
        <div className={styles.pageTitleBlock}>
          <h1 className={styles.pageTitle}>Daily Activities</h1>
          <p className={styles.pageTitleSub}>Plan, assign and track field activities</p>
        </div>
        <div className={styles.hdrActions}>
          {hasPerm('add_rows') && (
            <button
              className={styles.btnNewActivity}
              onClick={() => {
                setEditingId(null);
                resetForm();
                formCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              New Activity
            </button>
          )}
        </div>
      </div>

      {/* ── KPI Row ── */}
      <div className={styles.kpiRow}>
        <div className={`${styles.kpiCard} ${styles.kpiBlue}`}>
          <div className={styles.kpiIcon}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2">
              <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
              <rect x="9" y="3" width="6" height="4" rx="2"/>
              <line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>
            </svg>
          </div>
          <div>
            <div className={styles.kpiLabel}>Total Activities</div>
            <div className={styles.kpiValue}>{loading ? '—' : total}</div>
            <div className={styles.kpiSub}>All recorded activities</div>
          </div>
        </div>
        <div className={`${styles.kpiCard} ${styles.kpiGreen}`}>
          <div className={styles.kpiIcon}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </div>
          <div>
            <div className={styles.kpiLabel}>Completed</div>
            <div className={styles.kpiValue}>{loading ? '—' : completed}</div>
            <div className={styles.kpiSub}>{loading || total === 0 ? '—' : `${pct(completed)}% of total activities`}</div>
          </div>
        </div>
        <div className={`${styles.kpiCard} ${styles.kpiAmber}`}>
          <div className={styles.kpiIcon}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
          </div>
          <div>
            <div className={styles.kpiLabel}>In Progress</div>
            <div className={styles.kpiValue}>{loading ? '—' : inProg}</div>
            <div className={styles.kpiSub}>{loading || total === 0 ? '—' : `${pct(inProg)}% of total activities`}</div>
          </div>
        </div>
        <div className={`${styles.kpiCard} ${styles.kpiRed}`}>
          <div className={styles.kpiIcon}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          </div>
          <div>
            <div className={styles.kpiLabel}>Blocked</div>
            <div className={styles.kpiValue}>{loading ? '—' : blocked}</div>
            <div className={styles.kpiSub}>{loading || total === 0 ? '—' : `${pct(blocked)}% of total activities`}</div>
          </div>
        </div>
      </div>

      {/* ── Form Card (create needs add_rows, editing an existing row needs
          edit_rows — same gating pattern as Sites DB / NetworkScopes.tsx) ── */}
      {(hasPerm('add_rows') || hasPerm('edit_rows')) && (
      <div className={styles.formCard} ref={formCardRef}>
        <div className={styles.formHdr}>
          <div className={styles.formHdrIcon}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2">
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
              <path d="M9 12l2 2 4-4"/>
            </svg>
          </div>
          <div>
            <div className={styles.formHdrTitle}>{editingId ? 'Edit Activity' : 'New Activity'}</div>
            <div className={styles.formHdrSub}>{editingId ? 'Fill in the details below to save or send to WhatsApp' : 'Create, assign and share a field activity'}</div>
          </div>
        </div>

        <div className={styles.formBody}>
          <div className={styles.formCardsGrid}>

            {/* ── Sub-card 1: Location & Scope ── */}
            <div className={styles.subCard}>
              <div className={styles.subCardHdr}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                  <circle cx="12" cy="10" r="3"/>
                </svg>
                <div className={styles.subCardTitle}>Location & Scope</div>
              </div>
              <div className={styles.subCardBody}>
                <div className={styles.fieldsGrid}>
                  <div className={styles.field}>
                    <label>Project <span className={styles.req}>*</span></label>
                    <select
                      className={fieldErrors.project ? styles.inputError : ''}
                      value={project}
                      onChange={e => { setProject(e.target.value); setFieldErrors(fe => ({ ...fe, project: '' })); }}
                    >
                      {FIN_PROJECTS.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                    {fieldErrors.project && <span className={styles.fieldErrMsg}>{fieldErrors.project}</span>}
                  </div>
                  <div className={styles.field}>
                    <label>Section <span className={styles.req}>*</span></label>
                    <select
                      value={sectionId}
                      onChange={e => {
                        const opt = e.target.options[e.target.selectedIndex];
                        setSectionId(e.target.value);
                        setSectionLabel(opt.text || '');
                      }}
                    >
                      <option value="">{sections.length === 0 ? 'Select project first' : 'Select section'}</option>
                      {sections.map(s => {
                        const lbl = s.section_label || s.section_name || '';
                        return <option key={s.id} value={s.id}>{lbl}</option>;
                      })}
                    </select>
                  </div>
                  <div className={styles.field}>
                    <label>Site ID <span className={styles.req}>*</span></label>
                    <div
                      className={`${styles.siteTagsWrap} ${fieldErrors.site_id ? styles.inputError : ''}`}
                      onClick={() => siteInputRef.current?.focus()}
                    >
                      {siteTags.map((tag, i) => (
                        <span key={i} className={styles.siteTag}>
                          {getSiteLabel(tag)}
                          <button type="button" onClick={e => { e.stopPropagation(); removeSiteTag(i); }}>×</button>
                        </span>
                      ))}
                      <input
                        ref={siteInputRef}
                        className={styles.siteInput}
                        type="text"
                        placeholder={siteTags.length ? '' : 'Search or add a site…'}
                        value={siteInput}
                        list="da-site-list"
                        autoComplete="off"
                        onChange={e => {
                          setSiteInput(e.target.value);
                          autoFillGovernate(e.target.value.trim());
                          setFieldErrors(fe => ({ ...fe, site_id: '' }));
                        }}
                        onKeyDown={siteKeydown}
                        onBlur={commitSiteInput}
                      />
                      <datalist id="da-site-list">
                        {siteOptions.map(o => <option key={o} value={o} />)}
                      </datalist>
                      <svg className={styles.siteChevron} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <polyline points="6 9 12 15 18 9"/>
                      </svg>
                    </div>
                    {fieldErrors.site_id && <span className={styles.fieldErrMsg}>{fieldErrors.site_id}</span>}
                  </div>
                  <div className={styles.field}>
                    <label>Governorate</label>
                    <input
                      type="text"
                      placeholder="Auto-fills…"
                      value={governate}
                      onChange={e => setGovernate(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* ── Sub-card 2: Work Details ── */}
            <div className={styles.subCard}>
              <div className={styles.subCardHdr}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/>
                  <line x1="16" y1="17" x2="8" y2="17"/>
                </svg>
                <div className={styles.subCardTitle}>Work Details</div>
              </div>
              <div className={styles.subCardBody}>
                <div className={styles.fieldsGrid}>
                  <div className={styles.field}>
                    <label>Date <span className={styles.req}>*</span></label>
                    <input
                      className={fieldErrors.date ? styles.inputError : ''}
                      type="date"
                      value={date}
                      onChange={e => { setDate(e.target.value); setFieldErrors(fe => ({ ...fe, date: '' })); }}
                    />
                    {fieldErrors.date && <span className={styles.fieldErrMsg}>{fieldErrors.date}</span>}
                  </div>
                  <div className={styles.field}>
                    <label>Activity Type <span className={styles.req}>*</span></label>
                    <select
                      className={fieldErrors.activityType ? styles.inputError : ''}
                      value={activityType}
                      onChange={e => { setActivityType(e.target.value); setFieldErrors(fe => ({ ...fe, activityType: '' })); }}
                    >
                      {ACTIVITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    {fieldErrors.activityType && <span className={styles.fieldErrMsg}>{fieldErrors.activityType}</span>}
                  </div>
                  <div className={styles.field}>
                    <label>Status <span className={styles.req}>*</span></label>
                    <select
                      className={fieldErrors.status ? styles.inputError : ''}
                      value={status}
                      onChange={e => { setStatus(e.target.value); setFieldErrors(fe => ({ ...fe, status: '' })); }}
                    >
                      {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    {fieldErrors.status && <span className={styles.fieldErrMsg}>{fieldErrors.status}</span>}
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
            </div>

            {/* ── Sub-card 3: Team Members ── */}
            <div className={styles.subCard}>
              <div className={styles.subCardHdr}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                  <circle cx="9" cy="7" r="4"/>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                  <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                </svg>
                <div className={styles.subCardTitle}>Team Members</div>
              </div>
              <div className={styles.subCardBody}>
                <div
                  className={styles.memberSearchWrap}
                  onClick={() => memberSearchInputRef.current?.focus()}
                >
                  <svg className={styles.memberSearchIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  </svg>
                  <input
                    ref={memberSearchInputRef}
                    className={styles.memberSearchInput}
                    type="text"
                    placeholder="Search team members…"
                    value={memberSearch}
                    onFocus={() => setMemberDropdownOpen(true)}
                    onBlur={() => setTimeout(() => setMemberDropdownOpen(false), 150)}
                    onChange={e => setMemberSearch(e.target.value)}
                  />
                  <svg className={styles.memberSearchChevron} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </div>

                {(memberDropdownOpen || memberSearch.trim()) && (
                  <div className={styles.memberSearchResults}>
                    {filteredNonSelected.length === 0 ? (
                      <div className={styles.memberSearchEmpty}>No members found</div>
                    ) : filteredNonSelected.map(m => {
                      const isBusy = busyIds.has(m.id);
                      const rb = roleSign(m.role);
                      return (
                        <div
                          key={m.id}
                          className={styles.memberSearchRow}
                          onClick={() => {
                            toggleMember(m.id, m.full_name, isBusy, busyInfo[m.id] || []);
                            setMemberSearch('');
                          }}
                        >
                          <span className={styles.chipAv}>
                            {initials(m.full_name)}
                            {rb && <span className={`${styles.roleDot} ${rb.className}`} title={rb.title}>{rb.label}</span>}
                          </span>
                          <span className={styles.memberSearchName}>{m.full_name}</span>
                          {isBusy && <span className={styles.chipBusyTag}>Assigned</span>}
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className={styles.memberMeta}>
                  <span className={styles.memberCount}>
                    {selectedMemberIds.size} member{selectedMemberIds.size !== 1 ? 's' : ''} selected
                  </span>
                  {selectedMemberIds.size > 0 && (
                    <button
                      type="button"
                      className={styles.clearAllBtn}
                      onClick={() => setSelectedMemberIds(new Set())}
                    >
                      Clear all
                    </button>
                  )}
                </div>

                <div className={styles.selectedChipsWrap}>
                  {selectedMemberIds.size === 0 ? (
                    <span className={styles.noSelectionHint}>Search above to add team members</span>
                  ) : [...selectedMemberIds].map(id => {
                    const member = teamMembers.find(m => m.id === id);
                    if (!member) return null;
                    const rb = roleSign(member.role);
                    return (
                      <span key={id} className={styles.selectedChip}>
                        <span className={styles.chipAv}>
                          {initials(member.full_name)}
                          {rb && <span className={`${styles.roleDot} ${rb.className}`} title={rb.title}>{rb.label}</span>}
                        </span>
                        <span className={styles.chipName}>{member.full_name}</span>
                        <button
                          type="button"
                          className={styles.chipRemoveBtn}
                          onClick={() => {
                            const next = new Set(selectedMemberIds);
                            next.delete(id);
                            setSelectedMemberIds(next);
                          }}
                        >×</button>
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>

          </div>{/* end formCardsGrid */}

          {/* ── Form Actions ── */}
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
      )}

      {/* ── History Table ── */}
      <div className={styles.historyCard}>
        <div className={styles.historyHdr}>
          <div className={styles.historyTitle}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            Activity History
            <span className={styles.countBadge}>{sortedActivities.length} records</span>
          </div>

          <div className={styles.historyToolbar}>
            <div className={styles.searchBox}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input
                type="text"
                placeholder="Search by site, project, team…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>
            <select className={styles.filterSelect} value={filterProject} onChange={e => setFilterProject(e.target.value)}>
              <option value="All">All Projects</option>
              {FIN_PROJECTS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <select className={styles.filterSelect} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="All">All Status</option>
              {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select
              className={styles.filterSelect}
              value=""
              title="Quick date range"
              onChange={e => { if (e.target.value) applyDatePreset(e.target.value as 'today' | 'week' | 'month'); }}
            >
              <option value="">Quick range</option>
              <option value="today">Today</option>
              <option value="week">This Week</option>
              <option value="month">This Month</option>
            </select>
            <div className={styles.dateRangeBox}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/>
                <line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
              <div className={styles.dateInputWrap}>
                <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
                {!dateFrom && <span className={styles.dateInputPlaceholder}>From</span>}
              </div>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={styles.dateRangeArrow}>
                <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
              </svg>
              <div className={styles.dateInputWrap}>
                <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
                {!dateTo && <span className={styles.dateInputPlaceholder}>To</span>}
              </div>
              {(dateFrom || dateTo) && (
                <button
                  type="button"
                  className={styles.dateRangeClearBtn}
                  title="Clear date range"
                  onClick={() => { setDateFrom(''); setDateTo(''); }}
                >×</button>
              )}
            </div>
            <button
              type="button"
              className={`${styles.filtersBtn} ${showAdvancedFilters || hasAdvancedFilters ? styles.filtersBtnActive : ''}`}
              onClick={() => setShowAdvancedFilters(v => !v)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
              </svg>
              Filters
              {hasAdvancedFilters && <span className={styles.filtersDot} />}
            </button>
            <button type="button" className={styles.exportBtn} title="Export filtered results as Excel" onClick={exportCsv}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Export
            </button>
            {hasActiveFilters && (
              <button type="button" className={styles.clearFiltersBtn} onClick={clearFilters}>
                Clear Filters
              </button>
            )}
          </div>
        </div>

        {activeFilterChips.length > 0 && (
          <div className={styles.activeFiltersRow}>
            {activeFilterChips.map(c => (
              <span key={c.key} className={styles.filterChip}>
                {c.label}
                <button type="button" onClick={c.onRemove} title="Remove filter">×</button>
              </span>
            ))}
          </div>
        )}

        {showAdvancedFilters && (
          <div className={styles.advancedFiltersRow}>
            <div className={styles.advFilterField}>
              <label>Activity Type</label>
              <select value={filterActivityType} onChange={e => setFilterActivityType(e.target.value)}>
                <option value="All">All Activity Types</option>
                {ACTIVITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className={styles.advFilterField}>
              <label>Issued By</label>
              <select value={filterIssuedBy} onChange={e => setFilterIssuedBy(e.target.value)}>
                <option value="">All Issuers</option>
                {issuedByOptions.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </div>
          </div>
        )}

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.sortableTh} onClick={() => toggleSort('date')}>
                  <span>Date{sortIndicator('date')}</span>
                </th>
                <th className={styles.sortableTh} onClick={() => toggleSort('project')}>
                  <span>Project{sortIndicator('project')}</span>
                </th>
                <th>Site ID</th>
                <th>Governorate</th>
                <th>Team</th>
                <th>Activity</th>
                <th className={styles.sortableTh} onClick={() => toggleSort('status')}>
                  <span>Status{sortIndicator('status')}</span>
                </th>
                <th>Issued By</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={`sk-${i}`} className={styles.skeletonRow}>
                    {Array.from({ length: 9 }).map((_, j) => (
                      <td key={j}><div className={styles.skeletonCell} /></td>
                    ))}
                  </tr>
                ))
              ) : pagedActivities.length === 0 ? (
                <tr><td colSpan={9} className={styles.empty}>{visibleActivities.length === 0 ? 'No activities yet.' : 'No activities match your filters.'}</td></tr>
              ) : pagedActivities.map(a => {
                const teamNames = Array.isArray(a.team_member_names) ? a.team_member_names : [];
                const updatedTitle = a.is_edited
                  ? `Updated by ${a.updated_by || 'Unknown'}${a.updated_at ? ' on ' + new Date(a.updated_at).toLocaleString() : ''} — ${a.edit_reason || 'No reason provided'}`
                  : '';
                const siteIds = (a.site_id || '').split(',').map(s => s.trim()).filter(Boolean);
                return (
                  <tr key={a.id} className={a.is_edited ? styles.rowUpdated : ''}>
                    <td data-label="Date" style={{ whiteSpace: 'nowrap' }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--slate-700)' }}>{fmtDate(a.date)}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                        {a.created_at ? new Date(a.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                      </div>
                    </td>
                    <td data-label="Project" style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-700)' }}>{a.project || ''}</td>
                    <td data-label="Site ID">
                      <div className={styles.siteBadges}>
                        {siteIds.length > 0
                          ? siteIds.map((s, i) => <span key={i} className={styles.siteBadge} title={s}>{s}</span>)
                          : <span className={styles.siteBadge}>—</span>}
                      </div>
                    </td>
                    <td data-label="Governorate" style={{ fontSize: 13 }}>{a.governate || '—'}</td>
                    <td data-label="Team">{teamAvatars(teamNames)}</td>
                    <td data-label="Activity" style={{ fontSize: 13 }}>{a.activity_type || ''}</td>
                    <td data-label="Status">
                      {statusPill(a.status)}
                      {a.is_edited && <span className={styles.updatedBadge} title={updatedTitle}>Updated</span>}
                    </td>
                    <td data-label="Issued By" style={{ fontSize: 12.5, color: 'var(--slate-600)' }}>{a.created_by || '—'}</td>
                    <td data-label="Actions">
                      <div className={styles.actBtns}>
                        {hasPerm('edit_rows') && (
                          <button className={`${styles.actBtn} ${styles.actBtnPurple}`} title="Edit" onClick={() => startEdit(a)}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2.2">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                              <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>
                            </svg>
                          </button>
                        )}
                        <button className={`${styles.actBtn} ${styles.actBtnBlue}`} title="View" onClick={() => setViewActivity(a)}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2.2">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                          </svg>
                        </button>
                        <button className={`${styles.actBtn} ${styles.actBtnGreen}`} title="Share via WhatsApp" onClick={() => shareWa(a)}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.2">
                            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
                          </svg>
                        </button>
                        {hasPerm('delete_rows') && (
                          <button className={`${styles.actBtn} ${styles.actBtnRed}`} title="Delete" onClick={() => deleteActivity(a.id)}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2.2">
                              <polyline points="3 6 5 6 21 6"/>
                              <path d="M19 6l-1 14H6L5 6"/>
                              <path d="M10 11v6"/><path d="M14 11v6"/>
                              <path d="M9 6V4h6v2"/>
                            </svg>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className={styles.paginationBar}>
          <div className={styles.paginationInfo}>
            {sortedActivities.length === 0
              ? 'No entries'
              : `Showing ${pageStart + 1} to ${Math.min(pageStart + rowsPerPage, sortedActivities.length)} of ${sortedActivities.length} entries`}
          </div>
          <div className={styles.paginationControls}>
            <select
              className={styles.rowsPerPageSelect}
              value={rowsPerPage}
              onChange={e => setRowsPerPage(Number(e.target.value))}
            >
              <option value={10}>10 per page</option>
              <option value={25}>25 per page</option>
              <option value={50}>50 per page</option>
            </select>
            <button
              type="button"
              className={styles.pageBtn}
              disabled={safePage <= 1}
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            >‹</button>
            {pageNumbers.map((p, idx) => (
              <span key={p} style={{ display: 'contents' }}>
                {idx > 0 && pageNumbers[idx - 1] !== p - 1 && <span className={styles.pageEllipsis}>…</span>}
                <button
                  type="button"
                  className={`${styles.pageBtn} ${p === safePage ? styles.pageBtnActive : ''}`}
                  onClick={() => setCurrentPage(p)}
                >{p}</button>
              </span>
            ))}
            <button
              type="button"
              className={styles.pageBtn}
              disabled={safePage >= totalPages}
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            >›</button>
          </div>
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
                <span className={styles.viewLabel}>Governorate</span>
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
