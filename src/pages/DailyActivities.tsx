import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { logActivity } from '../lib/activityLog';
import { ensureProjectsLoaded, getProjectNames, getProjectNameToKeyMap } from '../lib/projectsCache';
import { FIN_MONTHS, getYears } from '../lib/finHelpers';
import { ensureCarsLoaded, getCars, getCarOwnerId, getCarName, type CarMeta } from '../lib/carsCache';
import { ensureSavedPointsLoaded, getSavedPoints, type SavedPointMeta } from '../lib/savedPointsCache';
import { ensureCarKmRateLoaded, getCarKmRate } from '../lib/carSettingsCache';
import { getRoadRoute } from '../lib/roadRouting';
import { haversineKm } from '../lib/sitesNearest';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { addBaseLayer } from '../lib/mapboxTiles';
import { searchPlaces, type GeocodeResult } from '../lib/mapboxGeocoding';
import styles from './DailyActivities.module.css';

const ACTIVITY_TYPES = ['Installation', 'Maintenance', 'Survey', 'Testing', 'Commissioning', 'Integration', 'Clearance'];
const STATUS_OPTIONS = ['In Progress', 'Completed', 'Blocked'];

const ACTIVITY_TYPE_KEYS: Record<string, string> = {
  'Installation': 'da_type_installation',
  'Maintenance':  'da_type_maintenance',
  'Survey':       'da_type_survey',
  'Testing':      'da_type_testing',
  'Commissioning':'da_type_commissioning',
  'Integration':  'da_type_integration',
  'Clearance':    'da_type_clearance',
};

const STATUS_KEYS: Record<string, string> = {
  'Completed':   'da_completed',
  'In Progress': 'da_inProgress',
  'Blocked':     'da_blocked',
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
  car_id: string | null;
  driver_id: string | null;
  start_point_name: string | null;
  start_lat: number | null;
  start_lng: number | null;
  target_lat: number | null;
  target_lng: number | null;
  trip_stops: TripStopSaved[] | null;
  trip_legs: TripLegSaved[] | null;
  trip_distance_km: number | null;
  trip_rate_iqd: number | null;
  trip_cost_iqd: number | null;
  trip_distance_source: string | null;
  round_trip: boolean | null;
}

// A single destination leg of a car trip route, one per Site ID tag, in
// visit order — the full route is start point → stops[0] → stops[1] → …
interface TripStop {
  site: string;
  lat: string;
  lng: string;
  found: boolean | null;   // true = auto-filled from Sites DB, false = site not in Sites DB, null = not looked up yet
  manual: boolean;         // true once the user edits/map-picks this stop — blocks the Sites DB auto-fill from overwriting it
}

// Persisted shape of a stop inside daily_activities.trip_stops (jsonb).
interface TripStopSaved {
  site: string;
  lat: number;
  lng: number;
}

// Persisted shape of a leg inside daily_activities.trip_legs (jsonb) — one
// entry per consecutive pair of route points (start→stop1, stop1→stop2, …),
// so trip_legs.length === trip_stops.length. minutes is null when the leg
// only has a straight-line distance (no road-routing token/response).
interface TripLegSaved {
  distanceKm: number;
  minutes: number | null;
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

const ROLE_TAG_COLORS = [
  { bg: '#dbeafe', text: '#1e40af' },
  { bg: '#dcfce7', text: '#166534' },
  { bg: '#ffedd5', text: '#9a3412' },
  { bg: '#ede9fe', text: '#5b21b6' },
  { bg: '#fee2e2', text: '#991b1b' },
  { bg: '#ccfbf1', text: '#134e4a' },
  { bg: '#fef9c3', text: '#854d0e' },
  { bg: '#e0e7ff', text: '#3730a3' },
];

function avatarColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// Trip info for the WhatsApp "Car Trip Details" section — the route is
// rendered start → stop 1 → stop 2 → … just like the Route Planner shows a
// day's stop sequence, with the same total distance/rate/cost fields used
// throughout the Car Trip feature (see calcCarTrip()).
interface WaTripDetails {
  carType: string | null;
  driverName: string | null;
  startPointName: string | null;
  stopSites: string[];
  distanceKm: number | null;
  costIqd: number | null;
  rateIqd: number | null;
  source: 'road' | 'straight' | null;
  /** Point-to-point breakdown, one entry per leg (start→stop1, stop1→stop2,
   *  …). null/wrong-length falls back to a single "A → B → C" route line
   *  with no per-leg figures — covers activities saved before this field
   *  existed. */
  legs: { distanceKm: number; minutes: number | null }[] | null;
  /** True when the route includes a final leg back from the last stop to
   *  the start point (see calcCarTrip()) — used to append the start label
   *  again at the end of the Route line and show a "round trip" note. */
  roundTrip: boolean;
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
  trip?: WaTripDetails | null,
) {
  const d = date ? fmtDate(date) : '—';
  const projLine = sectionLabel && !sectionLabel.startsWith('—')
    ? `${project || '—'} / ${sectionLabel}`
    : (project || '—');
  const teamLines = teamNames.length
    ? teamNames.map(n => `  › ${n}`).join('\n')
    : '  › —';

  const tripBlock = trip && (trip.carType || trip.driverName)
    ? (() => {
        const startLabel = trip.startPointName?.trim() || 'Start';
        // Round trip: the final leg returns to the start point, so tack the
        // start label back on as the last waypoint — matches the extra leg
        // calcCarTrip() adds to trip_legs when roundTrip is on.
        const points = trip.roundTrip
          ? [startLabel, ...trip.stopSites, startLabel]
          : [startLabel, ...trip.stopSites];
        const legsValid = !!trip.legs && trip.legs.length === points.length - 1;
        const routeSection = legsValid
          ? `\n◆ *Route:*\n${trip.legs!.map((leg, i) => {
              const timePart = leg.minutes != null ? `, ${Math.round(leg.minutes)} min` : '';
              return `  ${points[i]} → ${points[i + 1]}  (${leg.distanceKm.toFixed(2)} km${timePart})`;
            }).join('\n')}`
          : `\n◆ *Route:* ${points.join(' → ')}${trip.roundTrip ? ' (round trip)' : ''}`;
        const distLine = trip.distanceKm != null
          ? `\n◆ *Total Distance:* ${trip.distanceKm.toFixed(2)} km${trip.source ? ` (${trip.source === 'road' ? 'Road' : 'Straight-line'})` : ''}`
          : '';
        // Rate/Cost are intentionally left out of the shared WhatsApp text
        // (still shown on-screen in the app's trip result box) — the report
        // is meant for operational/route info, not the expense amount.
        return `\n\n━━━━━━━━━━━━\n◆ *Car Trip Details*\n◆ *Car:* ${trip.carType || '—'}  |  ◆ *Driver:* ${trip.driverName || '—'}${routeSection}${distLine}`;
      })()
    : '';

  return `◆ *TAC Network Tracker*\n━━━━━━━━━━━━\n◆ *DAILY ACTIVITY REPORT*\n━━━━━━━━━━━━\n\n◆ *Date:* ${d}\n◆ *Project:* ${projLine}\n◆ *Site ID:* ${site_id || '—'}  |  ◆ *Gov:* ${governate || '—'}\n\n━━━━━━━━━━━━\n◆ *Team*\n${teamLines}\n\n◆ *Activity:* ${activityType || '—'}\n◆ *Status:* ${status || '—'}\n\n◆ *Notes*\n${notes || '—'}${tripBlock}\n━━━━━━━━━━━━\n_◆ TAC Network Operations Center_`;
}

// Car/driver info now lives only in the dedicated Car Trip fields and the
// WhatsApp "Car Trip Details" section (see buildWaMsg) — it is never
// written into the Notes/description text. This strips the old
// "—— Car Trip ——" block that earlier versions of the app used to append,
// so previously-saved activities get cleaned up automatically the next
// time they're edited and re-saved.
const CAR_TRIP_NOTE_RE = /\n*—— Car Trip ——[\s\S]*$/;

function stripCarTripNote(text: string): string {
  return text.replace(CAR_TRIP_NOTE_RE, '').trim();
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

// Fire-and-forget: when a Daily Activity is saved with a car trip attached,
// auto-create (or, on edit/re-save, update) a linked Expense Claim so it
// shows up in Finance > Expense Claims for awareness/approval into Project
// Expenses (company cost). is_car_trip = true keeps it out of the driver's
// personal expense views/totals and out of Payslips — see
// react_migration_phase17_sql.sql.
//
// Idempotent by daily_activity_id: re-saving the same activity (e.g. after
// editing distance, driver, or car) updates the existing linked claim
// instead of inserting a duplicate. If the claim has already moved past
// "pending" (approved/rejected by Finance), we leave it alone rather than
// silently rewriting a decision that's already been made.
// Returns true if the claim was created/updated, false if it was skipped
// or the write failed (callers use this to warn the user instead of
// letting a DB error disappear silently, which is what made this function
// hard to debug before — every failure just looked like nothing happened).
async function ftSyncCarClaim(daId: string, v: FormVals, submittedBy: string, carName: string, driverName: string): Promise<boolean> {
  if (!v.car_id || !v.driver_id || v.trip_cost_iqd == null) return false;

  const claimFields = {
    member_id: v.driver_id,
    project_name: v.project,
    site_id: v.site_id,
    governorate: v.governate || null,
    description: `Car Trip – ${carName}`,
    activity_date: v.date,
    transport_amount: v.trip_cost_iqd,
    food_amount: 0,
    accommodation: null,
    total_amount: v.trip_cost_iqd,
    notes: `Auto-generated from car trip: ${carName} driven by ${driverName} (${v.trip_distance_km ?? '—'} km @ ${v.trip_rate_iqd ?? '—'} IQD/km). Logged by ${submittedBy || '—'}.`,
    is_car_trip: true,
    car_id: v.car_id,
    car_trip_distance_km: v.trip_distance_km,
    car_trip_rate_iqd: v.trip_rate_iqd,
  };

  const { data: existing, error: selErr } = await supabase
    .from('expense_claims')
    .select('id,status')
    .eq('daily_activity_id', daId)
    .eq('is_car_trip', true)
    .maybeSingle();
  if (selErr) { console.error('[ftSyncCarClaim] lookup failed', selErr); return false; }

  if (existing) {
    if (existing.status && existing.status !== 'pending') return false;
    const { error } = await supabase.from('expense_claims').update(claimFields).eq('id', existing.id);
    if (error) { console.error('[ftSyncCarClaim] update failed', error); return false; }
    return true;
  } else {
    const { error } = await supabase.from('expense_claims').insert({
      ...claimFields,
      submitted_at: new Date().toISOString(),
      status: 'pending',
      daily_activity_id: daId,
    });
    if (error) { console.error('[ftSyncCarClaim] insert failed', error); return false; }
    return true;
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
  car_id: string | null;
  driver_id: string | null;
  start_point_name: string | null;
  start_lat: number | null;
  start_lng: number | null;
  target_lat: number | null;
  target_lng: number | null;
  trip_stops: TripStopSaved[] | null;
  trip_legs: TripLegSaved[] | null;
  trip_distance_km: number | null;
  trip_rate_iqd: number | null;
  trip_cost_iqd: number | null;
  trip_distance_source: string | null;
  round_trip: boolean | null;
}

export default function DailyActivities() {
  const { currentUser, hasPerm } = useAuth();
  const { t } = useTranslation();

  // Data
  const [activities, setActivities] = useState<DailyActivity[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);

  // Form
  const [date, setDate] = useState(today());
  const [project, setProject] = useState('');
  const [projectNames, setProjectNames] = useState<string[]>([]);
  const [nameToKey, setNameToKey] = useState<Record<string, string>>({});
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

  // Car Trip sub-section
  const [carTripEnabled, setCarTripEnabled] = useState(false);
  const [cars, setCars] = useState<CarMeta[]>([]);
  const [savedPoints, setSavedPoints] = useState<SavedPointMeta[]>([]);
  const [carId, setCarId] = useState('');
  const [driverId, setDriverId] = useState('');
  const [startPointId, setStartPointId] = useState('');
  const [startPointName, setStartPointName] = useState('');
  const [startLat, setStartLat] = useState('');
  const [startLng, setStartLng] = useState('');
  // Target points (trip stops) — one per Site ID tag, in the order the tags
  // were added, summed into a single route just like the Route Planner does
  // for multi-site days. Each stop is auto-filled from Sites DB when its
  // site matches a known site_code, otherwise left for the user to fill in
  // manually or via the map picker (for sites not yet in Sites DB). A stop
  // marked `manual` is never overwritten by the Sites DB auto-fill effect.
  const [stops, setStops] = useState<TripStop[]>([]);
  const [mapPickerOpen, setMapPickerOpen] = useState(false);
  const [mapPickerMode, setMapPickerMode] = useState<'start' | number>('start');
  const [mapPickedLat, setMapPickedLat] = useState<number | null>(null);
  const [mapPickedLng, setMapPickedLng] = useState<number | null>(null);
  const mapPickerContainerRef = useRef<HTMLDivElement>(null);
  const mapPickerMapRef = useRef<L.Map | null>(null);
  const mapPickerMarkerRef = useRef<L.Marker | null>(null);
  const [mapSearchQuery, setMapSearchQuery] = useState('');
  const [mapSearchResults, setMapSearchResults] = useState<GeocodeResult[]>([]);
  const [mapSearching, setMapSearching] = useState(false);
  const mapSearchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tripDistanceKm, setTripDistanceKm] = useState<number | null>(null);
  const [tripCostIqd, setTripCostIqd] = useState<number | null>(null);
  const [tripDistanceSource, setTripDistanceSource] = useState<'road' | 'straight' | null>(null);
  const [tripLegs, setTripLegs] = useState<TripLegSaved[] | null>(null);
  // Trip setting (not a calc result) — whether the route includes a final
  // leg back from the last stop to the start point. Persists across
  // recalculations, only reset on a brand-new activity (resetForm) or
  // restored from a saved one (startEdit).
  const [roundTrip, setRoundTrip] = useState(false);
  const [tripCalculating, setTripCalculating] = useState(false);
  const [tripCalcError, setTripCalcError] = useState('');

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Team Report modal
  const [showTeamReport, setShowTeamReport] = useState(false);
  const [trMonth, setTrMonth] = useState(() => new Date().getMonth() + 1);
  const [trYear,  setTrYear]  = useState(() => new Date().getFullYear());
  const [trExporting, setTrExporting] = useState(false);

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
  const carSearchInputRef = useRef<HTMLInputElement>(null);
  const [carDropdownOpen, setCarDropdownOpen] = useState(false);
  const [carSearch, setCarSearch] = useState('');

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

  useEffect(() => {
    ensureProjectsLoaded().then(() => {
      const names = getProjectNames();
      setProjectNames(names);
      setNameToKey(getProjectNameToKeyMap());
      setProject(prev => prev || names[0] || '');
    });
  }, []);

  // ── Car Trip reference data ──
  useEffect(() => {
    Promise.all([ensureCarsLoaded(), ensureSavedPointsLoaded(), ensureCarKmRateLoaded()]).then(() => {
      setCars(getCars());
      setSavedPoints(getSavedPoints());
    });
  }, []);

  // Debounce the search box so filtering doesn't re-run on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchQuery(searchQuery), 300);
    return () => clearTimeout(timer);
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
  }, [date, project, sectionId, siteTags, siteInput, governate, activityType, status, notes, selectedMemberIds, carTripEnabled, carId, driverId, startPointName, startLat, startLng, stops]);

  // Keep the `stops` array (one route leg per Site ID tag, in order) in sync
  // with siteTags/siteInput whenever the Car Trip section is enabled.
  // Existing stops are preserved by site name so in-progress lat/lng edits,
  // manual flags, and found/missing status survive tag reordering/adding.
  useEffect(() => {
    if (!carTripEnabled) return;
    const sites = siteTags.length > 0 ? siteTags : (siteInput.trim() ? [siteInput.trim()] : []);
    setStops(prev => {
      if (sites.length === 0) return prev.length === 0 ? prev : [];
      const bySite = new Map(prev.map(s => [s.site, s]));
      return sites.map(site => bySite.get(site) || { site, lat: '', lng: '', found: null, manual: false });
    });
  }, [carTripEnabled, siteTags, siteInput]);

  // Auto-fill each non-manual stop's lat/lng from Sites DB whenever its site
  // matches a known site_code. If the site isn't found (e.g. a new site not
  // yet added to Sites DB), leave it for manual/map entry instead. Never
  // overwrites a stop the user has edited manually or picked on the map.
  // Keyed off the site list (not the whole `stops` array) so this doesn't
  // re-run every time a lat/lng is filled in by this same effect.
  const stopSitesKey = stops.map(s => s.site).join('|');
  useEffect(() => {
    if (!carTripEnabled) return;
    const toFetch = stops.filter(s => !s.manual).map(s => s.site);
    if (toFetch.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('sites').select('site_code, latitude, longitude').in('site_code', toFetch);
      if (cancelled) return;
      const bySite = new Map((data || []).map(r => [r.site_code, r]));
      setStops(prev => prev.map(s => {
        if (s.manual) return s;
        const rec = bySite.get(s.site);
        if (rec?.latitude != null && rec?.longitude != null) {
          return { ...s, lat: String(rec.latitude), lng: String(rec.longitude), found: true };
        }
        return { ...s, lat: '', lng: '', found: false };
      }));
      resetCarTripCalc();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carTripEnabled, stopSitesKey]);

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

  // Small sign shown next to a member's name reflecting their actual Job Title
  // (whatever text is set in Fin Team → Job Title), not just Engineer/Technician.
  function roleTag(role: string | null | undefined): { label: string; title: string; bg: string; text: string } | null {
    const clean = (role || '').trim();
    if (!clean) return null;
    const words = clean.split(/\s+/).filter(Boolean);
    const label = words.length > 1
      ? words.slice(0, 3).map(w => w[0]).join('').toUpperCase()
      : clean.slice(0, 3).toUpperCase();
    let hash = 0;
    for (let i = 0; i < clean.length; i++) hash = (hash * 31 + clean.charCodeAt(i)) >>> 0;
    const c = ROLE_TAG_COLORS[hash % ROLE_TAG_COLORS.length];
    return { label, title: clean, bg: c.bg, text: c.text };
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
    resetCarTripCalc();
    if (!project) { setSections([]); return; }
    const projKey = nameToKey[project] || project;
    supabase
      .from('sections')
      .select('id,section_label,section_name')
      .eq('project_name', projKey)
      .neq('is_deleted', true)
      .order('created_at', { ascending: true })
      .then(({ data }) => setSections(data || []));
  }, [project, nameToKey]);

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
      if (carTripEnabled) resetCarTripCalc();
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
    if (carTripEnabled) resetCarTripCalc();
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

  function getBusyCarMap() {
    const busyIds = new Set<string>();
    const busyInfo: Record<string, string[]> = {};
    activities
      .filter(a => a.date === date && a.id !== editingId)
      .forEach(a => {
        if (a.car_id) {
          busyIds.add(a.car_id);
          if (!busyInfo[a.car_id]) busyInfo[a.car_id] = [];
          busyInfo[a.car_id].push(`${a.project || '—'} – ${a.activity_type || 'an activity'} (Site ${a.site_id || '—'})`);
        }
      });
    return { busyIds, busyInfo };
  }

  // ── Car Trip ──
  function onCarChange(id: string) {
    setCarId(id);
    if (!driverId) {
      const ownerId = getCarOwnerId(id);
      if (ownerId) setDriverId(ownerId);
    }
  }

  function selectCar(id: string, carLabel: string, isBusy: boolean, busyInfo: string[]) {
    if (isBusy) {
      const list = busyInfo.map((s, i) => `${i + 1}. ${s}`).join('\n');
      const ok = window.confirm(`${carLabel} is already assigned to:\n${list}\n\nUse it for this activity as well?`);
      if (!ok) return;
    }
    onCarChange(id);
    setFieldErrors(fe => ({ ...fe, carId: '' }));
    setCarDropdownOpen(false);
    setCarSearch('');
  }

  function onStartPointChange(id: string) {
    setStartPointId(id);
    if (!id) return;
    const p = savedPoints.find(sp => sp.id === id);
    if (p) {
      setStartPointName(p.name);
      setStartLat(String(p.latitude));
      setStartLng(String(p.longitude));
    }
  }

  function resetCarTripCalc() {
    setTripDistanceKm(null);
    setTripCostIqd(null);
    setTripDistanceSource(null);
    setTripLegs(null);
    setTripCalcError('');
  }

  // Update one stop's lat/lng (by index) and mark it manual so the Sites DB
  // auto-fill effect leaves it alone from now on.
  function setStopLatLng(idx: number, lat: string, lng: string) {
    setStops(prev => prev.map((s, i) => i === idx ? { ...s, lat, lng, manual: true } : s));
  }

  // ── Map picker for Car Trip start point / a stop ──
  // mode is 'start' for the start point, or the stop's index for a stop.
  function openMapPicker(mode: 'start' | number = 'start') {
    const cur = mode === 'start' ? { lat: startLat, lng: startLng } : { lat: stops[mode]?.lat || '', lng: stops[mode]?.lng || '' };
    const curLat = parseFloat(cur.lat);
    const curLng = parseFloat(cur.lng);
    const initLat = !isNaN(curLat) ? curLat : 33.3152;
    const initLng = !isNaN(curLng) ? curLng : 44.3661;
    setMapPickerMode(mode);
    setMapPickedLat(initLat);
    setMapPickedLng(initLng);
    setMapSearchQuery('');
    setMapSearchResults([]);
    setMapPickerOpen(true);
  }

  function confirmMapPicker() {
    if (mapPickedLat == null || mapPickedLng == null) { setMapPickerOpen(false); return; }
    if (typeof mapPickerMode === 'number') {
      setStopLatLng(mapPickerMode, String(mapPickedLat.toFixed(6)), String(mapPickedLng.toFixed(6)));
      setFieldErrors(fe => ({ ...fe, [`stopLat${mapPickerMode}`]: '' }));
    } else {
      setStartLat(String(mapPickedLat.toFixed(6)));
      setStartLng(String(mapPickedLng.toFixed(6)));
      setStartPointId('');
      setFieldErrors(fe => ({ ...fe, startLat: '' }));
    }
    resetCarTripCalc();
    setMapPickerOpen(false);
  }

  function onMapSearchChange(q: string) {
    setMapSearchQuery(q);
    if (mapSearchDebounceRef.current) clearTimeout(mapSearchDebounceRef.current);
    if (!q.trim()) { setMapSearchResults([]); setMapSearching(false); return; }
    setMapSearching(true);
    mapSearchDebounceRef.current = setTimeout(async () => {
      const results = await searchPlaces(q);
      setMapSearchResults(results);
      setMapSearching(false);
    }, 400);
  }

  function selectMapSearchResult(r: GeocodeResult) {
    setMapPickedLat(r.lat);
    setMapPickedLng(r.lng);
    setMapSearchQuery(r.placeName);
    setMapSearchResults([]);
    if (mapPickerMode === 'start' && !startPointName.trim()) setStartPointName(r.placeName.split(',')[0]);
    const map = mapPickerMapRef.current;
    const marker = mapPickerMarkerRef.current;
    if (map && marker) {
      marker.setLatLng([r.lat, r.lng]);
      map.setView([r.lat, r.lng], 15);
    }
  }

  useEffect(() => {
    if (!mapPickerOpen || !mapPickerContainerRef.current) return;
    const initLat = mapPickedLat ?? 33.3152;
    const initLng = mapPickedLng ?? 44.3661;
    const map = L.map(mapPickerContainerRef.current).setView([initLat, initLng], 12);
    addBaseLayer(map, 'streets');
    const marker = L.marker([initLat, initLng], { draggable: true }).addTo(map);
    marker.on('dragend', () => {
      const pos = marker.getLatLng();
      setMapPickedLat(pos.lat);
      setMapPickedLng(pos.lng);
    });
    map.on('click', (e: L.LeafletMouseEvent) => {
      marker.setLatLng(e.latlng);
      setMapPickedLat(e.latlng.lat);
      setMapPickedLng(e.latlng.lng);
    });
    mapPickerMapRef.current = map;
    mapPickerMarkerRef.current = marker;
    setTimeout(() => map.invalidateSize(), 60);
    return () => {
      map.remove();
      mapPickerMapRef.current = null;
      mapPickerMarkerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapPickerOpen]);

  // Calculates the full route: start point → stop 1 → stop 2 → … → last
  // stop, in Site ID tag order — same "sum the whole route" approach as the
  // Route Planner for multi-site days. getRoadRoute() already accepts and
  // sums an arbitrary number of waypoints, so a 1-stop trip and a 5-stop
  // trip go through the exact same code path.
  async function calcCarTrip() {
    setTripCalcError('');
    const sLat = parseFloat(startLat);
    const sLng = parseFloat(startLng);
    if (isNaN(sLat) || isNaN(sLng)) { setTripCalcError(t('da_tripStartRequired')); return; }
    if (stops.length === 0) { setTripCalcError(t('da_siteRequired')); return; }

    const legPoints: { latitude: number; longitude: number }[] = [{ latitude: sLat, longitude: sLng }];
    for (const s of stops) {
      const lat = parseFloat(s.lat);
      const lng = parseFloat(s.lng);
      if (isNaN(lat) || isNaN(lng)) {
        setTripCalcError(t('da_tripTargetRequired'));
        return;
      }
      legPoints.push({ latitude: lat, longitude: lng });
    }
    // Round trip: tack the start point back on as a final waypoint, so the
    // return leg goes through the exact same road/straight-line summation
    // below as every other leg — no separate calculation path needed.
    if (roundTrip) legPoints.push({ latitude: sLat, longitude: sLng });

    setTripCalculating(true);
    setTripDistanceKm(null);
    setTripCostIqd(null);
    setTripDistanceSource(null);
    setTripLegs(null);
    try {
      const road = await getRoadRoute(legPoints);
      let km: number;
      let legs: TripLegSaved[];
      const source: 'road' | 'straight' = road ? 'road' : 'straight';
      if (road) {
        km = road.distanceKm;
        legs = road.legs.map(l => ({ distanceKm: Math.round(l.distanceKm * 100) / 100, minutes: Math.round(l.minutes) }));
      } else {
        km = 0;
        legs = [];
        for (let i = 0; i < legPoints.length - 1; i++) {
          const legKm = haversineKm(legPoints[i].latitude, legPoints[i].longitude, legPoints[i + 1].latitude, legPoints[i + 1].longitude);
          km += legKm;
          legs.push({ distanceKm: Math.round(legKm * 100) / 100, minutes: null });
        }
      }
      const rate = getCarKmRate();
      const roundedKm = Math.round(km * 100) / 100;
      const cost = Math.round(roundedKm * rate);

      setTripDistanceKm(roundedKm);
      setTripCostIqd(cost);
      setTripDistanceSource(source);
      setTripLegs(legs);
    } catch {
      setTripCalcError(t('da_tripCalcFailed'));
    } finally {
      setTripCalculating(false);
    }
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
    if (!date) errs.date = t('da_dateRequired');
    if (!project) errs.project = t('da_projectRequired');
    const hasSite = siteTags.length > 0 || siteInput.trim().length > 0;
    if (!hasSite) errs.site_id = t('da_siteRequired');
    if (!activityType) errs.activityType = t('da_actTypeRequired');
    if (!status) errs.status = t('da_statusRequired');
    if (carTripEnabled) {
      if (!carId) errs.carId = t('da_tripCarRequired');
      if (!driverId) errs.driverId = t('da_tripDriverRequired');
      const sLat = parseFloat(startLat);
      const sLng = parseFloat(startLng);
      if (isNaN(sLat) || isNaN(sLng)) errs.startLat = t('da_tripStartRequired');
      stops.forEach((s, i) => {
        const lat = parseFloat(s.lat);
        const lng = parseFloat(s.lng);
        if (isNaN(lat) || isNaN(lng)) errs[`stopLat${i}`] = t('da_tripTargetRequired');
      });
      if (tripDistanceKm == null || tripCostIqd == null) errs.tripCalc = t('da_tripCalcRequired');
    }
    return errs;
  }

  // ── Save ──
  async function save() {
    const errs = validateForm();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      showToast(t('da_pleaseFixFields'), false);
      return;
    }

    const allTags = siteInput.trim() && !siteTags.includes(siteInput.trim())
      ? [...siteTags, siteInput.trim()]
      : siteTags;
    const site_id = allTags.join(', ');

    const memberIds = [...selectedMemberIds];
    const memberNames = memberIds.map(id => teamMembers.find(m => m.id === id)?.full_name || id);

    const effectiveCarId = carTripEnabled ? (carId || null) : null;
    const effectiveDriverId = carTripEnabled ? (driverId || null) : null;
    const carName = effectiveCarId ? getCarName(effectiveCarId) : '';
    const driverName = effectiveDriverId
      ? (teamMembers.find(m => m.id === effectiveDriverId)?.full_name || effectiveDriverId)
      : '';
    // Car/driver info lives only in the dedicated Car Trip fields and the
    // WhatsApp Car Trip Details section — never duplicated into Notes.
    // stripCarTripNote() also cleans up the old auto-appended block from
    // any activity saved before this change.
    const finalNotes = stripCarTripNote(notes.trim());

    // Persist every stop (jsonb) plus, for backward compat with older
    // reads/queries that only knew about a single destination, the last
    // stop's coordinates in target_lat/target_lng (the final destination of
    // the route).
    const tripStopsPayload: TripStopSaved[] = carTripEnabled
      ? stops.map(s => ({ site: s.site, lat: parseFloat(s.lat), lng: parseFloat(s.lng) })).filter(s => !isNaN(s.lat) && !isNaN(s.lng))
      : [];
    const lastStop = tripStopsPayload[tripStopsPayload.length - 1] || null;

    const v: FormVals = {
      date, project, site_id, governate: governate.trim(),
      activity_type: activityType, status, notes: finalNotes,
      team_member_ids: memberIds, team_member_names: memberNames,
      car_id: effectiveCarId,
      driver_id: effectiveDriverId,
      start_point_name: carTripEnabled ? (startPointName.trim() || null) : null,
      start_lat: carTripEnabled && startLat ? parseFloat(startLat) : null,
      start_lng: carTripEnabled && startLng ? parseFloat(startLng) : null,
      target_lat: lastStop ? lastStop.lat : null,
      target_lng: lastStop ? lastStop.lng : null,
      trip_stops: carTripEnabled ? tripStopsPayload : null,
      trip_legs: carTripEnabled ? tripLegs : null,
      trip_distance_km: carTripEnabled ? tripDistanceKm : null,
      trip_rate_iqd: carTripEnabled && tripCostIqd != null ? getCarKmRate() : null,
      trip_cost_iqd: carTripEnabled ? tripCostIqd : null,
      trip_distance_source: carTripEnabled ? tripDistanceSource : null,
      round_trip: carTripEnabled ? roundTrip : null,
    };

    const byUser = currentUser?.full_name || currentUser?.username || '';
    setSaving(true);

    if (editingId) {
      const reason = await promptReason();
      if (!reason) { showToast(t('da_updateCancelled'), false); setSaving(false); return; }
      const payload = {
        ...v, is_edited: true, edit_reason: reason,
        updated_at: new Date().toISOString(), updated_by: byUser,
      };
      const { error } = await supabase.from('daily_activities').update(payload).eq('id', editingId);
      if (error) { showToast(error.message, false); setSaving(false); return; }
      showToast(t('da_activityUpdated'), true);
      ftSyncTrip(editingId, v, byUser).catch(() => {});
      if (v.car_id) {
        ftSyncCarClaim(editingId, v, byUser, carName, driverName)
          .then(ok => { if (!ok) showToast(t('da_carClaimSyncFailed'), false); })
          .catch(err => { console.error('[ftSyncCarClaim] threw', err); showToast(t('da_carClaimSyncFailed'), false); });
      }
      setEditingId(null);
    } else {
      const payload = { ...v, created_by: byUser };
      const { data: inserted, error } = await supabase
        .from('daily_activities').insert(payload).select().single();
      if (error) { showToast(error.message, false); setSaving(false); return; }
      showToast(t('da_activitySaved'), true);
      if (inserted?.id) {
        ftCreateTrip(inserted.id, v, byUser).catch(() => {});
        if (v.car_id) {
          ftSyncCarClaim(inserted.id, v, byUser, carName, driverName)
            .then(ok => { if (!ok) showToast(t('da_carClaimSyncFailed'), false); })
            .catch(err => { console.error('[ftSyncCarClaim] threw', err); showToast(t('da_carClaimSyncFailed'), false); });
        }
      }
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
    setProject(projectNames[0] || '');
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
    setCarTripEnabled(false);
    setCarId('');
    setDriverId('');
    setStartPointId('');
    setStartPointName('');
    setStartLat('');
    setStartLng('');
    setStops([]);
    setRoundTrip(false);
    resetCarTripCalc();
  }

  // ── Edit ──
  function startEdit(a: DailyActivity) {
    suppressDirty.current = true;
    setFormTouched(false);
    setFieldErrors({});
    setEditingId(a.id);
    setDate(a.date || today());
    setProject(a.project || projectNames[0] || '');
    const siteTagsArr = String(a.site_id || '').split(',').map(s => s.trim()).filter(Boolean);
    setSiteTags(siteTagsArr);
    setSiteInput('');
    setGovernate(a.governate || '');
    setActivityType(a.activity_type || ACTIVITY_TYPES[0]);
    setStatus(a.status || STATUS_OPTIONS[0]);
    // stripCarTripNote() cleans up the old auto-appended "—— Car Trip ——"
    // block from activities saved before that behavior was removed, so the
    // edit form (and the next save) never show/persist it again.
    setNotes(stripCarTripNote(a.notes || ''));
    setSelectedMemberIds(new Set(a.team_member_ids || []));
    setMemberSearch('');
    setCarTripEnabled(!!a.car_id);
    setCarId(a.car_id || '');
    setDriverId(a.driver_id || '');
    setStartPointId('');
    setStartPointName(a.start_point_name || '');
    setStartLat(a.start_lat != null ? String(a.start_lat) : '');
    setStartLng(a.start_lng != null ? String(a.start_lng) : '');
    // Restore every saved stop as "manual" so the Sites DB auto-fill effect
    // doesn't overwrite it — the saved value is already correct, whether it
    // originally came from Sites DB, manual entry, or the map. Older rows
    // saved before multi-stop only have a single target_lat/target_lng —
    // seed that onto the first site tag and let any other tags auto-fill.
    if (a.trip_stops && a.trip_stops.length > 0) {
      setStops(a.trip_stops.map(s => ({ site: s.site, lat: String(s.lat), lng: String(s.lng), found: null, manual: true })));
    } else if (a.target_lat != null && a.target_lng != null) {
      setStops(siteTagsArr.map((site, i) => i === 0
        ? { site, lat: String(a.target_lat), lng: String(a.target_lng), found: null, manual: true }
        : { site, lat: '', lng: '', found: null, manual: false }));
    } else {
      setStops([]);
    }
    setTripDistanceKm(a.trip_distance_km ?? null);
    setTripCostIqd(a.trip_cost_iqd ?? null);
    setTripDistanceSource((a.trip_distance_source as 'road' | 'straight' | null) ?? null);
    setTripLegs(a.trip_legs && a.trip_legs.length ? a.trip_legs : null);
    setRoundTrip(!!a.round_trip);
    setTripCalcError('');
    formCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast(t('da_editingNotice'), true);
  }

  function cancelEdit() {
    setEditingId(null);
    resetForm();
    showToast(t('da_editCancelled'), true);
  }

  // ── Delete ──
  async function deleteActivity(id: string) {
    if (!window.confirm(t('da_deleteConfirm'))) return;
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
    showToast(t('da_deleted'), true);
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
    const carType = carTripEnabled && carId ? getCarName(carId) : null;
    const driverName = carTripEnabled && driverId ? (teamMembers.find(m => m.id === driverId)?.full_name || driverId) : null;
    const trip: WaTripDetails | null = carTripEnabled && (carType || driverName)
      ? {
          carType,
          driverName,
          startPointName: startPointName.trim() || null,
          stopSites: stops.map(s => s.site),
          distanceKm: tripDistanceKm,
          costIqd: tripCostIqd,
          rateIqd: tripCostIqd != null ? getCarKmRate() : null,
          source: tripDistanceSource,
          legs: tripLegs,
          roundTrip,
        }
      : null;
    const msg = buildWaMsg(date, project, sectionLabel, allTags.join(', '), governate, memberNames, activityType, status, stripCarTripNote(notes), trip);
    window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
  }

  function shareWa(a: DailyActivity) {
    const teamNames = Array.isArray(a.team_member_names) ? a.team_member_names : [];
    const carType = a.car_id ? getCarName(a.car_id) : null;
    const driverName = a.driver_id ? (teamMembers.find(m => m.id === a.driver_id)?.full_name || a.driver_id) : null;
    const stopSites = a.trip_stops && a.trip_stops.length
      ? a.trip_stops.map(s => s.site)
      : (a.target_lat != null ? String(a.site_id || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 1) : []);
    const trip: WaTripDetails | null = (carType || driverName)
      ? {
          carType,
          driverName,
          startPointName: a.start_point_name || null,
          stopSites,
          distanceKm: a.trip_distance_km ?? null,
          costIqd: a.trip_cost_iqd ?? null,
          rateIqd: a.trip_rate_iqd ?? null,
          source: (a.trip_distance_source as 'road' | 'straight' | null) ?? null,
          legs: a.trip_legs && a.trip_legs.length ? a.trip_legs : null,
          roundTrip: !!a.round_trip,
        }
      : null;
    const msg = buildWaMsg(a.date, a.project, '', a.site_id || '', a.governate || '', teamNames, a.activity_type || '', a.status || '', stripCarTripNote(a.notes || ''), trip);
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
  const { busyIds: busyCarIds, busyInfo: busyCarInfo } = getBusyCarMap();

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
    if (s === 'Completed')  return <span className={`${styles.pill} ${styles.pillDone}`}><span className={styles.dot} />{t('da_completed')}</span>;
    if (s === 'In Progress') return <span className={`${styles.pill} ${styles.pillInprog}`}><span className={styles.dot} />{t('da_inProgress')}</span>;
    if (s === 'Blocked')    return <span className={`${styles.pill} ${styles.pillBlocked}`}><span className={styles.dot} />{t('da_blocked')}</span>;
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

  // ── Team Report: 2-sheet workbook for the selected month/year ──
  async function exportTeamReport() {
    setTrExporting(true);
    const dLast = new Date(trYear, trMonth, 0);
    const first = `${trYear}-${String(trMonth).padStart(2, '0')}-01`;
    const last  = `${trYear}-${String(trMonth).padStart(2, '0')}-${String(dLast.getDate()).padStart(2, '0')}`;

    const { data: acts, error } = await supabase
      .from('daily_activities')
      .select('date,project,site_id,activity_type,status,team_member_ids')
      .gte('date', first)
      .lte('date', last);

    setTrExporting(false);
    if (error || !acts) return;

    const nameById = Object.fromEntries(teamMembers.map(m => [m.id, m.full_name]));

    // Sheet 1 — Summary: one row per team member, including zero-activity members
    const summaryRows = teamMembers.map(member => {
      const memberActs = acts.filter(
        (a: { team_member_ids?: string[] | null }) =>
          Array.isArray(a.team_member_ids) && a.team_member_ids.includes(member.id),
      );
      const distinctDates = new Set(memberActs.map((a: { date: string }) => a.date));
      const typeCounts = Object.fromEntries(
        ACTIVITY_TYPES.map(atype => [
          atype,
          memberActs.filter((a: { activity_type?: string | null }) => a.activity_type === atype).length,
        ]),
      );
      const projects = [
        ...new Set(
          memberActs
            .map((a: { project?: string | null }) => a.project)
            .filter((p: string | null | undefined): p is string => !!p),
        ),
      ];
      return {
        'Employee Name': member.full_name,
        'Role': member.role ?? '',
        'Days With Activity': distinctDates.size,
        ...typeCounts,
        'Projects Touched': projects.join(', '),
      };
    });

    const ws1 = XLSX.utils.json_to_sheet(summaryRows);
    ws1['!cols'] = [
      { wch: 22 }, { wch: 14 }, { wch: 20 },
      ...ACTIVITY_TYPES.map(() => ({ wch: 14 })),
      { wch: 40 },
    ];

    // Sheet 2 — Detail: one row per (employee × activity), sorted by name then date
    interface DetailEntry {
      name: string; rawDate: string; project: string; site_id: string;
      activity_type: string; status: string;
    }
    const detailEntries: DetailEntry[] = acts.flatMap(
      (a: { date: string; project?: string | null; site_id?: string | null; activity_type?: string | null; status?: string | null; team_member_ids?: string[] | null }) =>
        (Array.isArray(a.team_member_ids) ? a.team_member_ids : []).map((id: string) => ({
          name: nameById[id] || id,
          rawDate: a.date,
          project: a.project ?? '',
          site_id: a.site_id ?? '',
          activity_type: a.activity_type ?? '',
          status: a.status ?? '',
        })),
    );
    detailEntries.sort((a, b) =>
      a.name.localeCompare(b.name) || a.rawDate.localeCompare(b.rawDate),
    );

    const ws2 = XLSX.utils.json_to_sheet(
      detailEntries.map(e => ({
        'Employee Name': e.name,
        'Date': e.rawDate ? fmtDate(e.rawDate) : '',
        'Project': e.project,
        'Site ID': e.site_id,
        'Activity Type': e.activity_type,
        'Status': e.status,
      })),
    );
    ws2['!cols'] = [
      { wch: 22 }, { wch: 12 }, { wch: 16 }, { wch: 20 }, { wch: 16 }, { wch: 14 },
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, 'Summary');
    XLSX.utils.book_append_sheet(wb, ws2, 'Detail');
    XLSX.writeFile(wb, `Team_Report_${FIN_MONTHS[trMonth - 1]}_${trYear}.xlsx`);
    setShowTeamReport(false);
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
          {t('ns_noPermission')}
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

      {/* ── Page Actions ── */}
      <div className={styles.hdrActions}>
        {hasPerm('da_add_rows') && (
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
            {t('da_newActivity')}
          </button>
        )}
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
            <div className={styles.kpiLabel}>{t('da_totalActivities')}</div>
            <div className={styles.kpiValue}>{loading ? '—' : total}</div>
            <div className={styles.kpiSub}>{t('da_allRecorded')}</div>
          </div>
        </div>
        <div className={`${styles.kpiCard} ${styles.kpiGreen}`}>
          <div className={styles.kpiIcon}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </div>
          <div>
            <div className={styles.kpiLabel}>{t('da_completed')}</div>
            <div className={styles.kpiValue}>{loading ? '—' : completed}</div>
            <div className={styles.kpiSub}>{loading || total === 0 ? '—' : t('da_pctOfTotal', { pct: pct(completed) })}</div>
          </div>
        </div>
        <div className={`${styles.kpiCard} ${styles.kpiAmber}`}>
          <div className={styles.kpiIcon}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
          </div>
          <div>
            <div className={styles.kpiLabel}>{t('da_inProgress')}</div>
            <div className={styles.kpiValue}>{loading ? '—' : inProg}</div>
            <div className={styles.kpiSub}>{loading || total === 0 ? '—' : t('da_pctOfTotal', { pct: pct(inProg) })}</div>
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
            <div className={styles.kpiLabel}>{t('da_blocked')}</div>
            <div className={styles.kpiValue}>{loading ? '—' : blocked}</div>
            <div className={styles.kpiSub}>{loading || total === 0 ? '—' : t('da_pctOfTotal', { pct: pct(blocked) })}</div>
          </div>
        </div>
      </div>

      {/* ── Form Card (create needs add_rows, editing an existing row needs
          edit_rows — same gating pattern as Sites DB / NetworkScopes.tsx) ── */}
      {(hasPerm('da_add_rows') || hasPerm('da_edit_rows')) && (
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
            <div className={styles.formHdrTitle}>{editingId ? t('da_editActivity') : t('da_newActivity')}</div>
            <div className={styles.formHdrSub}>{editingId ? t('da_editSubtitle') : t('da_createSubtitle')}</div>
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
                <div className={styles.subCardTitle}>{t('da_locationScope')}</div>
              </div>
              <div className={styles.subCardBody}>
                <div className={styles.fieldsGrid}>
                  <div className={styles.field}>
                    <label>{t('da_project')} <span className={styles.req}>*</span></label>
                    <select
                      className={fieldErrors.project ? styles.inputError : ''}
                      value={project}
                      onChange={e => { setProject(e.target.value); setFieldErrors(fe => ({ ...fe, project: '' })); }}
                    >
                      {projectNames.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                    {fieldErrors.project && <span className={styles.fieldErrMsg}>{fieldErrors.project}</span>}
                  </div>
                  <div className={styles.field}>
                    <label>{t('da_section')} <span className={styles.req}>*</span></label>
                    <select
                      value={sectionId}
                      onChange={e => {
                        const opt = e.target.options[e.target.selectedIndex];
                        setSectionId(e.target.value);
                        setSectionLabel(opt.text || '');
                      }}
                    >
                      <option value="">{sections.length === 0 ? t('da_selectProjFirst') : t('da_selectSection')}</option>
                      {sections.map(s => {
                        const lbl = s.section_label || s.section_name || '';
                        return <option key={s.id} value={s.id}>{lbl}</option>;
                      })}
                    </select>
                  </div>
                  <div className={styles.field}>
                    <label>{t('da_siteId')} <span className={styles.req}>*</span></label>
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
                        placeholder={siteTags.length ? '' : t('da_searchSite')}
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
                    <label>{t('da_governorate')}</label>
                    <input
                      type="text"
                      placeholder={t('da_autoFills')}
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
                <div className={styles.subCardTitle}>{t('da_workDetails')}</div>
              </div>
              <div className={styles.subCardBody}>
                <div className={styles.fieldsGrid}>
                  <div className={styles.field}>
                    <label>{t('da_date')} <span className={styles.req}>*</span></label>
                    <input
                      className={fieldErrors.date ? styles.inputError : ''}
                      type="date"
                      value={date}
                      onChange={e => { setDate(e.target.value); setFieldErrors(fe => ({ ...fe, date: '' })); }}
                    />
                    {fieldErrors.date && <span className={styles.fieldErrMsg}>{fieldErrors.date}</span>}
                  </div>
                  <div className={styles.field}>
                    <label>{t('da_activityType')} <span className={styles.req}>*</span></label>
                    <select
                      className={fieldErrors.activityType ? styles.inputError : ''}
                      value={activityType}
                      onChange={e => { setActivityType(e.target.value); setFieldErrors(fe => ({ ...fe, activityType: '' })); }}
                    >
                      {ACTIVITY_TYPES.map(atype => <option key={atype} value={atype}>{t(ACTIVITY_TYPE_KEYS[atype] ?? atype)}</option>)}
                    </select>
                    {fieldErrors.activityType && <span className={styles.fieldErrMsg}>{fieldErrors.activityType}</span>}
                  </div>
                  <div className={styles.field}>
                    <label>{t('da_status')} <span className={styles.req}>*</span></label>
                    <select
                      className={fieldErrors.status ? styles.inputError : ''}
                      value={status}
                      onChange={e => { setStatus(e.target.value); setFieldErrors(fe => ({ ...fe, status: '' })); }}
                    >
                      {STATUS_OPTIONS.map(s => <option key={s} value={s}>{t(STATUS_KEYS[s] ?? s)}</option>)}
                    </select>
                    {fieldErrors.status && <span className={styles.fieldErrMsg}>{fieldErrors.status}</span>}
                  </div>
                  <div className={styles.field}>
                    <label>{t('da_notes')}</label>
                    <textarea
                      placeholder={t('da_describeWork')}
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
                <div className={styles.subCardTitle}>{t('da_teamMembersLabel')}</div>
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
                    placeholder={t('da_searchMembers')}
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
                      <div className={styles.memberSearchEmpty}>{t('da_noMembersFound')}</div>
                    ) : filteredNonSelected.map(m => {
                      const isBusy = busyIds.has(m.id);
                      const rt = roleTag(m.role);
                      return (
                        <div
                          key={m.id}
                          className={styles.memberSearchRow}
                          onClick={() => {
                            toggleMember(m.id, m.full_name, isBusy, busyInfo[m.id] || []);
                            setMemberSearch('');
                          }}
                        >
                          <span className={styles.chipAv}>{initials(m.full_name)}</span>
                          <span className={styles.memberSearchName}>{m.full_name}</span>
                          {rt && <span className={styles.roleTag} style={{ background: rt.bg, color: rt.text }} title={rt.title}>{rt.label}</span>}
                          {isBusy && <span className={styles.chipBusyTag}>{t('da_assigned')}</span>}
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className={styles.memberMeta}>
                  <span className={styles.memberCount}>
                    {t('da_membersSelected', { count: selectedMemberIds.size })}
                  </span>
                  {selectedMemberIds.size > 0 && (
                    <button
                      type="button"
                      className={styles.clearAllBtn}
                      onClick={() => setSelectedMemberIds(new Set())}
                    >
                      {t('da_clearAll')}
                    </button>
                  )}
                </div>

                <div className={styles.selectedChipsWrap}>
                  {selectedMemberIds.size === 0 ? (
                    <span className={styles.noSelectionHint}>{t('da_addMembersHint')}</span>
                  ) : [...selectedMemberIds].map(id => {
                    const member = teamMembers.find(m => m.id === id);
                    if (!member) return null;
                    const rt = roleTag(member.role);
                    return (
                      <span key={id} className={styles.selectedChip}>
                        <span className={styles.chipAv}>{initials(member.full_name)}</span>
                        <span className={styles.chipName}>
                          {member.full_name}
                          {rt && <span className={styles.roleTag} style={{ background: rt.bg, color: rt.text }} title={rt.title}>{rt.label}</span>}
                        </span>
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

            {/* ── Sub-card 4: Car Trip ── */}
            <div className={`${styles.subCard} ${styles.subCardFull}`}>
              <div className={styles.subCardHdr}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 17h14M5 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm14 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM5 17l1.5-6.5A2 2 0 0 1 8.43 9h7.14a2 2 0 0 1 1.93 1.5L19 17M5 17H3v-3a1 1 0 0 1 1-1h1"/>
                </svg>
                <div className={styles.subCardTitle}>{t('da_carTripLabel')}</div>
                <label className={styles.carTripToggle}>
                  <input
                    type="checkbox"
                    checked={carTripEnabled}
                    onChange={e => {
                      setCarTripEnabled(e.target.checked);
                      if (!e.target.checked) resetCarTripCalc();
                    }}
                  />
                  <span>{t('da_includeCarTrip')}</span>
                </label>
              </div>

              {carTripEnabled && (
                <div className={styles.subCardBody}>
                  <div className={styles.fieldsGrid}>
                    <div className={styles.field}>
                      <label>{t('da_tripCar')} <span className={styles.req}>*</span></label>
                      <div
                        className={styles.memberSearchWrap}
                        onClick={() => carSearchInputRef.current?.focus()}
                      >
                        <svg className={styles.memberSearchIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                        </svg>
                        <input
                          ref={carSearchInputRef}
                          className={`${styles.memberSearchInput} ${fieldErrors.carId ? styles.inputError : ''}`}
                          type="text"
                          placeholder={t('da_selectCar')}
                          value={carDropdownOpen ? carSearch : (carId ? getCarName(carId) : '')}
                          onFocus={() => { setCarDropdownOpen(true); setCarSearch(''); }}
                          onBlur={() => setTimeout(() => { setCarDropdownOpen(false); setCarSearch(''); }, 150)}
                          onChange={e => setCarSearch(e.target.value)}
                        />
                        <svg className={styles.memberSearchChevron} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                          <polyline points="6 9 12 15 18 9"/>
                        </svg>
                      </div>

                      {(carDropdownOpen || carSearch.trim()) && (
                        <div className={styles.memberSearchResults}>
                          {(() => {
                            const q = carSearch.trim().toLowerCase();
                            const filteredCars = q
                              ? cars.filter(c => c.name.toLowerCase().includes(q) || (c.plate_number || '').toLowerCase().includes(q))
                              : cars;
                            if (filteredCars.length === 0) {
                              return <div className={styles.memberSearchEmpty}>{t('da_noCarsFound')}</div>;
                            }
                            return filteredCars.map(c => {
                              const isBusy = busyCarIds.has(c.id);
                              const label = `${c.name}${c.plate_number ? ` – ${c.plate_number}` : ''}`;
                              return (
                                <div
                                  key={c.id}
                                  className={styles.memberSearchRow}
                                  onClick={() => selectCar(c.id, label, isBusy, busyCarInfo[c.id] || [])}
                                >
                                  <span className={styles.memberSearchName}>{label}</span>
                                  {isBusy && <span className={styles.chipBusyTag}>{t('da_assigned')}</span>}
                                </div>
                              );
                            });
                          })()}
                        </div>
                      )}

                      {carId && !carDropdownOpen && !carSearch.trim() && busyCarIds.has(carId) && (
                        <span className={styles.chipBusyTag} style={{ alignSelf: 'flex-start', marginTop: 4 }}>{t('da_assigned')}</span>
                      )}

                      {fieldErrors.carId && <span className={styles.fieldErrMsg}>{fieldErrors.carId}</span>}
                    </div>
                    <div className={styles.field}>
                      <label>{t('da_tripDriver')} <span className={styles.req}>*</span></label>
                      <select
                        className={fieldErrors.driverId ? styles.inputError : ''}
                        value={driverId}
                        onChange={e => { setDriverId(e.target.value); setFieldErrors(fe => ({ ...fe, driverId: '' })); }}
                      >
                        <option value="">{t('da_selectDriver')}</option>
                        {teamMembers.map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
                      </select>
                      {fieldErrors.driverId && <span className={styles.fieldErrMsg}>{fieldErrors.driverId}</span>}
                    </div>
                  </div>

                  <div className={styles.tripPointSection}>
                    <div className={styles.tripPointHeader}>
                      <span className={styles.tripPointHeaderDot} />
                      {t('da_tripStartPoint')}
                    </div>
                    <div className={styles.fieldsGrid}>
                      <div className={styles.field}>
                        <label>{t('da_tripSavedPoint')}</label>
                        <select
                          value={startPointId}
                          onChange={e => { onStartPointChange(e.target.value); resetCarTripCalc(); }}
                        >
                          <option value="">{t('da_tripSavedPointOptional')}</option>
                          {savedPoints.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </div>
                      <div className={styles.field}>
                        <label>{t('da_tripStartName')}</label>
                        <input
                          type="text"
                          placeholder={t('da_tripStartNamePh')}
                          value={startPointName}
                          onChange={e => setStartPointName(e.target.value)}
                        />
                      </div>
                      <div className={styles.field}>
                        <label>{t('da_tripStartLat')} <span className={styles.req}>*</span></label>
                        <input
                          className={fieldErrors.startLat ? styles.inputError : ''}
                          type="text"
                          inputMode="decimal"
                          placeholder="33.3152"
                          value={startLat}
                          onChange={e => { setStartLat(e.target.value); setFieldErrors(fe => ({ ...fe, startLat: '' })); resetCarTripCalc(); }}
                        />
                        {fieldErrors.startLat && <span className={styles.fieldErrMsg}>{fieldErrors.startLat}</span>}
                      </div>
                      <div className={styles.field}>
                        <label>{t('da_tripStartLng')} <span className={styles.req}>*</span></label>
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="44.3661"
                          value={startLng}
                          onChange={e => { setStartLng(e.target.value); resetCarTripCalc(); }}
                        />
                      </div>
                    </div>
                    <button type="button" className={styles.btnGhost} onClick={() => openMapPicker('start')}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 5, verticalAlign: -2 }}>
                        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                        <circle cx="12" cy="10" r="3"/>
                      </svg>
                      {t('da_tripPickOnMap')}
                    </button>
                  </div>

                  {stops.length === 0 && (
                    <div className={`${styles.tripPointSection} ${styles.tripPointSectionTarget}`}>
                      <div className={styles.tripPointHeader}>
                        <span className={`${styles.tripPointHeaderDot} ${styles.tripPointHeaderDotTarget}`} />
                        {t('da_tripTargetPoint')}
                      </div>
                      <div className={`${styles.targetStatus} ${styles.targetStatusMissing}`}>{t('da_siteRequired')}</div>
                    </div>
                  )}
                  {stops.map((stop, idx) => (
                    <div key={stop.site} className={`${styles.tripPointSection} ${styles.tripPointSectionTarget}`}>
                      <div className={styles.tripPointHeader}>
                        <span className={`${styles.tripPointHeaderDot} ${styles.tripPointHeaderDotTarget}`} />
                        {stops.length > 1
                          ? `${t('da_tripTargetPoint')} ${idx + 1}/${stops.length} — ${stop.site}`
                          : `${t('da_tripTargetPoint')} — ${stop.site}`}
                      </div>
                      {stop.found === true && (
                        <div className={`${styles.targetStatus} ${styles.targetStatusFound}`}>{t('da_tripTargetFoundInDb')}</div>
                      )}
                      {stop.found === false && (
                        <div className={`${styles.targetStatus} ${styles.targetStatusMissing}`}>{t('da_tripTargetNotInDb')}</div>
                      )}
                      <div className={styles.fieldsGrid}>
                        <div className={styles.field}>
                          <label>{t('da_tripTargetLat')} <span className={styles.req}>*</span></label>
                          <input
                            className={fieldErrors[`stopLat${idx}`] ? styles.inputError : ''}
                            type="text"
                            inputMode="decimal"
                            placeholder="33.3152"
                            value={stop.lat}
                            onChange={e => { setStopLatLng(idx, e.target.value, stop.lng); setFieldErrors(fe => ({ ...fe, [`stopLat${idx}`]: '' })); resetCarTripCalc(); }}
                          />
                          {fieldErrors[`stopLat${idx}`] && <span className={styles.fieldErrMsg}>{fieldErrors[`stopLat${idx}`]}</span>}
                        </div>
                        <div className={styles.field}>
                          <label>{t('da_tripTargetLng')} <span className={styles.req}>*</span></label>
                          <input
                            type="text"
                            inputMode="decimal"
                            placeholder="44.3661"
                            value={stop.lng}
                            onChange={e => { setStopLatLng(idx, stop.lat, e.target.value); resetCarTripCalc(); }}
                          />
                        </div>
                      </div>
                      <button type="button" className={styles.btnGhost} onClick={() => openMapPicker(idx)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 5, verticalAlign: -2 }}>
                          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                          <circle cx="12" cy="10" r="3"/>
                        </svg>
                        {t('da_tripPickOnMap')}
                      </button>
                    </div>
                  ))}

                  <label className={styles.roundTripToggle}>
                    <input
                      type="checkbox"
                      checked={roundTrip}
                      onChange={e => { setRoundTrip(e.target.checked); resetCarTripCalc(); }}
                    />
                    <span>{t('da_tripRoundTrip')}</span>
                  </label>

                  <div className={styles.tripCalcRow}>
                    <button type="button" className={styles.btnPrimary} onClick={calcCarTrip} disabled={tripCalculating}>
                      {tripCalculating ? t('da_tripCalculating') : t('da_tripCalculate')}
                    </button>
                    {fieldErrors.tripCalc && <span className={styles.fieldErrMsg}>{fieldErrors.tripCalc}</span>}
                    {tripCalcError && <span className={styles.fieldErrMsg}>{tripCalcError}</span>}
                  </div>

                  {tripDistanceKm != null && tripCostIqd != null && (
                    <div className={styles.tripResultBox}>
                      {roundTrip && (
                        <div className={styles.tripResultRow}>
                          <span className={styles.tripResultLabel}>{t('da_tripRoundTrip')}</span>
                          <span className={styles.tripResultValue}>{t('da_tripRoundTripIncluded')}</span>
                        </div>
                      )}
                      <div className={styles.tripResultRow}>
                        <span className={styles.tripResultLabel}>{t('da_tripDistance')}</span>
                        <span className={styles.tripResultValue}>{tripDistanceKm.toFixed(2)} km</span>
                      </div>
                      <div className={styles.tripResultRow}>
                        <span className={styles.tripResultLabel}>{t('da_tripRate')}</span>
                        <span className={styles.tripResultValue}>{getCarKmRate().toLocaleString()} IQD/km</span>
                      </div>
                      <div className={styles.tripResultRow}>
                        <span className={styles.tripResultLabel}>{t('da_tripCost')}</span>
                        <span className={styles.tripResultValueStrong}>{tripCostIqd.toLocaleString()} IQD</span>
                      </div>
                      <div className={styles.tripResultSource}>
                        {tripDistanceSource === 'road' ? t('da_tripSourceRoad') : t('da_tripSourceStraight')}
                      </div>
                    </div>
                  )}
                </div>
              )}
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
              {saving ? t('da_saving') : editingId ? t('da_updateActivity') : t('da_saveActivity')}
            </button>
            {editingId && (
              <button className={styles.btnGhost} onClick={cancelEdit}>{t('da_cancelEdit')}</button>
            )}
            <button className={`${styles.btnGhost} ${styles.btnWa}`} onClick={sendWa}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
              </svg>
              {t('da_sendToWhatsApp')}
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
            {t('da_historyTitle')}
            <span className={styles.countBadge}>{t('da_records', { count: sortedActivities.length })}</span>
          </div>

          <div className={styles.historyToolbar}>
            <div className={styles.searchBox}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input
                type="text"
                placeholder={t('da_searchHistPh')}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>
            <select className={styles.filterSelect} value={filterProject} onChange={e => setFilterProject(e.target.value)}>
              <option value="All">{t('da_allProjects')}</option>
              {projectNames.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <select className={styles.filterSelect} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="All">{t('da_allStatus')}</option>
              {STATUS_OPTIONS.map(s => <option key={s} value={s}>{t(STATUS_KEYS[s] ?? s)}</option>)}
            </select>
            <select
              className={styles.filterSelect}
              value=""
              title={t('da_quickRange')}
              onChange={e => { if (e.target.value) applyDatePreset(e.target.value as 'today' | 'week' | 'month'); }}
            >
              <option value="">{t('da_quickRange')}</option>
              <option value="today">{t('da_today_filter')}</option>
              <option value="week">{t('da_thisWeek')}</option>
              <option value="month">{t('da_thisMonth')}</option>
            </select>
            <div className={styles.dateRangeBox}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/>
                <line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
              <div className={styles.dateInputWrap}>
                <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
                {!dateFrom && <span className={styles.dateInputPlaceholder}>{t('da_fromPh')}</span>}
              </div>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={styles.dateRangeArrow}>
                <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
              </svg>
              <div className={styles.dateInputWrap}>
                <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
                {!dateTo && <span className={styles.dateInputPlaceholder}>{t('da_toPh')}</span>}
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
              {t('da_filters')}
              {hasAdvancedFilters && <span className={styles.filtersDot} />}
            </button>
            <button type="button" className={styles.exportBtn} title={t('da_export')} onClick={exportCsv}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              {t('da_export')}
            </button>
            <button type="button" className={styles.exportBtn} title="Team Report" onClick={() => setShowTeamReport(true)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
              Team Report
            </button>
            {hasActiveFilters && (
              <button type="button" className={styles.clearFiltersBtn} onClick={clearFilters}>
                {t('da_clearFilters')}
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
              <label>{t('da_activityTypeFilter')}</label>
              <select value={filterActivityType} onChange={e => setFilterActivityType(e.target.value)}>
                <option value="All">{t('da_allActivityTypes')}</option>
                {ACTIVITY_TYPES.map(atype => <option key={atype} value={atype}>{t(ACTIVITY_TYPE_KEYS[atype] ?? atype)}</option>)}
              </select>
            </div>
            <div className={styles.advFilterField}>
              <label>{t('da_issuedByFilter')}</label>
              <select value={filterIssuedBy} onChange={e => setFilterIssuedBy(e.target.value)}>
                <option value="">{t('da_allIssuers')}</option>
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
                  <span>{t('da_dateCol')}{sortIndicator('date')}</span>
                </th>
                <th className={styles.sortableTh} onClick={() => toggleSort('project')}>
                  <span>{t('da_projectCol')}{sortIndicator('project')}</span>
                </th>
                <th>{t('da_siteIdCol')}</th>
                <th>{t('da_governorateCol')}</th>
                <th>{t('da_teamCol')}</th>
                <th>{t('da_activityCol')}</th>
                <th className={styles.sortableTh} onClick={() => toggleSort('status')}>
                  <span>{t('da_statusCol')}{sortIndicator('status')}</span>
                </th>
                <th>{t('da_issuedByCol')}</th>
                <th>{t('da_actionsCol')}</th>
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
                <tr><td colSpan={9} className={styles.empty}>{visibleActivities.length === 0 ? t('da_noActivities') : t('da_noFilterMatch')}</td></tr>
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
                      {a.is_edited && <span className={styles.updatedBadge} title={updatedTitle}>{t('da_updated')}</span>}
                    </td>
                    <td data-label="Issued By" style={{ fontSize: 12.5, color: 'var(--slate-600)' }}>{a.created_by || '—'}</td>
                    <td data-label="Actions">
                      <div className={styles.actBtns}>
                        {hasPerm('da_edit_rows') && (
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
                        {hasPerm('da_delete_rows') && (
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
              ? t('da_noEntries')
              : t('da_showingEntries', { from: pageStart + 1, to: Math.min(pageStart + rowsPerPage, sortedActivities.length), total: sortedActivities.length })}
          </div>
          <div className={styles.paginationControls}>
            <select
              className={styles.rowsPerPageSelect}
              value={rowsPerPage}
              onChange={e => setRowsPerPage(Number(e.target.value))}
            >
              <option value={10}>10 {t('da_perPage')}</option>
              <option value={25}>25 {t('da_perPage')}</option>
              <option value={50}>50 {t('da_perPage')}</option>
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
            <p className={styles.modalTitle}>{t('da_reasonTitle')}</p>
            <p className={styles.modalSub}>{t('da_reasonSub')}</p>
            <input
              className={styles.modalInput}
              type="text"
              placeholder={t('da_reasonPh')}
              value={reasonVal}
              autoFocus
              onChange={e => { setReasonVal(e.target.value); setReasonErr(false); }}
              onKeyDown={e => { if (e.key === 'Enter') confirmReason(); if (e.key === 'Escape') cancelReason(); }}
            />
            <div className={styles.modalErr}>{reasonErr ? t('da_reasonRequired') : ''}</div>
            <div className={styles.modalActions}>
              <button className={styles.btnGhost} onClick={cancelReason}>{t('sidebar_cancel')}</button>
              <button className={styles.btnPrimary} onClick={confirmReason}>{t('da_confirmUpdate')}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Team Report Modal ── */}
      {showTeamReport && (
        <div className={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setShowTeamReport(false); }}>
          <div className={styles.modal} style={{ width: 360 }}>
            <p className={styles.modalTitle}>Team Report</p>
            <p className={styles.modalSub}>Select a month and year to export a full-team activity summary.</p>
            <div style={{ display: 'flex', gap: 10, margin: '16px 0' }}>
              <select
                style={{ flex: 1, height: 36, border: '1px solid #cbd5e1', borderRadius: 6, padding: '0 10px', fontSize: 13 }}
                value={trMonth}
                onChange={e => setTrMonth(+e.target.value)}
              >
                {FIN_MONTHS.map((mn, i) => <option key={i} value={i + 1}>{mn}</option>)}
              </select>
              <select
                style={{ width: 90, height: 36, border: '1px solid #cbd5e1', borderRadius: 6, padding: '0 10px', fontSize: 13 }}
                value={trYear}
                onChange={e => setTrYear(+e.target.value)}
              >
                {getYears().map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <div className={styles.modalActions}>
              <button className={styles.btnGhost} onClick={() => setShowTeamReport(false)}>Cancel</button>
              <button className={styles.btnPrimary} onClick={exportTeamReport} disabled={trExporting}>
                {trExporting ? 'Generating…' : 'Generate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── View Modal ── */}
      {viewActivity && (
        <div className={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setViewActivity(null); }}>
          <div className={styles.modal} style={{ width: 500 }}>
            <p className={styles.modalTitle}>{t('da_activityDetail')}</p>
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
                {t('da_shareWhatsApp')}
              </button>
              <button className={styles.btnPrimary} onClick={() => setViewActivity(null)}>{t('da_close')}</button>
            </div>
          </div>
        </div>
      )}

      {mapPickerOpen && (
        <div className={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setMapPickerOpen(false); }}>
          <div className={styles.modal} style={{ width: 560 }}>
            <div className={styles.modalTitle}>
              {typeof mapPickerMode === 'number'
                ? `${t('da_tripPickTargetOnMap')}${stops[mapPickerMode]?.site ? ` — ${stops[mapPickerMode].site}` : ''}`
                : t('da_tripPickOnMap')}
            </div>
            <div className={styles.modalSub}>{t('da_tripPickOnMapHint')}</div>

            <div className={styles.mapSearchWrap}>
              <svg className={styles.mapSearchIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input
                type="text"
                className={styles.mapSearchInput}
                placeholder={t('da_tripSearchLocationPh')}
                value={mapSearchQuery}
                onChange={e => onMapSearchChange(e.target.value)}
              />
              {mapSearching && <span className={styles.mapSearchSpinner} />}
            </div>
            {mapSearchResults.length > 0 && (
              <div className={styles.mapSearchResults}>
                {mapSearchResults.map(r => (
                  <div key={r.id} className={styles.mapSearchResultRow} onClick={() => selectMapSearchResult(r)}>
                    {r.placeName}
                  </div>
                ))}
              </div>
            )}

            <div ref={mapPickerContainerRef} className={styles.mapPickerMap} />
            <div className={styles.mapPickerCoords}>
              {mapPickedLat != null && mapPickedLng != null
                ? `${mapPickedLat.toFixed(6)}, ${mapPickedLng.toFixed(6)}`
                : '—'}
            </div>
            <div className={styles.modalActions}>
              <button type="button" className={styles.btnGhost} onClick={() => setMapPickerOpen(false)}>{t('da_cancel')}</button>
              <button type="button" className={styles.btnPrimary} onClick={confirmMapPicker}>{t('da_tripUseThisPoint')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
