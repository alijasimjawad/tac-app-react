import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';
import { haversineKm } from '../lib/sitesNearest';
import { cacheOk, getAllSites, ensureFullLoad } from '../lib/sitesCache';
import { getRoadRoute, hasRoadRoutingToken } from '../lib/roadRouting';
import { addBaseLayer, createStyleToggleControl } from '../lib/mapboxTiles';
import styles from './RoutePlanner.module.css';

// ── Types ────────────────────────────────────────────────────────────────────

interface Site {
  operator: string;
  site_code: string;
  site_name: string | null;
  governorate: string | null;
  latitude: number;
  longitude: number;
  _priority?: boolean;
}

interface Stop {
  site: Site;
  legKm: number;
  legMin: number;
  arrivalMin: number;
}

interface DayPlan {
  dayNum: number;
  stops: Stop[];
  distanceKm: number;
  minutes: number;
  /** True once distanceKm/minutes have been refined with a real ORS road
   *  route (see enrichRoadRoutes) — false/undefined means these are still
   *  the straight-line (haversine) estimates from plan generation. */
  road?: boolean;
}

interface TeamPlan {
  name: string;
  days: DayPlan[];
  leftover: Site[];
}

interface StartLoc {
  latitude: number;
  longitude: number;
  _label?: string;
}

interface Unmatched {
  code: string;
  reason: 'not_found' | 'missing_coordinates';
}

interface RoutePlan {
  operator: string;
  numTeams: number;
  requestedNumTeams: number;
  numDays: number;
  dailyHours: number;
  speed: number;
  teamsPlan: TeamPlan[];
  unmatched: Unmatched[];
  totalMatched: number;
  totalRequested: number;
  allLeftover: (Site & { team: string })[];
  leftoverCount: number;
  startLoc: StartLoc | null;
  startLocInvalid: boolean;
  startLocRaw: string;
  maxSitesPerTeam: number;
}

interface SavedRoutePlan {
  id: string;
  name: string;
  savedAt: string;
  plan: RoutePlan;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SAVED_PLANS_KEY = 'tac_route_planner_saved_plans';

const TEAM_COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];
// Line style per day (cycles if a team's plan runs past 4 days) — paired
// with the numbered marker badges so day 1 vs day 2 vs day 3 is readable
// on the map at a glance, not just team color.
const DAY_DASH: (string | undefined)[] = [undefined, '7,5', '2,5', '10,4,2,4'];

// ── Saved plans (browser localStorage only — no backend) ──────────────────────

function loadSavedPlansFromStorage(): SavedRoutePlan[] {
  try {
    const raw = localStorage.getItem(SAVED_PLANS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistSavedPlans(list: SavedRoutePlan[]) {
  try {
    localStorage.setItem(SAVED_PLANS_KEY, JSON.stringify(list));
  } catch {
    // Storage full/unavailable — saved plans just won't persist this time.
  }
}

// ── Pure algorithm functions (faithful ports) ─────────────────────────────────

function formatMin(min: number): string {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function parseCodes(text: string): string[] {
  return String(text || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

function resolveStartLoc(text: string, operator: string, sitesDB: Site[]): StartLoc | { _invalid: true; raw: string } | null {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const m = raw.match(/^(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)$/);
  if (m) return { latitude: parseFloat(m[1]), longitude: parseFloat(m[3]), _label: 'start location' };
  const row = sitesDB.find(r => (r.operator || '') === operator &&
    String(r.site_code || '').trim().toLowerCase() === raw.toLowerCase() &&
    r.latitude != null && r.longitude != null);
  if (row) return { latitude: row.latitude, longitude: row.longitude, _label: row.site_code };
  return { _invalid: true, raw };
}

function clusterIntoTeams(sites: Site[], numTeams: number): Site[][] {
  const n = Math.max(1, Math.min(numTeams, sites.length || 1));
  if (n <= 1 || sites.length <= 1) {
    const teams: Site[][] = [sites.slice()];
    while (teams.length < numTeams) teams.push([]);
    return teams;
  }
  const centLat = sites.reduce((s, r) => s + r.latitude, 0) / sites.length;
  const centLng = sites.reduce((s, r) => s + r.longitude, 0) / sites.length;
  const withAngle = sites.map(r => ({ r, ang: Math.atan2(r.latitude - centLat, r.longitude - centLng) }));
  withAngle.sort((a, b) => a.ang - b.ang);

  const teams: Site[][] = Array.from({ length: n }, () => []);
  const base = Math.floor(withAngle.length / n);
  const extra = withAngle.length % n;
  let idx = 0;
  for (let t = 0; t < n; t++) {
    const count = base + (t < extra ? 1 : 0);
    for (let k = 0; k < count; k++) { teams[t].push(withAngle[idx].r); idx++; }
  }
  while (teams.length < numTeams) teams.push([]);
  return teams;
}

function nearestNeighborRoute(sites: Site[], startLoc: StartLoc | null): Site[] {
  if (sites.length <= 1) return sites.slice();
  const remaining = sites.slice();
  const route: Site[] = [];
  const priorityPool = () => remaining.filter(r => r._priority);

  let refLat: number, refLng: number;
  if (startLoc) { refLat = startLoc.latitude; refLng = startLoc.longitude; }
  else {
    refLat = sites.reduce((s, r) => s + r.latitude, 0) / sites.length;
    refLng = sites.reduce((s, r) => s + r.longitude, 0) / sites.length;
  }

  let pool = priorityPool().length ? priorityPool() : remaining;
  let start = pool[0], startD = Infinity;
  for (const r of pool) {
    const d = haversineKm(refLat, refLng, r.latitude, r.longitude);
    if (d < startD) { startD = d; start = r; }
  }
  route.push(start);
  remaining.splice(remaining.indexOf(start), 1);
  let current = start;

  while (remaining.length) {
    pool = priorityPool().length ? priorityPool() : remaining;
    let best = pool[0], bestD = Infinity;
    for (const r of pool) {
      const d = haversineKm(current.latitude, current.longitude, r.latitude, r.longitude);
      if (d < bestD) { bestD = d; best = r; }
    }
    route.push(best);
    remaining.splice(remaining.indexOf(best), 1);
    current = best;
  }
  return route;
}

function twoOpt(route: Site[], fixFirst: boolean): Site[] {
  if (route.length < 4) return route.slice();
  const dist = (a: Site, b: Site) => haversineKm(a.latitude, a.longitude, b.latitude, b.longitude);
  const routeLen = (r: Site[]) => { let d = 0; for (let i = 0; i < r.length - 1; i++) d += dist(r[i], r[i + 1]); return d; };

  let best = route.slice();
  let bestDist = routeLen(best);
  let improved = true, iterations = 0;
  const maxIterations = 150;

  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;
    const startI = fixFirst ? 1 : 0;
    for (let i = startI; i < best.length - 2; i++) {
      for (let k = i + 1; k < best.length - 1; k++) {
        const candidate = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const candidateDist = routeLen(candidate);
        if (candidateDist < bestDist - 1e-9) {
          best = candidate; bestDist = candidateDist; improved = true;
        }
      }
    }
  }
  return best;
}

function optimizeRoute(orderedSites: Site[], startLoc: StartLoc | null): Site[] {
  let splitIdx = 0;
  while (splitIdx < orderedSites.length && orderedSites[splitIdx]._priority) splitIdx++;
  const prioritySeg = orderedSites.slice(0, splitIdx);
  const restSeg = orderedSites.slice(splitIdx);

  let optPriority: Site[];
  if (startLoc && prioritySeg.length) {
    optPriority = twoOpt([startLoc as unknown as Site, ...prioritySeg], true).slice(1);
  } else {
    optPriority = twoOpt(prioritySeg, false);
  }

  const anchor = optPriority.length ? optPriority[optPriority.length - 1] : (startLoc as unknown as Site | null);
  let optRest: Site[];
  if (anchor && restSeg.length) {
    optRest = twoOpt([anchor, ...restSeg], true).slice(1);
  } else {
    optRest = twoOpt(restSeg, false);
  }
  return [...optPriority, ...optRest];
}

function splitIntoDays(ordered: Site[], numDays: number, dailyMin: number, speed: number, startLoc: StartLoc | null, maxSitesPerTeam: number): { days: DayPlan[]; leftover: Site[] } {
  const result: DayPlan[] = [];
  const leftover: Site[] = [];
  let dayNum = 1, dayMin = 0, dayDistance = 0, stops: Stop[] = [];
  let prev: { latitude: number; longitude: number } | null = startLoc || null;
  let doneDays = false;

  // Spread this team's sites evenly across the requested number of days
  // instead of packing everything into day 1 whenever it fits the time
  // budget — e.g. 9 sites over 2 days should land ~5/4, not 9/0. If
  // Max Sites/Team is set tighter than that even split, it still wins
  // (it's a hard per-day cap); the daily time budget always wins too.
  const evenTarget = Math.ceil(ordered.length / numDays);
  const dayTargetCap = maxSitesPerTeam > 0 ? Math.min(maxSitesPerTeam, evenTarget) : evenTarget;

  const pushDay = () => {
    if (stops.length) result.push({ dayNum, stops, distanceKm: dayDistance, minutes: dayMin });
    stops = []; dayMin = 0; dayDistance = 0;
  };

  for (const site of ordered) {
    if (doneDays) { leftover.push(site); continue; }
    let legKm = 0, legMin = 0;
    if (prev) {
      legKm = haversineKm(prev.latitude, prev.longitude, site.latitude, site.longitude);
      legMin = (legKm / speed) * 60;
    }
    // A day is "full" once it hits the even-split target (or the tighter
    // Max Sites/Team cap, if set) — that's what forces the remaining sites
    // onto the next day instead of all being crammed into day 1.
    const dayFull = stops.length >= dayTargetCap;
    if (prev && (dayMin + legMin > dailyMin || dayFull)) {
      if (dayNum >= numDays) { pushDay(); doneDays = true; leftover.push(site); continue; }
      pushDay();
      dayNum++;
      if (legMin > dailyMin) { leftover.push(site); continue; }
      dayMin = legMin; dayDistance = legKm;
      stops.push({ site, legKm, legMin, arrivalMin: dayMin });
      prev = site;
    } else {
      dayMin += legMin; dayDistance += legKm;
      stops.push({ site, legKm, legMin, arrivalMin: dayMin });
      prev = site;
    }
  }
  pushDay();
  return { days: result, leftover };
}

function rebalanceLeftovers(teamsPlan: TeamPlan[], numDays: number, dailyMin: number, speed: number, maxSitesPerTeam: number): void {
  const pool: Site[] = [];
  teamsPlan.forEach(t => { pool.push(...t.leftover); t.leftover = []; });
  if (!pool.length) return;

  for (const site of pool) {
    let bestTeamIdx = -1, bestDayIdx = -1, bestCost = Infinity;

    for (let ti = 0; ti < teamsPlan.length; ti++) {
      const team = teamsPlan[ti];
      // Max Sites/Team is a per-day cap, so re-inserting a leftover into an
      // already-full day would silently violate it — only consider the
      // existing last day if it still has room. A brand-new day always has
      // room (it starts empty), so that branch below needs no extra check.
      const lastDayFull = team.days.length > 0 && maxSitesPerTeam > 0 &&
        team.days[team.days.length - 1].stops.length >= maxSitesPerTeam;
      if (team.days.length > 0 && !lastDayFull) {
        const lastDay = team.days[team.days.length - 1];
        const lastStop = lastDay.stops[lastDay.stops.length - 1];
        if (lastStop) {
          const legKm = haversineKm(lastStop.site.latitude, lastStop.site.longitude, site.latitude, site.longitude);
          const legMin = (legKm / speed) * 60;
          if (lastDay.minutes + legMin <= dailyMin) {
            if (legMin < bestCost) { bestCost = legMin; bestTeamIdx = ti; bestDayIdx = team.days.length - 1; }
          }
        }
      }
      if (team.days.length < numDays) {
        const newDayNum = team.days.length + 1;
        let legKm = 0, legMin = 0;
        if (team.days.length > 0) {
          const lastDay = team.days[team.days.length - 1];
          const lastStop = lastDay.stops[lastDay.stops.length - 1];
          if (lastStop) {
            legKm = haversineKm(lastStop.site.latitude, lastStop.site.longitude, site.latitude, site.longitude);
            legMin = (legKm / speed) * 60;
          }
        }
        if (legMin <= dailyMin && legMin < bestCost) {
          bestCost = legMin; bestTeamIdx = ti; bestDayIdx = newDayNum - 1;
        }
      }
    }

    if (bestTeamIdx === -1) { teamsPlan[0].leftover.push(site); continue; }

    const team = teamsPlan[bestTeamIdx];
    if (bestDayIdx < team.days.length) {
      const day = team.days[bestDayIdx];
      const lastStop = day.stops[day.stops.length - 1];
      const legKm = lastStop ? haversineKm(lastStop.site.latitude, lastStop.site.longitude, site.latitude, site.longitude) : 0;
      const legMin = (legKm / speed) * 60;
      day.minutes += legMin; day.distanceKm += legKm;
      day.stops.push({ site, legKm, legMin, arrivalMin: day.minutes });
    } else {
      const prevDay = team.days[team.days.length - 1];
      const lastStop = prevDay?.stops[prevDay.stops.length - 1];
      const legKm = lastStop ? haversineKm(lastStop.site.latitude, lastStop.site.longitude, site.latitude, site.longitude) : 0;
      const legMin = (legKm / speed) * 60;
      team.days.push({ dayNum: team.days.length + 1, stops: [{ site, legKm, legMin, arrivalMin: legMin }], distanceKm: legKm, minutes: legMin });
    }
  }
}

function generatePlan(
  operator: string, numTeamsRaw: number, numDays: number, dailyHours: number,
  speed: number, maxSitesPerTeam: number, startLocRaw: string,
  sitesText: string, priorityText: string, sitesDB: Site[]
): { plan: RoutePlan } | { error: string } {
  const rawCodes = parseCodes(sitesText);
  if (!rawCodes.length) return { error: 'Paste at least one site code.' };

  const prioritySet = new Set(parseCodes(priorityText).map(c => c.toLowerCase()));
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const c of rawCodes) { const k = c.toLowerCase(); if (!seen.has(k)) { seen.add(k); codes.push(c); } }

  const opRowsAll = sitesDB.filter(r => (r.operator || '') === operator);
  const opRowsGeo = opRowsAll.filter(r => r.latitude != null && r.longitude != null);

  const matched: Site[] = [];
  const unmatched: Unmatched[] = [];
  for (const c of codes) {
    const key = c.toLowerCase();
    const row = opRowsGeo.find(r => String(r.site_code || '').trim().toLowerCase() === key);
    if (row) { matched.push({ ...row, _priority: prioritySet.has(key) }); continue; }
    const anyRow = opRowsAll.find(r => String(r.site_code || '').trim().toLowerCase() === key);
    unmatched.push({ code: c, reason: anyRow ? 'missing_coordinates' : 'not_found' });
  }

  if (!matched.length) return { error: `None of the pasted codes matched a ${operator} site with coordinates in Sites DB. Check the codes and operator, then try again.` };

  const startLocResolved = resolveStartLoc(startLocRaw, operator, sitesDB);
  const startLocInvalid = !!(startLocResolved && '_invalid' in startLocResolved);
  const startLoc = (startLocResolved && !('_invalid' in startLocResolved)) ? startLocResolved as StartLoc : null;

  // Max Sites/Team is a per-day cap on each team, so the real capacity of a
  // team over the whole plan is maxSitesPerTeam × numDays — only bump the
  // team count if what you asked for (Teams × Days × Max) genuinely isn't
  // enough to cover every matched site.
  const actualNumTeams = maxSitesPerTeam > 0
    ? Math.max(numTeamsRaw, Math.ceil(matched.length / (maxSitesPerTeam * numDays)))
    : numTeamsRaw;

  const teamsSites = clusterIntoTeams(matched, actualNumTeams);
  const dailyMin = dailyHours * 60;
  const teamsPlan: TeamPlan[] = teamsSites.map((sites, idx) => {
    if (!sites.length) return { name: `Team ${idx + 1}`, days: [], leftover: [] };
    const nn = nearestNeighborRoute(sites, startLoc);
    const ordered = optimizeRoute(nn, startLoc);
    const split = splitIntoDays(ordered, numDays, dailyMin, speed, startLoc, maxSitesPerTeam);
    return { name: `Team ${idx + 1}`, days: split.days, leftover: split.leftover };
  });

  rebalanceLeftovers(teamsPlan, numDays, dailyMin, speed, maxSitesPerTeam);

  const allLeftover: (Site & { team: string })[] = [];
  teamsPlan.forEach(t => t.leftover.forEach(s => allLeftover.push({ ...s, team: t.name })));

  return {
    plan: {
      operator, numTeams: actualNumTeams, requestedNumTeams: numTeamsRaw, numDays, dailyHours, speed,
      teamsPlan, unmatched, totalMatched: matched.length, totalRequested: codes.length,
      allLeftover, leftoverCount: allLeftover.length,
      startLoc, startLocInvalid, startLocRaw: startLocRaw.trim(), maxSitesPerTeam,
    }
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function RoutePlanner() {
  const { hasPerm } = useAuth();
  const { t } = useTranslation();

  const [operators, setOperators] = useState<string[]>([]);
  const [sitesDB, setSitesDB] = useState<Site[]>([]);
  const [operator, setOperator] = useState('');
  const [numTeams, setNumTeams] = useState(2);
  const [numDays, setNumDays] = useState(1);
  const [dailyHours, setDailyHours] = useState(8);
  const [speed, setSpeed] = useState(40);
  const [maxSitesPerTeam, setMaxSitesPerTeam] = useState('');
  const [startLocRaw, setStartLocRaw] = useState('');
  const [startLocStatus, setStartLocStatus] = useState('');
  const [sitesText, setSitesText] = useState('');
  const [priorityCodes, setPriorityCodes] = useState<string[]>([]);
  const [priorityInput, setPriorityInput] = useState('');
  const [priorityMenuOpen, setPriorityMenuOpen] = useState(false);
  const [plan, setPlan] = useState<RoutePlan | null>(null);
  const [planError, setPlanError] = useState('');
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [activeTeam, setActiveTeam] = useState(0);
  // Real road paths from OpenRouteService, keyed by "${teamIdx}-${dayIdx}" —
  // populated asynchronously after a plan is generated (see
  // enrichRoadRoutes). Used by renderMapLayers to draw the actual driving
  // route instead of a straight line, once available for that team/day.
  const [roadRoutes, setRoadRoutes] = useState<Record<string, [number, number][]>>({});
  const [roadStatus, setRoadStatus] = useState<'idle' | 'loading' | 'done'>('idle');

  // Saved plans (localStorage) + Export Plan / Save Plan UI state
  const [savedPlans, setSavedPlans] = useState<SavedRoutePlan[]>(() => loadSavedPlansFromStorage());
  const [savedPlansOpen, setSavedPlansOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [savePlanName, setSavePlanName] = useState('');
  const [saveModalError, setSaveModalError] = useState('');

  const copyLabel = copied ? '✓ Copied' : t('rp_copyAsText');

  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const roadRunIdRef = useRef(0);

  useEffect(() => {
    let alive = true;
    function applyRows(rows: Site[]) {
      if (!alive) return;
      setSitesDB(rows);
      const ops = [...new Set(rows.map(r => r.operator).filter(Boolean))].sort();
      const opList = ops.length ? ops : ['Zain', 'Asia Cell'];
      setOperators(opList);
      setOperator(prev => prev || opList[0] || '');
    }
    if (cacheOk()) {
      applyRows(getAllSites() as Site[]);
    } else {
      ensureFullLoad(() => { applyRows(getAllSites() as Site[]); });
    }
    return () => { alive = false; };
  }, []);

  // Map lifecycle: init/teardown. The map is always shown alongside the
  // results now (no more separate List/Map toggle), so this only depends on
  // whether a plan exists.
  useEffect(() => {
    if (!plan) return;
    const t = setTimeout(() => {
      if (!mapDivRef.current) return;
      if (!mapRef.current) {
        const map = L.map(mapDivRef.current).setView([33.3152, 44.3661], 6);
        const baseLayer = { layer: addBaseLayer(map, 'streets') };
        createStyleToggleControl(map, baseLayer);
        mapRef.current = map;
        layerGroupRef.current = L.layerGroup().addTo(map);
      }
      renderMapLayers(plan, roadRoutes);
      setTimeout(() => { if (mapRef.current) mapRef.current.invalidateSize(); }, 50);
    }, 50);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, roadRoutes]);

  useEffect(() => {
    return () => {
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; layerGroupRef.current = null; }
    };
  }, []);

  // Keep map tiles sized correctly when entering/exiting the "View Full Map"
  // fullscreen mode — Leaflet caches container dimensions and needs a nudge
  // whenever they change outside of its own control.
  useEffect(() => {
    function onFsChange() {
      setTimeout(() => { if (mapRef.current) mapRef.current.invalidateSize(); }, 60);
    }
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  function renderMapLayers(p: RoutePlan, roads: Record<string, [number, number][]>) {
    if (!mapRef.current || !layerGroupRef.current) return;
    layerGroupRef.current.clearLayers();
    const allPts: [number, number][] = [];

    if (p.startLoc) {
      L.circleMarker([p.startLoc.latitude, p.startLoc.longitude], {
        radius: 9, color: '#111827', weight: 2, fillColor: '#fff', fillOpacity: 1,
      }).bindPopup(`<b>${p.startLoc._label || 'Start location'}</b>`).addTo(layerGroupRef.current);
      allPts.push([p.startLoc.latitude, p.startLoc.longitude]);
    }

    p.teamsPlan.forEach((team, ti) => {
      const color = TEAM_COLORS[ti % TEAM_COLORS.length];
      if (!team.days.length) return;

      // Draw one polyline per day (not one continuous line across the whole
      // plan) so a dashed/dotted style can mark day 2, day 3, etc. — the
      // team color alone no longer has to carry which day each stop is on.
      team.days.forEach((day, di) => {
        if (!day.stops.length) return;
        const dayLatlngs: [number, number][] = day.stops.map(s => [s.site.latitude, s.site.longitude]);
        const dashArray = DAY_DASH[di % DAY_DASH.length];
        const roadGeometry = roads[`${ti}-${di}`];

        if (roadGeometry) {
          // Real driving path from OpenRouteService — already includes the
          // leg from the start location / previous day's last stop, so it
          // replaces both the connector line and the straight stop-to-stop
          // line below with one real road-following polyline.
          L.polyline(roadGeometry, { color, weight: 3, opacity: 0.85, dashArray }).addTo(layerGroupRef.current!);
        } else {
          if (di === 0 && p.startLoc) {
            L.polyline([[p.startLoc.latitude, p.startLoc.longitude], dayLatlngs[0]], {
              color, weight: 2, opacity: 0.5, dashArray: '4,6',
            }).addTo(layerGroupRef.current!);
          } else if (di > 0) {
            // Thin connector from the previous day's last stop, so it's clear
            // day 2 continues from where day 1 left off, without implying
            // it's part of day 1's route.
            const prevDay = team.days[di - 1];
            const prevLast = prevDay.stops[prevDay.stops.length - 1];
            if (prevLast) {
              L.polyline([[prevLast.site.latitude, prevLast.site.longitude], dayLatlngs[0]], {
                color, weight: 1.5, opacity: 0.35, dashArray: '2,6',
              }).addTo(layerGroupRef.current!);
            }
          }

          L.polyline(dayLatlngs, { color, weight: 3, opacity: 0.85, dashArray }).addTo(layerGroupRef.current!);
        }

        day.stops.forEach((stop, si) => {
          const s = stop.site;
          const ring = s._priority ? '0 0 0 2px #fff, 0 0 0 4px #f59e0b' : '0 0 0 2px #fff';
          const icon = L.divIcon({
            className: '',
            html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};
              box-shadow:${ring};display:flex;align-items:center;justify-content:center;
              font:700 11px/1 inherit;color:#fff;">${day.dayNum}</div>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11],
          });
          L.marker([s.latitude, s.longitude], { icon })
            .bindPopup(`<div style="font-family:inherit;min-width:170px">
              <div style="font-weight:700;font-size:13px;margin-bottom:2px">${s.site_code || 'Site'}${s._priority ? ' ⭐' : ''}</div>
              <div style="font-size:12px;color:#64748b;margin-bottom:4px">${s.site_name || ''}</div>
              <div style="font-size:11.5px;color:#94a3b8">${team.name} · Day ${day.dayNum} · Stop ${si + 1}</div>
            </div>`)
            .addTo(layerGroupRef.current!);
          allPts.push([s.latitude, s.longitude]);
        });
      });
    });

    if (allPts.length) mapRef.current.fitBounds(allPts, { padding: [30, 30], maxZoom: 14 });
  }

  // After a plan is generated (with fast, synchronous straight-line
  // estimates), refine it with real road distances/times + a real driving
  // path from OpenRouteService — one request per team-per-day (not per leg,
  // which would blow through the free-tier rate limit fast). Runs in the
  // background; if a request fails or there's no ORS token configured, that
  // day's straight-line estimate is simply left as-is.
  async function enrichRoadRoutes(p: RoutePlan) {
    if (!hasRoadRoutingToken()) { setRoadStatus('idle'); return; }
    const runId = ++roadRunIdRef.current;
    setRoadStatus('loading');

    for (let ti = 0; ti < p.teamsPlan.length; ti++) {
      const team = p.teamsPlan[ti];
      for (let di = 0; di < team.days.length; di++) {
        if (runId !== roadRunIdRef.current) return; // a newer plan superseded this run
        const day = team.days[di];
        if (!day.stops.length) continue;

        // Mirror the same "previous point" chain the haversine estimates
        // use: day 1 starts from the start location (if any); later days
        // continue from the previous day's last stop.
        const prevPoint = di === 0
          ? p.startLoc
          : team.days[di - 1].stops[team.days[di - 1].stops.length - 1]?.site;
        const points = [
          ...(prevPoint ? [{ latitude: prevPoint.latitude, longitude: prevPoint.longitude }] : []),
          ...day.stops.map(s => ({ latitude: s.site.latitude, longitude: s.site.longitude })),
        ];
        if (points.length < 2) continue;

        const route = await getRoadRoute(points);
        if (!route || runId !== roadRunIdRef.current) continue;

        const key = `${ti}-${di}`;
        setRoadRoutes(prev => ({ ...prev, [key]: route.geometry }));
        setPlan(prev => {
          if (!prev) return prev;
          const teamsPlan = prev.teamsPlan.map((t, tix) => {
            if (tix !== ti) return t;
            const days = t.days.map((d, dix) => dix === di
              ? { ...d, distanceKm: route.distanceKm, minutes: route.minutes, road: true }
              : d);
            return { ...t, days };
          });
          return { ...prev, teamsPlan };
        });
      }
    }
    if (runId === roadRunIdRef.current) setRoadStatus('done');
  }

  async function handleGenerate() {
    setPlanError('');
    setGenerating(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    const result = generatePlan(
      operator, numTeams, numDays, dailyHours, speed,
      parseInt(maxSitesPerTeam) || 0, startLocRaw,
      sitesText, priorityCodes.join('\n'), sitesDB
    );
    setGenerating(false);
    if ('error' in result) { setPlanError(result.error); setPlan(null); return; }
    setPlan(result.plan);
    setActiveTeam(0);
    setRoadRoutes({});
    roadRunIdRef.current++;
    setRoadStatus('idle');
    if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; layerGroupRef.current = null; }
    void enrichRoadRoutes(result.plan);
  }

  function handleClear() {
    setPlan(null);
    setPlanError('');
    setRoadRoutes({});
    roadRunIdRef.current++;
    setRoadStatus('idle');
    setActiveTeam(0);
    if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; layerGroupRef.current = null; }
  }

  function handleUseMyLocation() {
    if (!navigator.geolocation) {
      setStartLocStatus('Geolocation is not available on this device/browser — enter coordinates or a site code manually.');
      return;
    }
    setStartLocStatus('Getting your location…');
    navigator.geolocation.getCurrentPosition(
      pos => {
        setStartLocRaw(`${pos.coords.latitude},${pos.coords.longitude}`);
        setStartLocStatus('Location set from GPS.');
      },
      () => setStartLocStatus('Could not get your location — enter coordinates or a site code manually.'),
      { timeout: 8000, enableHighAccuracy: true }
    );
  }

  // Site list: paste from clipboard / upload a .txt/.csv file / clear.
  async function handlePasteSites() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setSitesText(prev => (prev.trim() ? `${prev}\n${text}` : text));
    } catch {
      // Clipboard permission denied or unsupported — user can still paste manually.
    }
  }

  function handleUploadSitesClick() {
    fileInputRef.current?.click();
  }

  function handleSitesFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      setSitesText(prev => (prev.trim() ? `${prev}\n${text}` : text));
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function handleClearSites() {
    setSitesText('');
  }

  // Priority sites: chip-style multi-select, backed by a plain string[].
  function addPriorityCode(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    setPriorityCodes(prev => (prev.some(c => c.toLowerCase() === trimmed.toLowerCase()) ? prev : [...prev, trimmed]));
    setPriorityInput('');
  }

  function removePriorityCode(code: string) {
    setPriorityCodes(prev => prev.filter(c => c !== code));
  }

  function handlePriorityKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (priorityInput.trim()) addPriorityCode(priorityInput);
    } else if (e.key === 'Backspace' && !priorityInput && priorityCodes.length) {
      removePriorityCode(priorityCodes[priorityCodes.length - 1]);
    }
  }

  const prioritySuggestions = parseCodes(sitesText).filter(c =>
    !priorityCodes.some(p => p.toLowerCase() === c.toLowerCase()) &&
    (!priorityInput.trim() || c.toLowerCase().includes(priorityInput.trim().toLowerCase()))
  );

  function handleFullscreenMap() {
    const el = mapDivRef.current;
    if (!el) return;
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  }

  function handleCopyText() {
    if (!plan) return;
    const p = plan;
    const lines: string[] = [];
    lines.push(`ROUTE PLAN — ${p.operator}`);
    lines.push(`Teams: ${p.numTeams}  |  Days: ${p.numDays}  |  Daily Hours: ${p.dailyHours}h  |  Speed: ${p.speed} km/h`);
    lines.push('');
    p.teamsPlan.forEach(team => {
      lines.push(`── ${team.name} ──`);
      if (!team.days.length) lines.push('  No sites assigned.');
      team.days.forEach(day => {
        lines.push(`  Day ${day.dayNum} (${day.stops.length} sites, ${day.distanceKm.toFixed(1)} km, ${formatMin(day.minutes)}):`);
        day.stops.forEach((stop, si) => {
          const s = stop.site;
          const leg = si === 0 ? 'start' : `+${stop.legKm.toFixed(1)}km/${formatMin(stop.legMin)}`;
          lines.push(`    ${si + 1}. ${s.site_code || '—'}${s._priority ? ' [PRIORITY]' : ''} — ${s.site_name || '—'} (${leg})`);
        });
      });
      lines.push('');
    });
    if (p.unmatched.length) lines.push(`Not matched: ${p.unmatched.map(u => u.code).join(', ')}`);
    if (p.allLeftover.length) lines.push(`Left over (didn't fit): ${p.allLeftover.map(s => `${s.site_code} (${s.team})`).join(', ')}`);

    navigator.clipboard.writeText(lines.join('\n'))
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => alert('Could not copy to clipboard.'));
    setExportMenuOpen(false);
  }

  function csvEscape(val: string | number): string {
    const s = String(val);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function handleDownloadCsv() {
    if (!plan) return;
    const rows: (string | number)[][] = [
      ['Team', 'Day', 'Stop #', 'Site Code', 'Site Name', 'Governorate', 'Priority', 'Leg Km', 'Leg Min', 'Cumulative Km', 'Cumulative Min'],
    ];
    plan.teamsPlan.forEach(team => {
      team.days.forEach(day => {
        let cumKm = 0, cumMin = 0;
        day.stops.forEach((stop, si) => {
          cumKm += stop.legKm;
          cumMin += stop.legMin;
          rows.push([
            team.name, day.dayNum, si + 1,
            stop.site.site_code || '', stop.site.site_name || '', stop.site.governorate || '',
            stop.site._priority ? 'Yes' : 'No',
            stop.legKm.toFixed(2), Math.round(stop.legMin),
            cumKm.toFixed(2), Math.round(cumMin),
          ]);
        });
      });
    });
    const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `route-plan-${plan.operator || 'plan'}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setExportMenuOpen(false);
  }

  // ── Save Plan / Saved Plans (localStorage) ──────────────────────────────────

  function handleSavePlanClick() {
    if (!plan) return;
    setSavePlanName(`${plan.operator || 'Plan'} – ${new Date().toLocaleDateString()}`);
    setSaveModalError('');
    setSaveModalOpen(true);
  }

  function handleConfirmSavePlan() {
    if (!plan) return;
    const name = savePlanName.trim();
    if (!name) { setSaveModalError('Please enter a name for this plan.'); return; }
    const entry: SavedRoutePlan = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      savedAt: new Date().toISOString(),
      plan,
    };
    const next = [entry, ...savedPlans];
    setSavedPlans(next);
    persistSavedPlans(next);
    setSaveModalOpen(false);
  }

  function handleLoadSavedPlan(entry: SavedRoutePlan) {
    setPlan(entry.plan);
    setActiveTeam(0);
    setPlanError('');
    setRoadRoutes({});
    roadRunIdRef.current++;
    setRoadStatus('idle');
    if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; layerGroupRef.current = null; }
    setSavedPlansOpen(false);
    void enrichRoadRoutes(entry.plan);
  }

  function handleDeleteSavedPlan(id: string) {
    const next = savedPlans.filter(sp => sp.id !== id);
    setSavedPlans(next);
    persistSavedPlans(next);
  }

  // Stepper logic
  const siteCount = parseCodes(sitesText).length;
  const stepperStep = plan ? 3 : siteCount > 0 ? 2 : 1;

  if (!hasPerm('view_route_planner')) {
    return (
      <div className={styles.page}>
        <div className={styles.denied}>{t('rp_noPermission')}</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* Info banner + saved-plan actions */}
      <div className={styles.topBar}>
        <div className={styles.infoBanner}>
          <InfoIcon />
          <p className={styles.infoBannerText}>
            {t('rp_infoBanner')}
          </p>
        </div>
        <div className={styles.topBarActions}>
          <div className={styles.savedPlansWrap}>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => setSavedPlansOpen(o => !o)}
              title="Saved plans"
            >
              <SavedPlansIcon /> {t('rp_savedPlans')}{savedPlans.length ? ` (${savedPlans.length})` : ''}
            </button>
            {savedPlansOpen && (
              <>
                <div className={styles.menuBackdrop} onClick={() => setSavedPlansOpen(false)} />
                <div className={styles.savedPlansMenu}>
                  <div className={styles.savedPlansTitle}>{t('rp_savedPlans')}</div>
                  {savedPlans.length === 0 && (
                    <div className={styles.savedPlansEmpty}>{t('rp_noSavedPlans')}</div>
                  )}
                  {savedPlans.map(sp => (
                    <div key={sp.id} className={styles.savedPlanRow}>
                      <div className={styles.savedPlanInfo} onClick={() => handleLoadSavedPlan(sp)}>
                        <span className={styles.savedPlanName}>{sp.name}</span>
                        <span className={styles.savedPlanMeta}>
                          {sp.plan.operator} · {sp.plan.numTeams} team(s) · {new Date(sp.savedAt).toLocaleString()}
                        </span>
                      </div>
                      <button
                        type="button"
                        className={styles.savedPlanDeleteBtn}
                        title="Delete"
                        aria-label="Delete saved plan"
                        onClick={() => handleDeleteSavedPlan(sp.id)}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <button type="button" className={styles.generateBtn} style={{ flex: 'none' }} onClick={handleClear} title="Start a new plan">
            {t('rp_newPlan')}
          </button>
        </div>
      </div>

      {saveModalOpen && (
        <div className={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setSaveModalOpen(false); }}>
          <div className={styles.modal}>
            <h3 className={styles.modalTitle}>{t('rp_saveTitle')}</h3>
            <p className={styles.modalSub}>{t('rp_saveSub')}</p>
            <input
              type="text"
              className={styles.modalInput}
              value={savePlanName}
              onChange={e => setSavePlanName(e.target.value)}
              placeholder="e.g. Zain – North teams – Aug 3"
              autoFocus
              onKeyDown={e => { if (e.key === 'Enter') handleConfirmSavePlan(); }}
            />
            <div className={styles.modalErr}>{saveModalError}</div>
            <div className={styles.modalActions}>
              <button className={styles.secondaryBtn} onClick={() => setSaveModalOpen(false)}>{t('rp_cancel')}</button>
              <button className={styles.generateBtn} onClick={handleConfirmSavePlan}>{t('rp_save')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Stepper */}
      <div className={styles.stepper}>
        <div className={styles.stepItem}>
          <div className={`${styles.stepDot} ${stepperStep >= 1 ? (stepperStep > 1 ? styles.stepDotDone : styles.stepDotActive) : ''}`}>
            {stepperStep > 1 ? <CheckSmIcon /> : '1'}
          </div>
          <div className={styles.stepText}>
            <span className={`${styles.stepLabel} ${stepperStep === 1 ? styles.stepLabelActive : stepperStep > 1 ? styles.stepLabelDone : ''}`}>
              {t('rp_configure')}
            </span>
            <span className={styles.stepSub}>{t('rp_setRules')}</span>
          </div>
        </div>
        <div className={`${styles.stepLine} ${stepperStep > 1 ? styles.stepLineDone : ''}`} />
        <div className={styles.stepItem}>
          <div className={`${styles.stepDot} ${stepperStep >= 2 ? (stepperStep > 2 ? styles.stepDotDone : styles.stepDotActive) : ''}`}>
            {stepperStep > 2 ? <CheckSmIcon /> : '2'}
          </div>
          <div className={styles.stepText}>
            <span className={`${styles.stepLabel} ${stepperStep === 2 ? styles.stepLabelActive : stepperStep > 2 ? styles.stepLabelDone : ''}`}>
              {t('rp_addSites')}
            </span>
            <span className={styles.stepSub}>{t('rp_pasteUpload')}</span>
          </div>
        </div>
        <div className={`${styles.stepLine} ${stepperStep > 2 ? styles.stepLineDone : ''}`} />
        <div className={styles.stepItem}>
          <div className={`${styles.stepDot} ${stepperStep >= 3 ? styles.stepDotActive : ''}`}>
            3
          </div>
          <div className={styles.stepText}>
            <span className={`${styles.stepLabel} ${stepperStep === 3 ? styles.stepLabelActive : ''}`}>
              {t('rp_reviewPlan')}
            </span>
            <span className={styles.stepSub}>{t('rp_genItinerary')}</span>
          </div>
        </div>
      </div>

      {/* Two-column workspace */}
      <div className={styles.workspace}>

        {/* ── Left: Config panel ── */}
        <div className={styles.configPanel}>
          <div className={styles.configPanelHead}>
            <p className={styles.configPanelTitle}>{t('rp_planConfig')}</p>
            <p className={styles.configPanelSub}>{t('rp_configSub')}</p>
          </div>

          {/* Plan Basics */}
          <div className={styles.configSection}>
            <div className={styles.configSectionLabel}>{t('rp_planBasics')}</div>
            <div className={styles.field} style={{ marginBottom: 10 }}>
              <label className={styles.fieldLabel}>{t('rp_operator')}</label>
              <select value={operator} onChange={e => setOperator(e.target.value)}>
                {operators.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div className={styles.grid3}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>{t('rp_teams')}</label>
                <input type="number" min={1} max={20} value={numTeams}
                  onChange={e => setNumTeams(Math.max(1, parseInt(e.target.value) || 1))} />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>{t('rp_days')}</label>
                <input type="number" min={1} max={30} value={numDays}
                  onChange={e => setNumDays(Math.max(1, parseInt(e.target.value) || 1))} />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>{t('rp_hoursPerDay')}</label>
                <input type="number" min={1} max={16} step={0.5} value={dailyHours}
                  onChange={e => setDailyHours(Math.max(0.5, parseFloat(e.target.value) || 8))} />
              </div>
            </div>
          </div>

          {/* Travel Rules */}
          <div className={styles.configSection}>
            <div className={styles.configSectionLabel}>{t('rp_travelRules')}</div>
            <div className={styles.grid2}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>{t('rp_speedKmh')}</label>
                <input type="number" min={5} max={140} value={speed}
                  onChange={e => setSpeed(Math.max(1, parseFloat(e.target.value) || 40))} />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>{t('rp_maxSites')}</label>
                <input type="number" min={1} max={200} placeholder="optional"
                  value={maxSitesPerTeam} onChange={e => setMaxSitesPerTeam(e.target.value)} />
              </div>
            </div>
            {maxSitesPerTeam && (
              <div className={styles.fieldHint} style={{ marginTop: 6 }}>
                Each team visits at most {maxSitesPerTeam} sites per day. Teams only increase beyond what you set if Teams × Days × Max isn't enough to cover every site.
              </div>
            )}
            <div className={styles.field} style={{ marginTop: 10 }}>
              <label className={styles.fieldLabel}>{t('rp_startLoc')}</label>
              <div className={styles.startLocRow}>
                <input
                  type="text"
                  className={styles.startLocInput}
                  placeholder='e.g. ZN-00123 or 33.31,44.36'
                  value={startLocRaw}
                  onChange={e => setStartLocRaw(e.target.value)}
                />
                <button type="button" className={styles.secondaryBtn} onClick={handleUseMyLocation}>
                  <PinIcon />
                </button>
              </div>
              {startLocStatus && <div className={styles.fieldHint}>{startLocStatus}</div>}
            </div>
          </div>

          {/* Site List */}
          <div className={styles.configSection}>
            <div className={styles.sectionHeadRow}>
              <div className={styles.configSectionLabel} style={{ marginBottom: 0 }}>{t('rp_siteList')}</div>
              <div className={styles.sectionHeadActions}>
                <button type="button" className={styles.iconBtnSm} title="Paste from clipboard" aria-label="Paste from clipboard" onClick={handlePasteSites}>
                  <ClipboardPasteIcon />
                </button>
                <button type="button" className={styles.iconBtnSm} title="Upload a file" aria-label="Upload a file" onClick={handleUploadSitesClick}>
                  <UploadIcon />
                </button>
                <button type="button" className={styles.iconBtnSm} title="Clear list" aria-label="Clear list" onClick={handleClearSites}>
                  <EraserIcon />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.csv"
                  style={{ display: 'none' }}
                  onChange={handleSitesFileChange}
                />
              </div>
            </div>
            <div className={styles.field} style={{ marginTop: 8 }}>
              <div className={styles.textareaWrap}>
                <textarea
                  className={styles.textarea}
                  placeholder={'ZN-00123\nZN-00456\nZN-00789...'}
                  value={sitesText}
                  onChange={e => setSitesText(e.target.value)}
                />
                {siteCount > 0 && (
                  <span className={styles.textareaBadge}>{siteCount} valid</span>
                )}
              </div>
              <div className={styles.fieldHint}>{t('rp_onePerLine')}</div>
            </div>
          </div>

          {/* Priority Sites */}
          <div className={styles.configSection}>
            <div className={styles.configSectionLabel}>{t('rp_prioritySites')} <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>{t('rp_visitedFirst')}</span></div>
            <div className={styles.chipInputWrap}>
              <div className={styles.chipField}>
                {priorityCodes.map(code => (
                  <span key={code} className={styles.chip}>
                    {code}
                    <button type="button" className={styles.chipRemove} onClick={() => removePriorityCode(code)} aria-label={`Remove ${code}`}>
                      <XIcon />
                    </button>
                  </span>
                ))}
                <input
                  className={styles.chipInput}
                  value={priorityInput}
                  placeholder={priorityCodes.length ? '' : t('rp_typeOrPick')}
                  onChange={e => setPriorityInput(e.target.value)}
                  onKeyDown={handlePriorityKeyDown}
                  onFocus={() => setPriorityMenuOpen(true)}
                  onBlur={() => setTimeout(() => setPriorityMenuOpen(false), 120)}
                />
                <ChevronDownIcon />
              </div>
              {priorityMenuOpen && prioritySuggestions.length > 0 && (
                <div className={styles.chipDropdown}>
                  {prioritySuggestions.slice(0, 30).map(code => (
                    <button
                      type="button"
                      key={code}
                      className={styles.chipDropdownItem}
                      onMouseDown={e => { e.preventDefault(); addPriorityCode(code); }}
                    >
                      {code}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Footer actions */}
          <div className={styles.configFooter}>
            <button className={styles.generateBtn} onClick={handleGenerate} disabled={generating || !sitesText.trim()}>
              {generating ? <SpinnerInlineIcon /> : <SendIcon />}
              {generating ? t('rp_generating') : t('rp_generatePlan')}
            </button>
            <button className={styles.secondaryBtn} onClick={handleClear} title="Reset">
              <TrashIcon />
            </button>
          </div>
        </div>

        {/* ── Right: Results panel ── */}
        <div className={styles.resultsPanel}>

          {generating && (
            <div className={styles.spinnerState}>
              <div className={styles.spinner} />
              <div className={styles.spinnerText}>{t('rp_buildingPlan')}</div>
              <div className={styles.spinnerSub}>{t('rp_buildingSub')}</div>
            </div>
          )}

          {!generating && planError && (
            <div className={styles.errorBanner}>
              <AlertIcon /> <div>{planError}</div>
            </div>
          )}

          {!generating && !plan && !planError && (
            <RoutePlannerEmptyState />
          )}

          {!generating && plan && (
            <PlanResults
              plan={plan}
              activeTeam={activeTeam}
              onCopyText={handleCopyText}
              copyLabel={copyLabel}
              mapDivRef={mapDivRef}
              onSelectTeam={setActiveTeam}
              onFullscreenMap={handleFullscreenMap}
              roadStatus={roadStatus}
              exportMenuOpen={exportMenuOpen}
              onToggleExportMenu={() => setExportMenuOpen(o => !o)}
              onCloseExportMenu={() => setExportMenuOpen(false)}
              onDownloadCsv={handleDownloadCsv}
              onSavePlanClick={handleSavePlanClick}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────────

function RoutePlannerEmptyState() {
  const { t } = useTranslation();
  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyIcon}>
        <MapEmptyIcon />
      </div>
      <p className={styles.emptyTitle}>{t('rp_noplanTitle')}</p>
      <p className={styles.emptyDesc}>{t('rp_noplanDesc')}</p>
      <div className={styles.emptySteps}>
        <div className={styles.emptyStep}>
          <span className={styles.emptyStepNum}>1</span>
          {t('rp_step1')}
        </div>
        <div className={styles.emptyStep}>
          <span className={styles.emptyStepNum}>2</span>
          {t('rp_step2')}
        </div>
        <div className={styles.emptyStep}>
          <span className={styles.emptyStepNum}>3</span>
          {t('rp_step3')}
        </div>
      </div>
    </div>
  );
}

// ── Results sub-component ──────────────────────────────────────────────────────

function PlanResults({
  plan, activeTeam, onCopyText, copyLabel, mapDivRef, onSelectTeam, onFullscreenMap, roadStatus,
  exportMenuOpen, onToggleExportMenu, onCloseExportMenu, onDownloadCsv, onSavePlanClick,
}: {
  plan: RoutePlan;
  activeTeam: number;
  onCopyText: () => void;
  copyLabel: string;
  mapDivRef: React.RefObject<HTMLDivElement | null>;
  onSelectTeam: (i: number) => void;
  onFullscreenMap: () => void;
  roadStatus: 'idle' | 'loading' | 'done';
  exportMenuOpen: boolean;
  onToggleExportMenu: () => void;
  onCloseExportMenu: () => void;
  onDownloadCsv: () => void;
  onSavePlanClick: () => void;
}) {
  const { t } = useTranslation();
  const notFound = plan.unmatched.filter(u => u.reason === 'not_found');
  const noCoord = plan.unmatched.filter(u => u.reason === 'missing_coordinates');
  const totalDistanceKm = plan.teamsPlan.reduce((s, tm) => s + tm.days.reduce((s2, d) => s2 + d.distanceKm, 0), 0);
  const totalMinutes = plan.teamsPlan.reduce((s, tm) => s + tm.days.reduce((s2, d) => s2 + d.minutes, 0), 0);

  return (
    <>
      {/* Summary stat cards */}
      <div className={styles.summaryGrid}>
        <div className={styles.summaryCard}>
          <div className={`${styles.summaryIconBox} ${styles.iconBlue}`}><TargetIcon /></div>
          <div className={styles.summaryTextCol}>
            <span className={styles.summaryLabel}>{t('rp_sitesMatched')}</span>
            <span className={`${styles.summaryVal} ${styles.summaryValGood}`}>{plan.totalMatched}</span>
            <span className={styles.summarySub}>of {plan.totalRequested} pasted</span>
          </div>
        </div>
        <div className={styles.summaryCard}>
          <div className={`${styles.summaryIconBox} ${styles.iconPurple}`}><TeamsIcon /></div>
          <div className={styles.summaryTextCol}>
            <span className={styles.summaryLabel}>{t('rp_teamsLabel')}</span>
            <span className={styles.summaryVal}>{plan.numTeams}</span>
            <span className={styles.summarySub}>{t('rp_teamsCount')}</span>
          </div>
        </div>
        <div className={styles.summaryCard}>
          <div className={`${styles.summaryIconBox} ${styles.iconAmber}`}><SearchXIcon /></div>
          <div className={styles.summaryTextCol}>
            <span className={styles.summaryLabel}>{t('rp_notFound')}</span>
            <span className={`${styles.summaryVal} ${plan.unmatched.length > 0 ? styles.summaryValWarn : ''}`}>
              {plan.unmatched.length}
            </span>
            <span className={styles.summarySub}>{t('rp_unmatched')}</span>
          </div>
        </div>
        <div className={styles.summaryCard}>
          <div className={`${styles.summaryIconBox} ${styles.iconRed}`}><WarnTriangleIcon /></div>
          <div className={styles.summaryTextCol}>
            <span className={styles.summaryLabel}>{t('rp_leftOver')}</span>
            <span className={`${styles.summaryVal} ${plan.leftoverCount > 0 ? styles.summaryValBad : ''}`}>
              {plan.leftoverCount}
            </span>
            <span className={styles.summarySub}>{t('rp_didntFit')}</span>
          </div>
        </div>
        <div className={styles.summaryCard}>
          <div className={`${styles.summaryIconBox} ${styles.iconCyan}`}><RouteDistanceIcon /></div>
          <div className={styles.summaryTextCol}>
            <span className={styles.summaryLabel}>{t('rp_estDistance')}</span>
            <span className={styles.summaryVal}>{totalDistanceKm.toFixed(0)} km</span>
            <span className={styles.summarySub}>{roadStatus === 'done' ? t('rp_realRoad') : roadStatus === 'loading' ? t('rp_refining') : t('rp_straightLine')}</span>
          </div>
        </div>
        <div className={styles.summaryCard}>
          <div className={`${styles.summaryIconBox} ${styles.iconIndigo}`}><ClockDurationIcon /></div>
          <div className={styles.summaryTextCol}>
            <span className={styles.summaryLabel}>{t('rp_estTime')}</span>
            <span className={styles.summaryVal}>{formatMin(totalMinutes)}</span>
            <span className={styles.summarySub}>{t('rp_totalTime')}</span>
          </div>
        </div>
      </div>

      {/* Alerts */}
      {plan.unmatched.length > 0 && (
        <div className={`${styles.alert} ${styles.alertAmber}`}>
          <AlertIcon />
          <div>
            {notFound.length > 0 && (
              <div><b>{notFound.length} code(s) not found</b> in {plan.operator} Sites DB:{' '}
                {notFound.map(u => <code key={u.code} className={styles.code}>{u.code}</code>)}
              </div>
            )}
            {noCoord.length > 0 && (
              <div style={{ marginTop: notFound.length ? 6 : 0 }}>
                <b>{noCoord.length} code(s) missing coordinates</b>:{' '}
                {noCoord.map(u => <code key={u.code} className={styles.code}>{u.code}</code>)}
              </div>
            )}
          </div>
        </div>
      )}

      {plan.startLocInvalid && (
        <div className={`${styles.alert} ${styles.alertAmber}`}>
          <AlertIcon />
          <div><b>Start location not recognized:</b> "{plan.startLocRaw}" — routes built without a fixed start point.</div>
        </div>
      )}

      {!plan.startLocInvalid && plan.startLoc && (
        <div className={`${styles.alert} ${styles.alertBlue}`}>
          <ClockAlertIcon />
          <div>Routes start from <b>{plan.startLoc._label || 'custom location'}</b>.</div>
        </div>
      )}

      {plan.maxSitesPerTeam > 0 && plan.numTeams > plan.requestedNumTeams && (
        <div className={`${styles.alert} ${styles.alertBlue}`}>
          <ClockAlertIcon />
          <div>Team count increased from <b>{plan.requestedNumTeams}</b> to <b>{plan.numTeams}</b> — {plan.requestedNumTeams} team(s) over {plan.numDays} day(s) couldn't cover every site at <b>{plan.maxSitesPerTeam}</b>/day per team.</div>
        </div>
      )}

      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <div className={styles.exportWrap}>
            <button className={styles.copyBtn} onClick={onToggleExportMenu}>
              <DownloadIcon /> {t('rp_exportPlan')} <ChevronDownIcon />
            </button>
            {exportMenuOpen && (
              <>
                <div className={styles.menuBackdrop} onClick={onCloseExportMenu} />
                <div className={styles.exportMenu}>
                  <button className={styles.exportMenuItem} onClick={onCopyText}>
                    <CopyIcon /> {copyLabel}
                  </button>
                  <button className={styles.exportMenuItem} onClick={onDownloadCsv}>
                    <DownloadIcon /> {t('rp_downloadCSV')}
                  </button>
                </div>
              </>
            )}
          </div>
          <button className={styles.copyBtn} onClick={onSavePlanClick}>
            <SaveIcon /> {t('rp_savePlan')}
          </button>
        </div>
        <div className={styles.toolbarRight}>
          <button className={styles.copyBtn} onClick={onFullscreenMap}>
            <ExpandIcon /> {t('rp_viewFullMap')}
          </button>
        </div>
      </div>

      {/* Map — always shown above the results now */}
      <div className={styles.mapWrap}>
        <div ref={mapDivRef} className={styles.mapBox} />
        <MapLegend plan={plan} roadStatus={roadStatus} />
      </div>

      {/* Team tabs */}
      {plan.numTeams > 1 && (
        <div className={styles.teamTabs}>
          {plan.teamsPlan.map((team, ti) => {
            const count = team.days.reduce((s, d) => s + d.stops.length, 0);
            const color = TEAM_COLORS[ti % TEAM_COLORS.length];
            const isActive = activeTeam === ti;
            return (
              <button
                key={ti}
                className={`${styles.teamTab} ${isActive ? styles.teamTabActive : ''}`}
                style={isActive ? { background: color, borderColor: color } : {}}
                onClick={() => onSelectTeam(ti)}
              >
                <span className={styles.teamTabDot} style={{ background: isActive ? '#fff' : color }} />
                {team.name}
                <span className={styles.teamTabCount}>· {count}</span>
              </button>
            );
          })}
        </div>
      )}

      {plan.teamsPlan.map((team, ti) => {
        if (plan.numTeams > 1 && ti !== activeTeam) return null;
        const totalKm = team.days.reduce((s, d) => s + d.distanceKm, 0);
        const totalMin = team.days.reduce((s, d) => s + d.minutes, 0);
        const totalStops = team.days.reduce((s, d) => s + d.stops.length, 0);
        const color = TEAM_COLORS[ti % TEAM_COLORS.length];
        return (
          <div key={ti} className={styles.teamCard}>
            <div className={styles.teamHead}>
              <div className={styles.teamName}>
                <span className={styles.teamBadge} style={{ background: color }}>{ti + 1}</span>
                {team.name}
              </div>
              <div className={styles.teamTotals}>
                <span><b>{totalStops}</b> {t('rp_sites')}</span>
                <span><b>{totalKm.toFixed(1)}</b> {t('rp_km')}</span>
                <span><b>{formatMin(totalMin)}</b> {t('rp_drive')}</span>
              </div>
            </div>
            {!team.days.length && (
              <div className={styles.noSites}>{t('rp_noSitesAssigned')}</div>
            )}
            {!!team.days.length && (
              <div className={styles.daysGrid}>
                {team.days.map(day => (
                  <div key={day.dayNum} className={styles.dayCard}>
                    <div className={styles.dayHead}>
                      <span className={styles.dayTitle}>{t('rp_day')} {day.dayNum}</span>
                      <span className={styles.dayMeta}>
                        <span className={styles.dayMetaChip}>{day.stops.length} {t('rp_sites')}</span>
                        <span className={styles.dayMetaChip} title={day.road ? 'Real road distance (OpenRouteService)' : 'Straight-line estimate'}>
                          {day.distanceKm.toFixed(1)} {t('rp_km')}{day.road ? ' 🛣️' : ''}
                        </span>
                        <span className={styles.dayMetaChip}>{formatMin(day.minutes)} {t('rp_drive')}</span>
                      </span>
                    </div>
                    <div className={styles.timeline}>
                      {day.stops.map((stop, si) => {
                        const s = stop.site;
                        const isVeryFirst = day.dayNum === 1 && si === 0;
                        let legLabel: string;
                        if (isVeryFirst && !plan.startLoc) legLabel = t('rp_routeStart');
                        else if (isVeryFirst && plan.startLoc) legLabel = `${stop.legKm.toFixed(1)} km · ~${formatMin(stop.legMin)} from ${plan.startLoc._label || 'start'}`;
                        else if (si === 0) legLabel = stop.legMin > 0 ? `${stop.legKm.toFixed(1)} km · ~${formatMin(stop.legMin)} continuing` : 'Continues from previous day';
                        else legLabel = `${stop.legKm.toFixed(1)} km · ~${formatMin(stop.legMin)} from prev`;
                        return (
                          <div key={si} className={styles.stop}>
                            <div className={`${styles.stopDot} ${s._priority ? styles.stopDotPriority : ''}`} style={{ background: color, borderColor: color }}>
                              {si + 1}
                            </div>
                            <div className={styles.stopBody}>
                              <div className={styles.stopCode}>
                                {s.site_code || '—'}
                                {s._priority && <span className={styles.priorityChip}>{t('rp_priority')}</span>}
                              </div>
                              <div className={styles.stopName}>{s.site_name || '—'}{s.governorate ? ` · ${s.governorate}` : ''}</div>
                              <div className={styles.stopLeg}>{legLabel}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {plan.allLeftover.length > 0 && (
        <div className={styles.leftoverCard}>
          <div className={styles.leftoverTitle}>{plan.allLeftover.length} site(s) didn't fit within the day/hour budget</div>
          <div className={styles.leftoverList}>
            {plan.allLeftover.map((s, i) => (
              <span key={i} className={styles.leftoverChip}>{s.site_code || '—'} · {s.team}</span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function MapLegend({ plan, roadStatus }: { plan: RoutePlan; roadStatus: 'idle' | 'loading' | 'done' }) {
  return (
    <div className={styles.mapLegend}>
      {plan.teamsPlan.map((team, ti) => {
        const count = team.days.reduce((s, d) => s + d.stops.length, 0);
        if (!count) return null;
        return (
          <span key={ti} className={styles.legendItem}>
            <span className={styles.legendDot} style={{ background: TEAM_COLORS[ti % TEAM_COLORS.length] }} />
            {team.name} <span className={styles.legendCount}>({count} sites)</span>
          </span>
        );
      })}
      <span className={styles.legendItem} style={{ color: 'var(--text-muted)', fontSize: 12 }}>
        Marker number = day · dashed line = later day
        {roadStatus === 'loading' && ' · fetching real road routes…'}
        {roadStatus === 'done' && ' · 🛣️ = real road distance'}
      </span>
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function SendIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3">
      <polygon points="3 11 22 2 13 21 11 13 3 11" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
    </svg>
  );
}

function PinIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7z"/>
      <circle cx="12" cy="9" r="2.5"/>
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }}>
      <path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="10"/>
    </svg>
  );
}

function ClockAlertIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }}>
      <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
    </svg>
  );
}

function CheckSmIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function MapEmptyIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/>
      <line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>
    </svg>
  );
}

function SpinnerInlineIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      style={{ animation: 'spin 0.75s linear infinite' }}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round"/>
    </svg>
  );
}

function SavedPlansIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
      <path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10"/><path d="M12 16v-5"/><path d="M12 8h.01"/>
    </svg>
  );
}

function ClipboardPasteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
      <path d="M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3"/>
      <path d="M9 14h6"/><path d="M9 18h6"/>
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  );
}

function EraserIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 20H8.5L3 14.5a1 1 0 0 1 0-1.41l9.5-9.5a1 1 0 0 1 1.41 0L20 9.7a1 1 0 0 1 0 1.41L11.6 19.5"/>
      <line x1="8.5" y1="20" x2="15" y2="13.5"/>
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" style={{ flexShrink: 0, opacity: 0.6 }}>
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/>
      <path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/>
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>
    </svg>
  );
}

function TeamsIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  );
}

function SearchXIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="10.5" cy="10.5" r="6.5"/><line x1="21" y1="21" x2="15.5" y2="15.5"/>
      <line x1="8" y1="8" x2="13" y2="13"/><line x1="13" y1="8" x2="8" y2="13"/>
    </svg>
  );
}

function WarnTriangleIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  );
}

function RouteDistanceIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/>
      <path d="M8 19h6a4 4 0 0 0 4-4v0a4 4 0 0 0-4-4H10a4 4 0 0 1-4-4v0a4 4 0 0 1 4-4h2"/>
    </svg>
  );
}

function ClockDurationIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>
    </svg>
  );
}
