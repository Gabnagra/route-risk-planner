/* Route Risk Planner
 * Open-source route risk assessment built on open data:
 * OSRM (routing), Nominatim (geocoding), Overpass (points of interest),
 * Open-Meteo (weather and daylight), data.police.uk (crime, England/Wales/NI only).
 * Every factor is reported separately; no probability of incident is computed.
 */
(() => {
  'use strict';

  // ---------- Config ----------
  const CFG = {
    corridorM: 800,          // POIs counted within this distance of the route
    hospitalSearchM: 10000,  // search radius for nearest-hospital calculation
    chokeM: 25,              // bridges / tunnels on the route itself
    crimeBufferM: 150,       // crimes counted within this distance of a segment
    crimeSegmentM: 1000,     // segment length for crime analysis
    crimeMaxSegments: 25,    // per route, to respect API limits
    routing: {
      driving: ['https://routing.openstreetmap.de/routed-car/route/v1/driving', 'https://router.project-osrm.org/route/v1/driving'],
      foot: ['https://routing.openstreetmap.de/routed-foot/route/v1/foot'],
    },
    overpass: ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'],
    crimeWeights: {
      'violent-crime': 3, 'robbery': 3, 'possession-of-weapons': 3,
      'public-order': 2, 'theft-from-the-person': 2, 'criminal-damage-arson': 2, 'drugs': 1.5,
    },
  };

  const CATS = {
    hospital:  { label: 'Hospitals',            short: 'H', color: '#e5534b' },
    clinic:    { label: 'Clinics & doctors',    short: 'C', color: '#f0883e' },
    pharmacy:  { label: 'Pharmacies',           short: 'Rx', color: '#db61a2' },
    police:    { label: 'Police',               short: 'P', color: '#4c8dff' },
    fire:      { label: 'Fire stations',        short: 'F', color: '#ff7b72' },
    diplomatic:{ label: 'Embassies & consulates', short: 'E', color: '#a371f7' },
    fuel:      { label: 'Fuel stations',        short: 'G', color: '#d29922' },
    hotel:     { label: 'Hotels (safe havens)', short: 'Ht', color: '#3fb950' },
    transit:   { label: 'Transit stations',     short: 'T', color: '#39c5cf' },
    choke:     { label: 'Bridges & tunnels',    short: 'B', color: '#8b949e' },
  };

  const SEV = { green: 0, amber: 1, red: 2, grey: -1 };
  const SEV_LABEL = { green: 'Low', amber: 'Elevated', red: 'High', grey: 'n/a' };
  const ZONE_COLOR = { high: '#e5534b', medium: '#e3a008', low: '#3fb950' };

  // ---------- State ----------
  const state = {
    origin: null, destination: null,
    routes: [], active: 0,
    pois: [], weather: null, crimeDate: null,
    zones: [], // {id, layer, rating}
    analysedAt: null,
  };

  // ---------- Helpers ----------
  const $ = (s) => document.querySelector(s);
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  function hav(a, b) {
    const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  // distance from point p to segment a-b, metres (local equirectangular)
  function distToSeg(p, a, b) {
    const lat0 = toRad(p[0]);
    const x = (q) => toRad(q[1]) * Math.cos(lat0) * R, y = (q) => toRad(q[0]) * R;
    const px = x(p), py = y(p), ax = x(a), ay = y(a), bx = x(b), by = y(b);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function distToLine(p, line) {
    let m = Infinity;
    for (let i = 0; i < line.length - 1; i++) m = Math.min(m, distToSeg(p, line[i], line[i + 1]));
    return line.length === 1 ? hav(p, line[0]) : m;
  }
  function resample(coords, step) {
    const out = [coords[0]];
    let acc = 0;
    for (let i = 1; i < coords.length; i++) {
      acc += hav(coords[i - 1], coords[i]);
      if (acc >= step) { out.push(coords[i]); acc = 0; }
    }
    const last = coords[coords.length - 1];
    if (out[out.length - 1] !== last) out.push(last);
    return out;
  }
  function pointInPoly(pt, poly) { // poly: [[lat,lng],...]
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if (((yi > pt[0]) !== (yj > pt[0])) && (pt[1] < (xj - xi) * (pt[0] - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  const fmtKm = (m) => (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
  const fmtDur = (s) => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min`; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const worst = (...s) => s.filter((x) => x !== 'grey').reduce((a, b) => (SEV[b] > SEV[a] ? b : a), 'green');

  function setStatus(msg, cls = '') { $('#status').innerHTML = cls ? `<span class="${cls}">${msg}</span>` : msg; }

  async function fetchJSON(url, opts = {}, timeoutMs = 45000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...opts, signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  async function firstOk(urls, make) {
    let last;
    for (const u of urls) { try { return await make(u); } catch (e) { last = e; } }
    throw last;
  }

  // ---------- Map ----------
  const map = L.map('map', { zoomControl: true }).setView([40.4168, -3.7038], 6);
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
  const esriAttr = 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS user community';
  const dark = L.layerGroup([
    L.tileLayer(`${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, maxNativeZoom: 16, attribution: esriAttr }),
    L.tileLayer(`${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, maxNativeZoom: 16 }),
  ]).addTo(map);
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
  });
  const sat = L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, {
    maxZoom: 19, attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS user community',
  });
  L.control.layers({ 'Dark': dark, 'Streets (OpenStreetMap)': osm, 'Satellite': sat }, null, { position: 'topright' }).addTo(map);

  const routeLayer = L.layerGroup().addTo(map);
  const endpointLayer = L.layerGroup().addTo(map);
  const poiLayers = {};
  Object.keys(CATS).forEach((k) => { poiLayers[k] = L.layerGroup().addTo(map); });
  const zoneLayer = new L.FeatureGroup().addTo(map);

  // Draw control for analyst zones
  map.addControl(new L.Control.Draw({
    position: 'topright',
    draw: { polygon: { allowIntersection: false, showArea: false }, rectangle: true, polyline: false, circle: false, circlemarker: false, marker: false },
    edit: { featureGroup: zoneLayer, remove: true },
  }));
  let zoneSeq = 0;
  map.on(L.Draw.Event.CREATED, (e) => {
    const rating = $('#zone-rating').value;
    const layer = e.layer;
    const z = { id: ++zoneSeq, layer, rating };
    styleZone(z);
    zoneLayer.addLayer(layer);
    state.zones.push(z);
    renderZones();
    if (state.routes.length) recomputeZones();
  });
  map.on(L.Draw.Event.DELETED, (e) => {
    e.layers.eachLayer((l) => { state.zones = state.zones.filter((z) => z.layer !== l); });
    renderZones();
    if (state.routes.length) recomputeZones();
  });
  map.on(L.Draw.Event.EDITED, () => { if (state.routes.length) recomputeZones(); });

  function styleZone(z) {
    z.layer.setStyle({ color: ZONE_COLOR[z.rating], fillColor: ZONE_COLOR[z.rating], fillOpacity: 0.18, weight: 2, dashArray: '6 4' });
    z.layer.bindTooltip(`Zone ${z.id}: ${z.rating} risk`, { sticky: true });
  }
  function renderZones() {
    const el = $('#zones-list');
    if (!state.zones.length) { el.innerHTML = '<span class="hint">No zones drawn.</span>'; return; }
    el.innerHTML = state.zones.map((z) => `
      <div class="zone-item">
        <span class="swatch" style="background:${ZONE_COLOR[z.rating]}"></span>
        <span>Zone ${z.id}</span>
        <select data-zone="${z.id}">
          <option value="high"${z.rating === 'high' ? ' selected' : ''}>High</option>
          <option value="medium"${z.rating === 'medium' ? ' selected' : ''}>Medium</option>
          <option value="low"${z.rating === 'low' ? ' selected' : ''}>Low</option>
        </select>
        <button class="btn ghost" data-del="${z.id}">Remove</button>
      </div>`).join('');
    el.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => {
      const z = state.zones.find((q) => q.id === +s.dataset.zone);
      z.rating = s.value; styleZone(z); renderZones();
      if (state.routes.length) recomputeZones();
    }));
    el.querySelectorAll('button[data-del]').forEach((b) => b.addEventListener('click', () => {
      const z = state.zones.find((q) => q.id === +b.dataset.del);
      zoneLayer.removeLayer(z.layer);
      state.zones = state.zones.filter((q) => q !== z);
      renderZones();
      if (state.routes.length) recomputeZones();
    }));
  }
  renderZones();

  // Layer toggles
  $('#layers').innerHTML = Object.entries(CATS).map(([k, c]) =>
    `<label><input type="checkbox" data-layer="${k}" checked><span class="swatch" style="background:${c.color}"></span>${c.label}</label>`).join('');
  document.querySelectorAll('[data-layer]').forEach((cb) => cb.addEventListener('change', () => {
    const l = poiLayers[cb.dataset.layer];
    cb.checked ? map.addLayer(l) : map.removeLayer(l);
  }));

  // Click to set origin / destination
  map.on('click', (e) => {
    const v = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`;
    if (!$('#origin').value || ($('#origin').value && $('#destination').value)) {
      $('#origin').value = v; $('#destination').value = '';
    } else {
      $('#destination').value = v;
    }
  });

  // Default departure: next full hour
  (() => {
    const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1);
    const pad = (n) => String(n).padStart(2, '0');
    $('#departure').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
  })();

  // ---------- Data sources ----------
  async function geocode(text) {
    const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (m) return { lat: +m[1], lon: +m[2], name: text.trim() };
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(text)}`;
    const j = await fetchJSON(url);
    if (!j.length) throw new Error(`Location not found: "${text}"`);
    return { lat: +j[0].lat, lon: +j[0].lon, name: j[0].display_name.split(',').slice(0, 3).join(',') };
  }

  async function getRoutes(o, d, mode) {
    const path = `${o.lon},${o.lat};${d.lon},${d.lat}?alternatives=3&overview=full&geometries=geojson&steps=false`;
    const j = await firstOk(CFG.routing[mode], (base) => fetchJSON(`${base}/${path}`));
    if (j.code !== 'Ok' || !j.routes?.length) throw new Error('No route found between these points.');
    return j.routes.slice(0, 3).map((r, i) => ({
      id: i,
      name: i === 0 ? 'Route A (fastest)' : `Route ${String.fromCharCode(65 + i)} (alternative)`,
      coords: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
      distance: r.distance, duration: r.duration,
    }));
  }

  function classify(t) {
    if (t.amenity === 'hospital' || t.healthcare === 'hospital') return 'hospital';
    if (t.amenity === 'clinic' || t.amenity === 'doctors') return 'clinic';
    if (t.amenity === 'pharmacy') return 'pharmacy';
    if (t.amenity === 'police') return 'police';
    if (t.amenity === 'fire_station') return 'fire';
    if (t.amenity === 'embassy' || t.office === 'diplomatic' || t.diplomatic) return 'diplomatic';
    if (t.amenity === 'fuel') return 'fuel';
    if (t.tourism === 'hotel') return 'hotel';
    if (t.railway === 'station' || t.public_transport === 'station') return 'transit';
    if (t.bridge || t.tunnel) return 'choke';
    return null;
  }

  async function getPOIs(lines) {
    // one query around all routes; Overpass "around" accepts a polyline of coordinates
    const pts = [];
    lines.forEach((l) => resample(l, 400).forEach((p) => pts.push(p)));
    const step = Math.max(1, Math.ceil(pts.length / 220));
    const ll = pts.filter((_, i) => i % step === 0).map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(',');
    const a = (r) => `(around:${r},${ll})`;
    const C = CFG.corridorM;
    const q = `[out:json][timeout:90];
(
  nwr["amenity"="hospital"]${a(CFG.hospitalSearchM)};
  nwr["healthcare"="hospital"]${a(CFG.hospitalSearchM)};
  nwr["amenity"~"^(clinic|doctors)$"]${a(C)};
  nwr["amenity"="pharmacy"]${a(C)};
  nwr["amenity"="police"]${a(C)};
  nwr["amenity"="fire_station"]${a(C)};
  nwr["amenity"="embassy"]${a(C)};
  nwr["office"="diplomatic"]${a(C)};
  nwr["amenity"="fuel"]${a(C)};
  nwr["tourism"="hotel"]${a(C)};
  nwr["railway"="station"]${a(C)};
  nwr["public_transport"="station"]${a(C)};
  way["bridge"]["bridge"!="no"]["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)$"]${a(CFG.chokeM)};
  way["tunnel"]["tunnel"!="no"]["highway"]${a(CFG.chokeM)};
);
out center tags;`;
    const j = await firstOk(CFG.overpass, (u) => fetchJSON(u, {
      method: 'POST', body: 'data=' + encodeURIComponent(q),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, 95000));
    const seen = new Set();
    const out = [];
    for (const el of j.elements || []) {
      const t = el.tags || {};
      const cat = classify(t);
      if (!cat) continue;
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      if (lat == null) continue;
      const key = `${cat}:${t.name || ''}:${lat.toFixed(4)}:${lon.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ cat, lat, lon, name: t.name || t['name:en'] || CATS[cat].label.replace(/s$/, ''), tags: t });
    }
    return out;
  }

  async function getWeather(pts) {
    const lat = pts.map((p) => p[0].toFixed(4)).join(','), lon = pts.map((p) => p[1].toFixed(4)).join(',');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      '&hourly=temperature_2m,precipitation,weather_code,wind_gusts_10m,visibility&daily=sunrise,sunset&timezone=auto&forecast_days=16';
    const j = await fetchJSON(url);
    return Array.isArray(j) ? j : [j];
  }

  async function crimeLatestMonth() {
    const j = await fetchJSON('https://data.police.uk/api/crimes-street-dates', {}, 20000);
    return j?.[0]?.date || null;
  }
  const inPoliceUKArea = (p) => p[0] > 49.8 && p[0] < 55.4 && p[1] > -8.3 && p[1] < 1.9; // England, Wales, NI (approx.; excludes most of Scotland)

  async function crimeForSegment(seg, date) {
    const pad = CFG.crimeBufferM / 111000;
    let mnLat = Infinity, mxLat = -Infinity, mnLon = Infinity, mxLon = -Infinity;
    seg.forEach(([la, lo]) => { mnLat = Math.min(mnLat, la); mxLat = Math.max(mxLat, la); mnLon = Math.min(mnLon, lo); mxLon = Math.max(mxLon, lo); });
    const padLon = pad / Math.cos(toRad((mnLat + mxLat) / 2));
    const poly = [[mxLat + pad, mnLon - padLon], [mxLat + pad, mxLon + padLon], [mnLat - pad, mxLon + padLon], [mnLat - pad, mnLon - padLon]]
      .map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`).join(':');
    const url = `https://data.police.uk/api/crimes-street/all-crime?poly=${poly}${date ? `&date=${date}` : ''}`;
    const crimes = await fetchJSON(url, {}, 30000);
    const near = crimes.filter((c) => distToLine([+c.location.latitude, +c.location.longitude], seg) <= CFG.crimeBufferM);
    const byCat = {};
    let weighted = 0;
    near.forEach((c) => { byCat[c.category] = (byCat[c.category] || 0) + 1; weighted += CFG.crimeWeights[c.category] || 1; });
    return { count: near.length, weighted, byCat };
  }

  async function analyseCrime(route, date, onProgress) {
    // split into ~1 km segments
    const segs = [];
    let cur = [route.coords[0]], acc = 0;
    for (let i = 1; i < route.coords.length; i++) {
      acc += hav(route.coords[i - 1], route.coords[i]);
      cur.push(route.coords[i]);
      if (acc >= CFG.crimeSegmentM) { segs.push({ pts: cur, len: acc }); cur = [route.coords[i]]; acc = 0; }
    }
    if (cur.length > 1) segs.push({ pts: cur, len: Math.max(acc, 1) });
    const stride = Math.max(1, Math.ceil(segs.length / CFG.crimeMaxSegments));
    const sampled = segs.filter((_, i) => i % stride === 0);
    let done = 0;
    const queue = [...sampled];
    const worker = async () => {
      while (queue.length) {
        const s = queue.shift();
        try { s.crime = await crimeForSegment(s.pts, date); } catch (e) { s.crime = null; }
        done++; onProgress?.(done, sampled.length);
        await sleep(150);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const ok = sampled.filter((s) => s.crime);
    if (!ok.length) return null;
    const totLen = ok.reduce((a, s) => a + s.len, 0);
    const totW = ok.reduce((a, s) => a + s.crime.weighted, 0);
    const byCat = {};
    ok.forEach((s) => Object.entries(s.crime.byCat).forEach(([k, v]) => { byCat[k] = (byCat[k] || 0) + v; }));
    return {
      segments: ok, sampledRatio: sampled.length / segs.length,
      perKm: totW / (totLen / 1000), total: ok.reduce((a, s) => a + s.crime.count, 0), byCat,
    };
  }

  // ---------- Assessment ----------
  function weatherAt(w, when) {
    if (!w?.hourly) return null;
    const pad = (n) => String(n).padStart(2, '0');
    const key = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:00`;
    const i = w.hourly.time.indexOf(key);
    if (i < 0) return null;
    const dayKey = key.slice(0, 10);
    const di = w.daily.time.indexOf(dayKey);
    return {
      temp: w.hourly.temperature_2m[i], precip: w.hourly.precipitation[i], code: w.hourly.weather_code[i],
      gust: w.hourly.wind_gusts_10m[i], vis: w.hourly.visibility[i],
      sunrise: di >= 0 ? new Date(w.daily.sunrise[di]) : null, sunset: di >= 0 ? new Date(w.daily.sunset[di]) : null,
    };
  }
  function weatherSeverity(x) {
    if (!x) return { sev: 'grey', notes: [] };
    const notes = []; let sev = 'green';
    const bump = (s, n) => { sev = worst(sev, s); notes.push(n); };
    if (x.code >= 95) bump('red', 'Thunderstorm forecast');
    else if ([71, 73, 75, 77, 85, 86].includes(x.code)) bump('amber', 'Snow forecast');
    else if ([45, 48].includes(x.code)) bump('amber', 'Fog forecast');
    if (x.precip >= 7) bump('red', `Heavy precipitation (${x.precip} mm/h)`); else if (x.precip >= 2) bump('amber', `Moderate precipitation (${x.precip} mm/h)`);
    if (x.gust >= 75) bump('red', `Severe gusts (${Math.round(x.gust)} km/h)`); else if (x.gust >= 50) bump('amber', `Strong gusts (${Math.round(x.gust)} km/h)`);
    if (x.vis != null) { if (x.vis < 200) bump('red', `Very low visibility (${Math.round(x.vis)} m)`); else if (x.vis < 1000) bump('amber', `Reduced visibility (${Math.round(x.vis)} m)`); }
    return { sev, notes };
  }
  const WCODE = (c) => c == null ? '–' : c === 0 ? 'Clear' : c <= 3 ? 'Cloudy' : c <= 48 ? 'Fog' : c <= 57 ? 'Drizzle' : c <= 67 ? 'Rain' : c <= 77 ? 'Snow' : c <= 82 ? 'Showers' : c <= 86 ? 'Snow showers' : 'Thunderstorm';

  function zoneCrossings(route) {
    const pts = resample(route.coords, 100);
    const res = [];
    state.zones.forEach((z) => {
      const ring = z.layer.getLatLngs()[0].map((p) => [p.lat, p.lng]);
      const inside = pts.filter((p) => pointInPoly(p, ring)).length;
      if (inside) res.push({ id: z.id, rating: z.rating, km: (inside * 100) / 1000 });
    });
    return res;
  }

  function assessRoute(route) {
    const line = resample(route.coords, 200);
    // POIs in corridor
    const counts = {}; Object.keys(CATS).forEach((k) => { counts[k] = 0; });
    route.pois = state.pois.filter((p) => {
      const d = distToLine([p.lat, p.lon], line);
      const lim = p.cat === 'choke' ? CFG.chokeM + 15 : p.cat === 'hospital' ? CFG.corridorM : CFG.corridorM;
      if (d <= lim) { counts[p.cat]++; return true; }
      return false;
    });
    route.counts = counts;
    // medical access: distance from each sample point to nearest hospital
    const hospitals = state.pois.filter((p) => p.cat === 'hospital');
    let maxHosp = 0; let farKm = 0;
    const samples = resample(route.coords, 500);
    samples.forEach((p) => {
      const d = hospitals.length ? Math.min(...hospitals.map((h) => hav(p, [h.lat, h.lon]))) : Infinity;
      maxHosp = Math.max(maxHosp, d);
      if (d > 10000) farKm += 0.5;
    });
    route.maxHospM = maxHosp;
    route.medSev = !isFinite(maxHosp) ? 'red' : maxHosp <= 5000 ? 'green' : maxHosp <= 15000 ? 'amber' : 'red';
    route.farKm = farKm;
    // time / daylight
    const dep = new Date($('#departure').value);
    const arr = new Date(dep.getTime() + route.duration * 1000);
    route.dep = dep; route.arr = arr;
    const wO = weatherAt(state.weather?.[0], dep), wM = weatherAt(state.weather?.[1], new Date((dep.getTime() + arr.getTime()) / 2)), wD = weatherAt(state.weather?.[2], arr);
    route.wx = { origin: wO, mid: wM, dest: wD };
    const ws = [wO, wM, wD].map(weatherSeverity);
    route.wxSev = ws.some((x) => x.sev !== 'grey') ? worst(...ws.map((x) => x.sev)) : 'grey';
    route.wxNotes = [...new Set(ws.flatMap((x) => x.notes))];
    const dark = (w, t) => w?.sunrise && w?.sunset ? (t < w.sunrise || t > w.sunset) : null;
    const nD = dark(wO, dep), nA = dark(wD, arr);
    route.night = nD == null && nA == null ? null : !!(nD || nA);
    route.nightSev = route.night == null ? 'grey' : route.night ? 'amber' : 'green';
    // zones
    route.zones = zoneCrossings(route);
    route.zoneSev = route.zones.some((z) => z.rating === 'high') ? 'red' : route.zones.some((z) => z.rating === 'medium') ? 'amber' : state.zones.length ? 'green' : 'grey';
  }

  function crimeTiers() {
    const withCrime = state.routes.filter((r) => r.crime);
    if (!withCrime.length) return;
    // segment colour by tercile across all analysed segments
    const vals = withCrime.flatMap((r) => r.crime.segments.map((s) => s.crime.weighted / (s.len / 1000))).sort((a, b) => a - b);
    const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
    const t1 = q(1 / 3), t2 = q(2 / 3);
    withCrime.forEach((r) => r.crime.segments.forEach((s) => {
      const v = s.crime.weighted / (s.len / 1000);
      s.sev = v <= t1 ? 'green' : v <= t2 ? 'amber' : 'red';
    }));
    // route-level: rank by weighted crimes per km
    const sorted = [...withCrime].sort((a, b) => a.crime.perKm - b.crime.perKm);
    sorted.forEach((r, i) => {
      r.crimeSev = sorted.length === 1 ? 'grey' : i === 0 ? 'green' : i === sorted.length - 1 ? 'red' : 'amber';
    });
  }

  function recomputeZones() {
    state.routes.forEach((r) => {
      r.zones = zoneCrossings(r);
      r.zoneSev = r.zones.some((z) => z.rating === 'high') ? 'red' : r.zones.some((z) => z.rating === 'medium') ? 'amber' : state.zones.length ? 'green' : 'grey';
    });
    renderRoutes(); renderResults();
  }

  // ---------- Rendering ----------
  const SEV_COLOR = { green: '#3fb950', amber: '#e3a008', red: '#e5534b', grey: '#8a9bad' };

  function renderRoutes() {
    routeLayer.clearLayers();
    state.routes.forEach((r, i) => {
      if (i === state.active) return;
      L.polyline(r.coords, { color: '#5b6b7c', weight: 5, opacity: 0.75 })
        .on('click', () => selectRoute(i)).bindTooltip(r.name, { sticky: true }).addTo(routeLayer);
    });
    const r = state.routes[state.active];
    if (!r) return;
    L.polyline(r.coords, { color: '#0e141b', weight: 10, opacity: 0.9 }).addTo(routeLayer);
    L.polyline(r.coords, { color: '#2bb3a3', weight: 6, opacity: 1 }).bindTooltip(r.name, { sticky: true }).addTo(routeLayer);
    if (r.crime) r.crime.segments.forEach((s) => {
      L.polyline(s.pts, { color: SEV_COLOR[s.sev], weight: 6, opacity: 1 })
        .bindTooltip(`Crime exposure: ${SEV_LABEL[s.sev]}<br>${s.crime.count} crimes within ${CFG.crimeBufferM} m (${fmtKm(s.len)})`, { sticky: true })
        .addTo(routeLayer);
    });
    renderPOIs(r);
  }

  function renderPOIs(r) {
    Object.values(poiLayers).forEach((l) => l.clearLayers());
    const show = [...(r?.pois || [])];
    // include nearest hospitals even if outside corridor
    state.pois.filter((p) => p.cat === 'hospital' && !show.includes(p)).forEach((p) => show.push(p));
    show.forEach((p) => {
      const c = CATS[p.cat];
      const icon = L.divIcon({ className: '', html: `<div class="poi-icon" style="background:${c.color}">${c.short}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
      const extra = [p.tags.phone && `Tel: ${esc(p.tags.phone)}`, p.tags.emergency === 'yes' && 'Emergency department', p.tags.opening_hours && `Hours: ${esc(p.tags.opening_hours)}`, p.tags.country && `Country: ${esc(p.tags.country)}`].filter(Boolean).join('<br>');
      L.marker([p.lat, p.lon], { icon }).bindPopup(`<b>${esc(p.name)}</b><br><span style="color:#8a9bad">${c.label}</span>${extra ? '<br>' + extra : ''}`).addTo(poiLayers[p.cat]);
    });
  }

  function pill(sev, text) { return `<span class="pill ${sev}">${text ?? SEV_LABEL[sev]}</span>`; }

  function renderResults() {
    const el = $('#results');
    $('#results-card').hidden = !state.routes.length;
    if (!state.routes.length) { el.innerHTML = ''; return; }
    el.innerHTML = state.routes.map((r, i) => {
      const overall = worst(r.crimeSev || 'grey', r.zoneSev, r.nightSev, r.wxSev, r.medSev);
      const topCrime = r.crime ? Object.entries(r.crime.byCat).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k.replace(/-/g, ' ')} (${v})`).join(', ') : '';
      const notes = [];
      if (r.crime) notes.push(`Crime: ${r.crime.total} street-level crimes within ${CFG.crimeBufferM} m of the route (${state.crimeDate}); ${r.crime.perKm.toFixed(1)} weighted/km.${topCrime ? ' Main: ' + topCrime + '.' : ''}${r.crime.sampledRatio < 1 ? ' Long route: segments sampled.' : ''}`);
      else notes.push('Crime: no open crime data for this area (available for England, Wales and Northern Ireland). Use analyst zones.');
      if (r.zones.length) notes.push('Zones crossed: ' + r.zones.map((z) => `Zone ${z.id} (${z.rating}, ~${z.km.toFixed(1)} km)`).join('; ') + '.');
      if (r.night) notes.push('Part of the journey takes place in darkness at origin or destination.');
      r.wxNotes.forEach((n) => notes.push('Weather: ' + n + '.'));
      notes.push(isFinite(r.maxHospM) ? `Medical: max. ${fmtKm(r.maxHospM)} straight-line to the nearest mapped hospital${r.farKm ? `; ~${r.farKm.toFixed(1)} km of route beyond 10 km` : ''}.` : 'Medical: no mapped hospital within 10 km of the route.');
      const c = r.counts;
      return `
      <div class="route-card ${i === state.active ? 'active' : ''}" data-route="${i}">
        <div class="route-head"><strong>${esc(r.name)}</strong><span>${fmtKm(r.distance)} · ${fmtDur(r.duration)}</span></div>
        <div class="factors">
          <span class="k">Highest-rated factor</span>${pill(overall)}
          <span class="k">Crime exposure (relative)</span>${pill(r.crimeSev || 'grey', r.crime ? (r.crimeSev === 'grey' ? `${r.crime.perKm.toFixed(1)}/km` : SEV_LABEL[r.crimeSev]) : 'No data')}
          <span class="k">Analyst risk zones</span>${pill(r.zoneSev, r.zoneSev === 'grey' ? 'None drawn' : r.zones.length ? `${r.zones.length} crossed` : 'Clear')}
          <span class="k">Darkness</span>${pill(r.nightSev, r.night == null ? 'n/a' : r.night ? 'Yes' : 'Daylight')}
          <span class="k">Weather</span>${pill(r.wxSev, r.wxSev === 'grey' ? 'Beyond forecast' : SEV_LABEL[r.wxSev])}
          <span class="k">Medical access</span>${pill(r.medSev, isFinite(r.maxHospM) ? `≤ ${fmtKm(r.maxHospM)}` : 'None')}
        </div>
        <div class="subhead">In corridor (${CFG.corridorM} m)</div>
        <div class="factors">
          <span class="k">Hospitals / clinics / pharmacies</span><span>${c.hospital} / ${c.clinic} / ${c.pharmacy}</span>
          <span class="k">Police / fire stations</span><span>${c.police} / ${c.fire}</span>
          <span class="k">Embassies & consulates</span><span>${c.diplomatic}</span>
          <span class="k">Fuel / hotels / transit</span><span>${c.fuel} / ${c.hotel} / ${c.transit}</span>
          <span class="k">Bridges & tunnels (choke points)</span><span>${c.choke}</span>
        </div>
        <ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      </div>`;
    }).join('') + weatherBlock();
    el.querySelectorAll('[data-route]').forEach((d) => d.addEventListener('click', () => selectRoute(+d.dataset.route)));
  }

  function weatherBlock() {
    const r = state.routes[state.active];
    if (!r?.wx) return '';
    const cell = (t, w) => `<div><b>${t}</b>${w ? `${WCODE(w.code)}, ${Math.round(w.temp)}°C<br>${w.precip} mm/h · gusts ${Math.round(w.gust)} km/h${w.vis != null ? `<br>vis. ${w.vis >= 10000 ? '>10 km' : Math.round(w.vis) + ' m'}` : ''}` : 'No forecast'}</div>`;
    return `<div class="subhead">Weather · ${esc(r.name)}</div>
      <div class="weather-grid">${cell('Departure', r.wx.origin)}${cell('Midpoint', r.wx.mid)}${cell('Arrival', r.wx.dest)}</div>`;
  }

  function renderLegend() {
    $('#legend').innerHTML = `
      <div class="li"><span class="bar" style="background:#2bb3a3"></span>Selected route</div>
      <div class="li"><span class="bar" style="background:#5b6b7c"></span>Alternatives (click to select)</div>
      <div class="li"><span class="bar" style="background:#3fb950"></span><span class="bar" style="background:#e3a008"></span><span class="bar" style="background:#e5534b"></span>Crime exposure by segment</div>
      <div class="li"><span class="bar" style="background:none;border-top:2px dashed #e3a008"></span>Analyst risk zone</div>`;
  }
  renderLegend();

  function selectRoute(i) { state.active = i; renderRoutes(); renderResults(); }

  // ---------- Main flow ----------
  async function analyse() {
    const btn = $('#btn-analyse');
    btn.disabled = true; $('#btn-report').disabled = true;
    try {
      setStatus('Geocoding…');
      const [o, d] = await Promise.all([geocode($('#origin').value), geocode($('#destination').value)]);
      state.origin = o; state.destination = d;
      endpointLayer.clearLayers();
      L.circleMarker([o.lat, o.lon], { radius: 8, color: '#fff', weight: 2, fillColor: '#2bb3a3', fillOpacity: 1 }).bindTooltip('Origin: ' + esc(o.name)).addTo(endpointLayer);
      L.circleMarker([d.lat, d.lon], { radius: 8, color: '#fff', weight: 2, fillColor: '#e5534b', fillOpacity: 1 }).bindTooltip('Destination: ' + esc(d.name)).addTo(endpointLayer);

      setStatus('Calculating routes and alternatives…');
      state.routes = await getRoutes(o, d, $('#mode').value);
      state.active = 0;
      map.fitBounds(L.latLngBounds(state.routes.flatMap((r) => r.coords)), { padding: [40, 40] });
      renderRoutes();

      setStatus('Querying points of interest, weather and crime data…');
      const main = state.routes[0].coords;
      const mid = main[Math.floor(main.length / 2)];
      const crimeEligible = state.routes.every((r) => resample(r.coords, 2000).every(inPoliceUKArea));
      const [pois, wx, cDate] = await Promise.allSettled([
        getPOIs(state.routes.map((r) => r.coords)),
        getWeather([[o.lat, o.lon], mid, [d.lat, d.lon]]),
        crimeEligible ? crimeLatestMonth() : Promise.resolve(null),
      ]);
      const warn = [];
      state.pois = pois.status === 'fulfilled' ? pois.value : (warn.push('points of interest unavailable'), []);
      state.weather = wx.status === 'fulfilled' ? wx.value : (warn.push('weather unavailable'), null);
      state.crimeDate = cDate.status === 'fulfilled' ? cDate.value : null;

      state.routes.forEach(assessRoute);

      if (crimeEligible && state.crimeDate) {
        for (const r of state.routes) {
          r.crime = await analyseCrime(r, state.crimeDate, (n, t) => setStatus(`Crime analysis · ${esc(r.name)}: ${n}/${t} segments…`));
        }
        crimeTiers();
        if (state.routes.every((r) => !r.crime)) warn.push('crime data unavailable');
      }

      state.analysedAt = new Date();
      renderRoutes(); renderResults();
      setStatus(`Analysis complete: ${state.routes.length} route(s).${warn.length ? ' Note: ' + warn.join(', ') + '.' : ''}`, warn.length ? '' : 'ok');
      $('#btn-report').disabled = false;
    } catch (e) {
      console.error(e);
      setStatus(esc(e.message || 'Something went wrong. Please try again.'), 'err');
    } finally {
      btn.disabled = false;
    }
  }

  function clearAll() {
    state.routes = []; state.pois = []; state.weather = null;
    routeLayer.clearLayers(); endpointLayer.clearLayers();
    Object.values(poiLayers).forEach((l) => l.clearLayers());
    $('#origin').value = ''; $('#destination').value = '';
    renderResults(); setStatus(''); $('#btn-report').disabled = true;
  }

  // ---------- Report ----------
  function exportReport() {
    const rows = state.routes.map((r) => {
      const overall = worst(r.crimeSev || 'grey', r.zoneSev, r.nightSev, r.wxSev, r.medSev);
      const poiList = Object.keys(CATS).filter((k) => k !== 'choke').map((k) => {
        const items = r.pois.filter((p) => p.cat === k).slice(0, 8).map((p) => esc(p.name));
        return items.length ? `<tr><td>${CATS[k].label}</td><td>${items.join(', ')}${r.counts[k] > 8 ? ` (+${r.counts[k] - 8})` : ''}</td></tr>` : '';
      }).join('');
      return `<h2>${esc(r.name)}: ${fmtKm(r.distance)}, ${fmtDur(r.duration)}</h2>
        <table><tr><th>Factor</th><th>Rating</th></tr>
        <tr><td>Highest-rated factor</td><td>${SEV_LABEL[overall]}</td></tr>
        <tr><td>Crime exposure (relative)</td><td>${r.crime ? `${SEV_LABEL[r.crimeSev] || '–'} · ${r.crime.total} crimes, ${r.crime.perKm.toFixed(1)} weighted/km (${state.crimeDate})` : 'No open data'}</td></tr>
        <tr><td>Analyst risk zones</td><td>${r.zones.length ? r.zones.map((z) => `Zone ${z.id} (${z.rating})`).join(', ') : state.zones.length ? 'None crossed' : 'None drawn'}</td></tr>
        <tr><td>Darkness</td><td>${r.night == null ? 'n/a' : r.night ? 'Yes' : 'No'}</td></tr>
        <tr><td>Weather</td><td>${SEV_LABEL[r.wxSev]}${r.wxNotes.length ? ': ' + esc(r.wxNotes.join('; ')) : ''}</td></tr>
        <tr><td>Medical access</td><td>${isFinite(r.maxHospM) ? 'Max. ' + fmtKm(r.maxHospM) + ' to nearest hospital' : 'No hospital mapped within 10 km'}</td></tr>
        <tr><td>Choke points</td><td>${r.counts.choke} bridges / tunnels</td></tr></table>
        <h3>Points of interest in corridor</h3><table>${poiList || '<tr><td>None found</td></tr>'}</table>`;
    }).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Route risk report</title>
      <style>body{font-family:Arial,sans-serif;max-width:820px;margin:24px auto;color:#111;font-size:13px}h1{font-size:20px}h2{font-size:15px;margin-top:22px;border-bottom:1px solid #ccc;padding-bottom:4px}h3{font-size:13px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:5px 7px;text-align:left;vertical-align:top}th{background:#f3f3f3}.m{color:#666;font-size:11.5px}</style>
      </head><body><h1>Route risk report</h1>
      <p><b>Origin:</b> ${esc(state.origin?.name)}<br><b>Destination:</b> ${esc(state.destination?.name)}<br>
      <b>Departure:</b> ${esc($('#departure').value.replace('T', ' '))} · <b>Mode:</b> ${esc($('#mode').selectedOptions[0].text)}<br>
      <b>Generated:</b> ${state.analysedAt?.toLocaleString()}</p>${rows}
      <p class="m">Sources: OSRM and Nominatim (OpenStreetMap), Overpass API, Open-Meteo, data.police.uk. Ratings are relative indicators for analyst support, not probabilities of incident. Open data may be incomplete.</p>
      <script>window.onload=()=>window.print()<\/script></body></html>`;
    const w = window.open('', '_blank');
    if (!w) { setStatus('Allow pop-ups to export the report.', 'err'); return; }
    w.document.write(html); w.document.close();
  }

  // ---------- Wire up ----------
  $('#btn-analyse').addEventListener('click', analyse);
  $('#btn-clear').addEventListener('click', clearAll);
  $('#btn-report').addEventListener('click', exportReport);
  $('#btn-about').addEventListener('click', () => $('#about').showModal());
  ['#origin', '#destination'].forEach((s) => $(s).addEventListener('keydown', (e) => { if (e.key === 'Enter') analyse(); }));

  // expose for testing
  window.__rrp = { map, state, hav, distToLine, resample, pointInPoly, classify };
})();
