import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useAuth } from '../context/AuthContext';
import { haversineKm } from '../lib/sitesNearest';
import { cacheOk, getAllSites, ensureFullLoad } from '../lib/sitesCache';
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

// ── Constants ─────────────────────────────────────────────────────────────────

const TEAM_COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

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

function splitIntoDays(ordered: Site[], numDays: number, dailyMin: number, speed: number, startLoc: StartLoc | null): { days: DayPlan[]; leftover: Site[] } {
  const result: DayPlan[] = [];
  const leftover: Site[] = [];
  let dayNum = 1, dayMin = 0, dayDistance = 0, stops: Stop[] = [];
  let prev: { latitude: number; longitude: number } | null = startLoc || null;
  let doneDays = false;

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
    if (prev && dayMin + legMin > dailyMin) {
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

function rebalanceLeftovers(teamsPlan: TeamPlan[], numDays: number, dailyMin: number, speed: number): void {
  const pool: Site[] = [];
  teamsPlan.forEach(t => { pool.push(...t.leftover); t.leftover = []; });
  if (!pool.length) return;

  for (const site of pool) {
    let bestTeamIdx = -1, bestDayIdx = -1, bestCost = Infinity;

    for (let ti = 0; ti < teamsPlan.length; ti++) {
      const team = teamsPlan[ti];
      if (team.days.length > 0) {
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

  const actualNumTeams = maxSitesPerTeam > 0
    ? Math.max(numTeamsRaw, Math.ceil(matched.length / maxSitesPerTeam))
    : numTeamsRaw;

  const teamsSites = clusterIntoTeams(matched, actualNumTeams);
  const dailyMin = dailyHours * 60;
  const teamsPlan: TeamPlan[] = teamsSites.map((sites, idx) => {
    if (!sites.length) return { name: `Team ${idx + 1}`, days: [], leftover: [] };
    const nn = nearestNeighborRoute(sites, startLoc);
    const ordered = optimizeRoute(nn, startLoc);
    const split = splitIntoDays(ordered, numDays, dailyMin, speed, startLoc);
    return { name: `Team ${idx + 1}`, days: split.days, leftover: split.leftover };
  });

  rebalanceLeftovers(teamsPlan, numDays, dailyMin, speed);

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
  const [priorityText, setPriorityText] = useState('');
  const [plan, setPlan] = useState<RoutePlan | null>(null);
  const [planError, setPlanError] = useState('');
  const [resultsView, setResultsView] = useState<'list' | 'map'>('list');
  const [copyLabel, setCopyLabel] = useState('Copy Plan as Text');

  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);

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

  // Map lifecycle: init/teardown
  useEffect(() => {
    if (resultsView !== 'map' || !plan) return;
    const t = setTimeout(() => {
      if (!mapDivRef.current) return;
      if (!mapRef.current) {
        const map = L.map(mapDivRef.current).setView([33.3152, 44.3661], 6);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(map);
        mapRef.current = map;
        layerGroupRef.current = L.layerGroup().addTo(map);
      }
      renderMapLayers(plan);
      setTimeout(() => { if (mapRef.current) mapRef.current.invalidateSize(); }, 50);
    }, 50);
    return () => clearTimeout(t);
  }, [resultsView, plan]);

  useEffect(() => {
    return () => {
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; layerGroupRef.current = null; }
    };
  }, []);

  function renderMapLayers(p: RoutePlan) {
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
      const allStops = team.days.flatMap(d => d.stops);
      if (!allStops.length) return;

      const latlngs: [number, number][] = allStops.map(s => [s.site.latitude, s.site.longitude]);
      if (p.startLoc && latlngs.length) {
        L.polyline([[p.startLoc.latitude, p.startLoc.longitude], latlngs[0]], {
          color, weight: 2, opacity: 0.5, dashArray: '4,6',
        }).addTo(layerGroupRef.current!);
      }
      L.polyline(latlngs, { color, weight: 3, opacity: 0.85 }).addTo(layerGroupRef.current!);

      allStops.forEach((stop, si) => {
        const s = stop.site;
        const dayNum = team.days.find(d => d.stops.includes(stop))?.dayNum ?? '';
        L.circleMarker([s.latitude, s.longitude], {
          radius: s._priority ? 8 : 6.5, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1,
        }).bindPopup(`<div style="font-family:inherit;min-width:170px">
          <div style="font-weight:700;font-size:13px;margin-bottom:2px">${s.site_code || 'Site'}${s._priority ? ' ⭐' : ''}</div>
          <div style="font-size:12px;color:#64748b;margin-bottom:4px">${s.site_name || ''}</div>
          <div style="font-size:11.5px;color:#94a3b8">${team.name} · Day ${dayNum} · Stop ${si + 1}</div>
        </div>`).addTo(layerGroupRef.current!);
        allPts.push([s.latitude, s.longitude]);
      });
    });

    if (allPts.length) mapRef.current.fitBounds(allPts, { padding: [30, 30], maxZoom: 14 });
  }

  function handleGenerate() {
    setPlanError('');
    const result = generatePlan(
      operator, numTeams, numDays, dailyHours, speed,
      parseInt(maxSitesPerTeam) || 0, startLocRaw,
      sitesText, priorityText, sitesDB
    );
    if ('error' in result) { setPlanError(result.error); setPlan(null); return; }
    setPlan(result.plan);
    setResultsView('list');
    if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; layerGroupRef.current = null; }
  }

  function handleClear() {
    setPlan(null);
    setPlanError('');
    setResultsView('list');
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

  function handleSwitchView(v: 'list' | 'map') {
    setResultsView(v);
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
      .then(() => { setCopyLabel('✓ Copied'); setTimeout(() => setCopyLabel('Copy Plan as Text'), 1500); })
      .catch(() => alert('Could not copy to clipboard.'));
  }

  if (!hasPerm('view_route_planner')) {
    return (
      <div className={styles.page}>
        <div className={styles.denied}>You don't have permission to view this page.</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Route Planner</h1>
        <p className={styles.pageSub}>
          Paste a site list, split it across teams, and get a day-by-day itinerary based on geographic
          distribution and travel time. Estimates use straight-line distance, not real road routing.
        </p>
      </div>

      {/* Settings card */}
      <div className={styles.card}>
        <div className={styles.cardTitle}>Plan Settings</div>

        <div className={styles.grid4}>
          <div className={styles.field}>
            <label>Operator</label>
            <select value={operator} onChange={e => setOperator(e.target.value)}>
              {operators.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div className={styles.field}>
            <label>Teams</label>
            <input type="number" min={1} max={20} value={numTeams}
              onChange={e => setNumTeams(Math.max(1, parseInt(e.target.value) || 1))} />
          </div>
          <div className={styles.field}>
            <label>Days</label>
            <input type="number" min={1} max={30} value={numDays}
              onChange={e => setNumDays(Math.max(1, parseInt(e.target.value) || 1))} />
          </div>
          <div className={styles.field}>
            <label>Daily Hours</label>
            <input type="number" min={1} max={16} step={0.5} value={dailyHours}
              onChange={e => setDailyHours(Math.max(0.5, parseFloat(e.target.value) || 8))} />
          </div>
        </div>

        <div className={styles.grid3}>
          <div className={styles.field}>
            <label>Avg Road Speed (km/h)</label>
            <input type="number" min={5} max={140} value={speed}
              onChange={e => setSpeed(Math.max(1, parseFloat(e.target.value) || 40))} />
          </div>
          <div className={styles.field}>
            <label>Max Sites per Team (optional)</label>
            <input type="number" min={1} max={200} placeholder="e.g. 8"
              value={maxSitesPerTeam} onChange={e => setMaxSitesPerTeam(e.target.value)} />
            <div className={styles.fieldHint}>If set, adds more teams automatically to keep each team at or under this count.</div>
          </div>
          <div className={styles.field}>
            <label>Start Location (optional) — site code or "lat,lng"</label>
            <div className={styles.startLocRow}>
              <input
                type="text"
                className={styles.startLocInput}
                placeholder='e.g. ZN-00123 or 33.31,44.36'
                value={startLocRaw}
                onChange={e => setStartLocRaw(e.target.value)}
              />
              <button type="button" className={styles.secondaryBtn} onClick={handleUseMyLocation}>
                <PinIcon /> My Location
              </button>
            </div>
            {startLocStatus && <div className={styles.fieldHint}>{startLocStatus}</div>}
          </div>
        </div>

        <div className={styles.grid2}>
          <div className={styles.field}>
            <label>Site List — one code per line (or comma-separated)</label>
            <textarea
              className={styles.textarea}
              placeholder={'ZN-00123\nZN-00456\nZN-00789...'}
              value={sitesText}
              onChange={e => setSitesText(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label>Priority Sites (optional) — visited first each day</label>
            <textarea
              className={styles.textarea}
              placeholder="Codes from the list above that must be visited first"
              value={priorityText}
              onChange={e => setPriorityText(e.target.value)}
            />
          </div>
        </div>

        <div className={styles.btnRow}>
          <button className={styles.generateBtn} onClick={handleGenerate}>
            <SendIcon /> Generate Plan
          </button>
          <button className={styles.secondaryBtn} onClick={handleClear}>
            <TrashIcon /> Clear Plan
          </button>
        </div>
      </div>

      {/* Results */}
      <div className={styles.results}>
        {!plan && !planError && (
          <div className={styles.empty}>Fill in the settings above and generate a plan to see the itinerary.</div>
        )}

        {planError && (
          <div className={`${styles.alert} ${styles.alertRed}`}>
            <AlertIcon /> <div>{planError}</div>
          </div>
        )}

        {plan && <PlanResults
          plan={plan}
          resultsView={resultsView}
          onSwitchView={handleSwitchView}
          onCopyText={handleCopyText}
          copyLabel={copyLabel}
          mapDivRef={mapDivRef}
        />}
      </div>
    </div>
  );
}

// ── Results sub-component ──────────────────────────────────────────────────────

function PlanResults({
  plan, resultsView, onSwitchView, onCopyText, copyLabel, mapDivRef,
}: {
  plan: RoutePlan;
  resultsView: 'list' | 'map';
  onSwitchView: (v: 'list' | 'map') => void;
  onCopyText: () => void;
  copyLabel: string;
  mapDivRef: React.RefObject<HTMLDivElement | null>;
}) {
  const notFound = plan.unmatched.filter(u => u.reason === 'not_found');
  const noCoord = plan.unmatched.filter(u => u.reason === 'missing_coordinates');

  return (
    <>
      {/* Summary stats */}
      <div className={styles.statRow}>
        <div className={styles.stat}>
          <div className={styles.statVal}>{plan.totalMatched}</div>
          <div className={styles.statLabel}>Sites Matched</div>
        </div>
        {plan.unmatched.length > 0 && (
          <div className={`${styles.stat} ${styles.statWarn}`}>
            <div className={styles.statVal}>{plan.unmatched.length}</div>
            <div className={styles.statLabel}>Not Found</div>
          </div>
        )}
        {plan.leftoverCount > 0 && (
          <div className={`${styles.stat} ${styles.statBad}`}>
            <div className={styles.statVal}>{plan.leftoverCount}</div>
            <div className={styles.statLabel}>Left Over</div>
          </div>
        )}
        <div className={styles.stat}>
          <div className={styles.statVal}>{plan.numTeams}</div>
          <div className={styles.statLabel}>Teams</div>
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
                <b>{noCoord.length} code(s) found but missing coordinates</b>, can't be placed on a route:{' '}
                {noCoord.map(u => <code key={u.code} className={styles.code}>{u.code}</code>)}
              </div>
            )}
          </div>
        </div>
      )}

      {plan.startLocInvalid && (
        <div className={`${styles.alert} ${styles.alertAmber}`}>
          <AlertIcon />
          <div><b>Start location not recognized:</b> "{plan.startLocRaw}" didn't match a site code or "lat,lng" pair — routes were built without a fixed start point.</div>
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
          <div>Team count increased from <b>{plan.requestedNumTeams}</b> to <b>{plan.numTeams}</b> to keep each team at or under <b>{plan.maxSitesPerTeam}</b> sites.</div>
        </div>
      )}

      {/* Toolbar */}
      <div className={styles.toolbar}>
        <button className={styles.copyBtn} onClick={onCopyText}>
          <CopyIcon /> {copyLabel}
        </button>
        <div className={styles.viewTabs}>
          <button
            className={`${styles.viewTab} ${resultsView === 'list' ? styles.viewTabActive : ''}`}
            onClick={() => onSwitchView('list')}
          >List</button>
          <button
            className={`${styles.viewTab} ${resultsView === 'map' ? styles.viewTabActive : ''}`}
            onClick={() => onSwitchView('map')}
          >Map</button>
        </div>
      </div>

      {/* List view */}
      <div style={{ display: resultsView === 'list' ? undefined : 'none' }}>
        {plan.teamsPlan.map((team, ti) => {
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
                  <span><b>{totalStops}</b> sites</span>
                  <span><b>{totalKm.toFixed(1)}</b> km</span>
                  <span><b>{formatMin(totalMin)}</b> driving</span>
                </div>
              </div>
              {!team.days.length && (
                <div className={styles.dayWrap}>
                  <div className={styles.empty} style={{ padding: 20 }}>No sites assigned to this team.</div>
                </div>
              )}
              {team.days.map(day => (
                <div key={day.dayNum} className={styles.dayWrap}>
                  <div className={styles.dayHead}>
                    Day {day.dayNum}
                    <span className={styles.dayMeta}>· {day.stops.length} sites · {day.distanceKm.toFixed(1)} km · {formatMin(day.minutes)} driving</span>
                  </div>
                  <div className={styles.timeline}>
                    {day.stops.map((stop, si) => {
                      const s = stop.site;
                      const isVeryFirst = day.dayNum === 1 && si === 0;
                      let legLabel: string;
                      if (isVeryFirst && !plan.startLoc) legLabel = 'Route start';
                      else if (isVeryFirst && plan.startLoc) legLabel = `${stop.legKm.toFixed(1)} km · ~${formatMin(stop.legMin)} drive from ${plan.startLoc._label || 'start location'}`;
                      else if (si === 0) legLabel = stop.legMin > 0 ? `${stop.legKm.toFixed(1)} km · ~${formatMin(stop.legMin)} drive continuing from previous day` : 'Continues from previous day';
                      else legLabel = `${stop.legKm.toFixed(1)} km · ~${formatMin(stop.legMin)} drive from previous stop`;
                      return (
                        <div key={si} className={styles.stop}>
                          <div className={`${styles.stopDot} ${s._priority ? styles.stopDotPriority : ''}`} style={{ background: color, borderColor: color }}>
                            {si + 1}
                          </div>
                          <div className={styles.stopBody}>
                            <div className={styles.stopCode}>
                              {s.site_code || '—'}
                              {s._priority && <span className={styles.priorityChip}>Priority</span>}
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
      </div>

      {/* Map view */}
      <div style={{ display: resultsView === 'map' ? undefined : 'none' }}>
        <div ref={mapDivRef} className={styles.mapBox} />
        <MapLegend plan={plan} />
      </div>
    </>
  );
}

function MapLegend({ plan }: { plan: RoutePlan }) {
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
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }}>
      <path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="10"/>
    </svg>
  );
}

function ClockAlertIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }}>
      <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
    </svg>
  );
}

