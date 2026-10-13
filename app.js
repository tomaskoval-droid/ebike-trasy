/* Ebike Trasy – plánovač trás pre elektrobicykle nad Mapy.com REST API. */
'use strict';

const API = 'https://api.mapy.com/v1';
// Kľúč appky pre všetkých používateľov (na developer.mapy.com obmedzený len na adresu appky).
// Kým je prázdny, každý si zadá vlastný kľúč v Nastaveniach. Vlastný kľúč má vždy prednosť.
const APP_MAPY_KEY = '';
function mapyKey() { let k = ''; try { k = JSON.parse(localStorage.getItem('ebike.key') || '""'); } catch {} return k || APP_MAPY_KEY; }
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('ebike.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ebike.' + k, JSON.stringify(v)); } catch {} },
};

/* ---------- Spotreba batérie (samostatný model, dá sa ladiť) ---------- */
const Energy = {
  // Wh na km na rovine pre systém 100 kg, podľa režimu podpory
  baseWhKm: { eco: 5.5, tour: 8.5, sport: 12, turbo: 17 },
  // aký podiel práce do kopca robí motor
  motorShare: { eco: 0.45, tour: 0.6, sport: 0.75, turbo: 0.88 },
  surface: { bike_road: 1.0, bike_mountain: 1.25 },
  efficiency: 0.75,
  usableShare: 0.95,
  chargerW: 150, // bežná 4A nabíjačka ~150 W
  // p.calib = osobný koeficient z tvojich jázd (1 = bez úpravy), p.wind = násobok pre vietor, p.surf = násobok za povrch
  flat(km, p) { return this.baseWhKm[p.assist] * km * (p.mass / 100) * (p.surf || this.surface[p.routeType]) * (p.wind || 1) * (p.calib || 1); },
  climb(m, p) { return m > 0 ? (p.mass * 9.81 * m) / 3600 / this.efficiency * this.motorShare[p.assist] * (p.calib || 1) : 0; },
  flatRangeKm(p) { return (p.wh * p.soc / 100 * this.usableShare * (p.cold || 1)) / (this.baseWhKm[p.assist] * (p.mass / 100) * this.surface[p.routeType] * (p.calib || 1)); },
};

const BIKES = {
  city:     { wh: 500, mass: 105, routeType: 'bike_road' },
  trek:     { wh: 625, mass: 105, routeType: 'bike_road' },
  hardtail: { wh: 625, mass: 100, routeType: 'bike_mountain' },
  full:     { wh: 750, mass: 105, routeType: 'bike_mountain' },
  gravel:   { wh: 500, mass: 92,  routeType: 'bike_road' },
  cargo:    { wh: 750, mass: 150, routeType: 'bike_road' },
};
// čas jazdy na e-bike: rovina podľa režimu podpory + stúpanie (motor pomáha, takže do kopca rýchlejšie ako bežný bicykel)
const EBIKE_SPEED = { eco: 18, tour: 21, sport: 23, turbo: 25 };   // km/h na rovine po asfalte
const EBIKE_VAM = { eco: 450, tour: 650, sport: 850, turbo: 1050 }; // výškové metre za hodinu
function ebikeTime(route, a, rt) {
  const as = $('assist').value, v = EBIKE_SPEED[as] * (rt === 'bike_mountain' ? 0.8 : 1);
  return Math.round((route.length / 1000 / v + (a?.up || 0) / EBIKE_VAM[as]) * 3600);
}
// obtiažnosť trasy podľa úrovní (ľahká / stredná / náročná)
function levelOf(km, up, grade) {
  if (km <= LEVELS.easy.maxKm && up <= LEVELS.easy.maxUp && grade <= LEVELS.easy.maxGrade) return ['easy', 'ľahká'];
  if (km <= LEVELS.mid.maxKm && up <= LEVELS.mid.maxUp && grade <= LEVELS.mid.maxGrade) return ['mid', 'stredná'];
  return ['hard', 'náročná'];
}
const LEVELS = {
  easy: { maxKm: 40, maxUp: 400, maxGrade: 6 },
  mid:  { maxKm: 70, maxUp: 1000, maxGrade: 10 },
  hard: { maxKm: 120, maxUp: 2000, maxGrade: 16 },
};

/* ---------- Stav ---------- */
const state = {
  mode: 'ab',
  points: [],          // {lat, lon, label, charge?}
  loopStart: null,
  variants: [], variantIdx: -1,
  pendingSlot: null,   // index, kam sa vloží nový prejazdný bod
  imported: null,      // {name} pri nahratom GPX
  route: null,         // {coords:[[lat,lon]], length, duration, parts, cum:[m]}
  prof: null,          // {d:[m], e:[m]}
  analysis: null,
};

/* ---------- Mapa ---------- */
const map = L.map('map', { zoomControl: true }).setView([48.73, 19.15], 8);
let tiles = null, labels = null;
const MAPSETS = [
  { id: 'outdoor', name: 'Turistická' },
  { id: 'basic', name: 'Základná' },
  { id: 'aerial', name: 'Letecká' },
  { id: 'winter', name: 'Zimná' },
];
function currentMapset() { const m = store.get('mapset', 'outdoor'); return MAPSETS.some((x) => x.id === m) ? m : 'outdoor'; }
function mapyTileUrl(mapset, key) { return `${API}/maptiles/${mapset}/256/{z}/{x}/{y}?apikey=${encodeURIComponent(key)}`; }
function setTiles() {
  if (tiles) map.removeLayer(tiles);
  if (labels) { map.removeLayer(labels); labels = null; }
  const key = mapyKey();
  const mapset = currentMapset();
  if (key) {
    tiles = L.tileLayer(mapyTileUrl(mapset, key), {
      minZoom: 0, maxZoom: 19,
      attribution: '<a href="https://api.mapy.com/copyright" target="_blank" rel="noopener">&copy; Seznam.cz a.s. a ďalší</a>',
    });
    if (mapset === 'aerial') labels = L.tileLayer(mapyTileUrl('names-overlay', key), { minZoom: 0, maxZoom: 19 });
  } else {
    tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' });
  }
  let reported = false;
  tiles.on('tileerror', async (ev) => {
    if (reported) return; reported = true;
    if (!key) { showMapError('Podklad OpenStreetMap sa nenačítal. Zadaj v Nastaveniach kľúč Mapy.com.'); return; }
    showMapError(await diagnoseKey(key));
  });
  tiles.on('load', () => { if (!reported) $('mapErr').hidden = true; });
  tiles.addTo(map);
  if (labels) labels.addTo(map);
  $('keyMsg').hidden = !!key;
  renderMapTypes();
}
function renderMapTypes() {
  const box = $('mapTypes'); if (!box) return;
  const key = mapyKey(), cur = currentMapset();
  box.innerHTML = '';
  MAPSETS.forEach((m) => {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.mapset = m.id; b.setAttribute('aria-pressed', String(m.id === cur));
    const img = document.createElement('span'); img.className = 'mt-img mt-' + m.id;
    if (key) img.style.backgroundImage = `url("${API}/maptiles/${m.id}/256/7/70/44?apikey=${encodeURIComponent(key)}")`;
    const t = document.createElement('span'); t.textContent = m.name;
    b.append(img, t);
    b.addEventListener('click', () => {
      store.set('mapset', m.id); setTiles(); box.hidden = true; $('btnLayers').setAttribute('aria-expanded', 'false');
      if (state.route) $('btnMapy').href = $('btnMapy').href.replace(/mapset=[a-z]+/, 'mapset=' + mapyLinkMapset());
    });
    box.append(b);
  });
  const h = document.createElement('div'); h.className = 'mt-head'; h.textContent = 'Vrstvy navyše'; box.append(h);
  const on = overlayIds();
  OVERLAYS.forEach((o) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'mt-toggle'; b.dataset.overlay = o.id; b.setAttribute('aria-pressed', String(on.includes(o.id)));
    b.innerHTML = '<i></i>'; const t = document.createElement('span'); t.textContent = o.name; b.append(t);
    b.addEventListener('click', () => { toggleOverlay(o.id); b.setAttribute('aria-pressed', String(overlayIds().includes(o.id))); });
    box.append(b);
  });
  const a = document.createElement('a'); a.id = 'heatLink'; a.className = 'mt-heat'; a.target = '_blank'; a.rel = 'noopener';
  a.innerHTML = '<b>Heatmapa Strava ↗</b><small>kade ľudia jazdia, otvorí sa na strava.com</small>';
  box.append(a); updateHeatLink();
  const lbl = $('btnLayers').querySelector('span');
  if (lbl) lbl.textContent = MAPSETS.find((m) => m.id === cur).name;
}
function mapyLinkMapset() { return currentMapset(); }

/* Prekryvné vrstvy: značené trasy z OpenStreetMap (Waymarked Trails) */
const OVERLAYS = [
  { id: 'cycling', name: 'Cyklotrasy' },
  { id: 'mtb', name: 'MTB trasy' },
];
const overlayLayers = {};
function overlayIds() { const v = store.get('overlays', []); return Array.isArray(v) ? v.filter((id) => OVERLAYS.some((o) => o.id === id)) : []; }
function showOverlay(id) {
  if (!overlayLayers[id]) overlayLayers[id] = L.tileLayer(`https://tile.waymarkedtrails.org/${id}/{z}/{x}/{y}.png`, {
    maxZoom: 19, opacity: 0.85, zIndex: 5,
    attribution: '<a href="https://waymarkedtrails.org" target="_blank" rel="noopener">Waymarked Trails</a>, &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  });
  overlayLayers[id].addTo(map);
}
function toggleOverlay(id) {
  const on = overlayIds(), i = on.indexOf(id);
  if (i >= 0) { on.splice(i, 1); if (overlayLayers[id]) map.removeLayer(overlayLayers[id]); } else { on.push(id); showOverlay(id); }
  store.set('overlays', on);
}
function heatUrl() {
  const c = map.getCenter(), z = Math.max(3, Math.min(17, map.getZoom()));
  return `https://www.strava.com/maps/global-heatmap?sport=Ride&style=dark&terrain=false&labels=true&poi=true&gColor=blue&gOpacity=100#${z}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`;
}
function updateHeatLink() { const a = $('heatLink'); if (a) a.href = heatUrl(); }
function showMapError(t) { const el = $('mapErr'); el.textContent = t; el.hidden = false; }
async function diagnoseKey(key) {
  try {
    const r = await fetch(`${API}/suggest?query=Praha&limit=1&apikey=${encodeURIComponent(key)}`);
    if (r.ok) return 'Kľúč funguje, ale mapové dlaždice sa nenačítali. Skontroluj internet alebo obnov stránku (F5).';
    if (r.status === 401 || r.status === 403) return `Mapy.com kľúč odmietli (chyba ${r.status}). Skontroluj, či si skopírovala celý kľúč bez medzier, a či pri kľúči na developer.mapy.com nie je nastavené obmedzenie na doménu.`;
    if (r.status === 429) return 'Mapy.com hlásia priveľa požiadaviek alebo vyčerpané kredity (chyba 429).';
    return `Mapy.com vrátili chybu ${r.status}.`;
  } catch (e) {
    return 'Prehliadač nepustil spojenie na Mapy.com. Ak máš appku otvorenú zo súboru, skús iný prehliadač (Chrome alebo Edge) alebo mi napíš, dám ju na internet.';
  }
}
setTiles();
overlayIds().forEach(showOverlay);
map.on('moveend', updateHeatLink);
$('btnLayers').addEventListener('click', (e) => {
  e.stopPropagation();
  const box = $('mapTypes'); box.hidden = !box.hidden; $('btnLayers').setAttribute('aria-expanded', String(!box.hidden));
});
document.addEventListener('click', (e) => {
  if (!$('mapTypes').hidden && !e.target.closest('#mapTypes')) { $('mapTypes').hidden = true; $('btnLayers').setAttribute('aria-expanded', 'false'); }
});

const layers = {
  route: L.layerGroup().addTo(map),
  markers: L.layerGroup().addTo(map),
  extra: L.layerGroup().addTo(map),
  pois: L.layerGroup().addTo(map),
  photos: L.layerGroup().addTo(map),
};
let hoverMarker = null;

function pinIcon(cls, text = '') {
  return L.divIcon({ className: '', html: `<div class="pin ${cls}">${text}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
}

/* ---------- Pomocné ---------- */
function haversine(a, b) {
  const R = 6371000, t = Math.PI / 180;
  const dLat = (b[0] - a[0]) * t, dLon = (b[1] - a[1]) * t;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * t) * Math.cos(b[0] * t) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function destination(p, km, deg) {
  const R = 6371, t = Math.PI / 180, br = deg * t, d = km / R;
  const lat1 = p.lat * t, lon1 = p.lon * t;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lon2 = lon1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 / t, lon: lon2 / t };
}
const ll = (p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`;
const fmtKm = (m) => (m / 1000).toFixed(m < 10000 ? 1 : 0);
function fmtTime(s) { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}:${String(m).padStart(2, '0')}` : `${m} min`; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(t, err = false) {
  const el = $('toast'); el.textContent = t; el.className = 'msg' + (err ? ' err' : ''); el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 5000);
}
let busyN = 0;
function busy(on, text = 'Počítam…') { busyN += on ? 1 : -1; $('busy').textContent = text; $('busy').hidden = busyN <= 0; }

async function mapy(path, params) {
  const key = mapyKey();
  if (!key) { openSettings(); throw new Error('Chýba API kľúč Mapy.com. Zadaj ho v Nastaveniach.'); }
  const q = new URLSearchParams({ ...params, apikey: key });
  const r = await fetch(`${API}${path}?${q}`);
  if (r.status === 401 || r.status === 403) throw new Error('Mapy.com odmietli API kľúč. Skontroluj ho v Nastaveniach.');
  if (r.status === 429) throw new Error('Mapy.com: priveľa požiadaviek alebo vyčerpané kredity. Skús to o chvíľu.');
  if (!r.ok) {
    let msg = ''; try { const j = await r.json(); msg = j.message || j.detail?.[0]?.msg || ''; } catch {}
    throw new Error(`Mapy.com vrátili chybu ${r.status}${msg ? ': ' + msg : ''}.`);
  }
  return r.json();
}

/* ---------- Trasa ---------- */
async function fetchRoute(pts, routeType) {
  const params = { start: ll(pts[0]), end: ll(pts[pts.length - 1]), routeType, format: 'geojson', lang: 'sk' };
  if (pts.length > 2) params.waypoints = pts.slice(1, -1).map(ll).join(';');
  const j = await mapy('/routing/route', params);
  const coords = j.geometry.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
  return { coords, cum, length: j.length, duration: j.duration, parts: j.parts || [] };
}

function resample(route, n) {
  const out = []; const total = route.cum[route.cum.length - 1];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = (total * i) / (n - 1);
    while (j < route.cum.length - 2 && route.cum[j + 1] < d) j++;
    const seg = route.cum[j + 1] - route.cum[j] || 1, f = Math.min(1, Math.max(0, (d - route.cum[j]) / seg));
    const a = route.coords[j], b = route.coords[j + 1] || a;
    out.push({ d, lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f });
  }
  return out;
}

async function fetchProfile(route) {
  const n = Math.max(2, Math.min(256, Math.ceil(route.cum[route.cum.length - 1] / 40)));
  const s = resample(route, n);
  const j = await mapy('/elevation', { positions: s.map(ll).join(';') });
  const e = j.items.map((it) => it.elevation);
  for (let i = 0; i < e.length; i++) if (e[i] < -1000) e[i] = i ? e[i - 1] : (e.find((x) => x > -1000) ?? 0);
  return { d: s.map((x) => x.d), e, pts: s };
}

function analyse(r = state.route, p = state.prof, rt = currentRouteType(), pts = currentPoints()) {
  if (!r || !p) return null;
  const bike = { ...bikeParams(), routeType: rt };
  // vyhladenie a hysterézia proti šumu
  let up = 0, down = 0, ref = p.e[0];
  for (const h of p.e) { if (h - ref > 3) { up += h - ref; ref = h; } else if (ref - h > 3) { down += ref - h; ref = h; } }
  // max sklon na úsekoch ~200 m
  let maxGrade = 0; const steep = [];
  for (let i = 0, k = 0; i < p.d.length; i++) {
    while (k < p.d.length - 1 && p.d[k] - p.d[i] < 200) k++;
    if (k > i && p.d[k] - p.d[i] >= 100) {
      const g = ((p.e[k] - p.e[i]) / (p.d[k] - p.d[i])) * 100;
      if (Math.abs(g) > maxGrade && g > 0) maxGrade = g;
      if (g > 8) steep.push([p.d[i], p.d[k]]);
    }
  }
  // povrch (z OpenStreetMap) a počasie: vietor po úsekoch, chlad znižuje kapacitu batérie
  if (state.surface?.route === r) bike.surf = state.surface.factor;
  const wx = Weather.forRoute(r, p);
  const cold = wx?.cold || 1;
  // spotreba po úsekoch + nabíjacie zastávky
  const stops = chargeStopDistances(r, pts);
  let wh = bike.wh * bike.soc / 100 * Energy.usableShare * cold;
  const cap = bike.wh * Energy.usableShare * cold;
  const socAt = [100 * wh / (bike.wh)];
  let at20 = null, at0 = null, si = 0, used = 0;
  for (let i = 1; i < p.d.length; i++) {
    while (si < stops.length && stops[si] <= p.d[i]) { wh = Math.min(cap, wh + Energy.chargerW * (+$('chargeMin').value) / 60); si++; }
    const km = (p.d[i] - p.d[i - 1]) / 1000, dh = p.e[i] - p.e[i - 1];
    if (wx) bike.wind = wx.wind[i];
    const c = Energy.flat(km, bike) + Energy.climb(dh, bike);
    wh -= c; used += c;
    const soc = (100 * wh) / bike.wh; socAt.push(soc);
    if (at20 == null && soc < 20) at20 = p.d[i];
    if (at0 == null && wh <= 0) at0 = p.d[i];
  }
  return { up, down, maxGrade, steep, used, endSoc: Math.max(0, (100 * wh) / bike.wh), at20, at0, socAt, wx };
}

function chargeStopDistances(r, pts) {
  if (!r || !pts?.length) return [];
  const out = []; let acc = 0;
  pts.forEach((pt, i) => {
    if (i > 0 && r.parts[i - 1]) acc += r.parts[i - 1].length;
    if (pt.charge && i > 0 && i < pts.length - 1) out.push(acc);
  });
  return out;
}
function currentRouteType() { return state.variants[state.variantIdx]?.rt || $('routeType').value; }

function bikeParams() {
  return { wh: +$('wh').value || 500, soc: Math.min(100, +$('soc').value || 100), mass: +$('mass').value || 100, assist: $('assist').value, routeType: currentRouteType(), calib: Bikes.current()?.calib || 1 };
}

/* ---------- Počasie a vietor na trase (Open-Meteo, zadarmo, bez kľúča) ---------- */
const DIR8 = ['S', 'SV', 'V', 'JV', 'J', 'JZ', 'Z', 'SZ'];
const DIR8_FROM = ['severu', 'severovýchodu', 'východu', 'juhovýchodu', 'juhu', 'juhozápadu', 'západu', 'severozápadu'];
const Weather = {
  data: null, key: '', loading: null,
  enabled() { return $('useWeather').checked; },
  startTime() {
    const v = $('rideStart').value;
    const t = v ? new Date(v) : new Date();
    return isNaN(t) ? new Date() : t;
  },
  defaultStart() {
    const t = new Date(); t.setMinutes(0, 0, 0); t.setHours(t.getHours() + 1);
    const pad = (n) => String(n).padStart(2, '0');
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:00`;
  },
  // 3 body pozdĺž trasy (štart, stred, cieľ), jedna požiadavka
  async load(r) {
    const pts = [0, 0.5, 1].map((f) => pointAtRoute(r, r.length * f));
    const key = pts.map((p) => p.map((x) => x.toFixed(2)).join(',')).join(';');
    if (this.key === key && this.data) return this.data;
    if (this.loading?.key === key) return this.loading.p;
    const q = new URLSearchParams({ latitude: pts.map((p) => p[0].toFixed(3)).join(','), longitude: pts.map((p) => p[1].toFixed(3)).join(','),
      hourly: 'temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m', wind_speed_unit: 'kmh', timezone: 'auto', forecast_days: '7' });
    const p = fetch('https://api.open-meteo.com/v1/forecast?' + q).then((res) => { if (!res.ok) throw new Error('weather ' + res.status); return res.json(); })
      .then((j) => { const arr = Array.isArray(j) ? j : [j]; this.data = { pts, loc: arr.map((x) => x.hourly) }; this.key = key; return this.data; })
      .finally(() => { this.loading = null; });
    this.loading = { key, p };
    return p;
  },
  hourIdx(h, t) {
    const pad = (n) => String(n).padStart(2, '0');
    const k = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:00`;
    return h.time.indexOf(k);
  },
  at(lat, lon, t) {
    const d = this.data; if (!d) return null;
    let bi = 0, bd = Infinity; d.pts.forEach((p, i) => { const x = haversine(p, [lat, lon]); if (x < bd) { bd = x; bi = i; } });
    const h = d.loc[bi] || d.loc[0], i = this.hourIdx(h, t);
    if (i < 0) return null;
    return { temp: h.temperature_2m[i], rain: h.precipitation_probability?.[i] ?? 0, ws: h.wind_speed_10m[i], wd: h.wind_direction_10m[i] };
  },
  // pre každý bod výškového profilu násobok spotreby na rovine podľa protivetra / vetra do chrbta
  forRoute(r, p) {
    if (!this.enabled() || !this.data || !r || !p) return null;
    const t0 = this.startTime(), as = $('assist').value, v = EBIKE_SPEED[as];
    const sec = ebikeTime(r, null, $('routeType').value) || 1, perM = sec / Math.max(1, r.length);
    const first = this.at(...pointAtRoute(r, 0), t0); if (!first) return null;
    const wind = [1]; let sumT = first.temp, nT = 1, headSum = 0, nH = 0, w = first;
    const at = (k) => (p.pts?.[k] ? [p.pts[k].lat, p.pts[k].lon] : pointAtRoute(r, p.d[k]));
    let prev = at(0);
    for (let i = 1; i < p.d.length; i++) {
      const b = at(i);
      if (i % 10 === 0) { // počasie stačí zisťovať zhruba každých 10 bodov profilu
        w = this.at(b[0], b[1], new Date(t0.getTime() + p.d[i] * perM * 1000)) || w;
        sumT += w.temp; nT++;
      }
      const hd = bearing({ lat: prev[0], lon: prev[1] }, { lat: b[0], lon: b[1] });
      const hw = w.ws * 0.7 * Math.cos((w.wd - hd) * Math.PI / 180); // vietor v 10 m je silnejší ako pri zemi
      const f = 1 + 0.55 * (((v + Math.max(-v * 0.7, hw)) / v) ** 2 - 1);
      wind.push(Math.min(2.5, Math.max(0.6, f))); headSum += hw * (p.d[i] - p.d[i - 1]); nH += p.d[i] - p.d[i - 1];
      prev = b;
    }
    const temp = sumT / nT;
    return { wind, cold: temp < 10 ? Math.max(0.75, 1 - (10 - temp) * 0.012) : 1, temp, start: first, head: nH ? headSum / nH : 0 };
  },
  // najlepší čas na vyrazenie: dnes a zajtra medzi 6:00 a 18:00, málo dažďa, slabý vietor, nie zima
  best(r) {
    const d = this.data; if (!d) return null;
    const h = d.loc[0], now = Date.now(), t0 = this.startTime();
    let best = null;
    for (let i = 0; i < h.time.length; i++) {
      const t = new Date(h.time[i]), hr = t.getHours();
      if (t.getTime() < now || hr < 6 || hr > 18 || Math.abs(t - t0) > 36 * 3600e3) continue;
      const score = (h.precipitation_probability?.[i] ?? 0) * 1.2 + h.wind_speed_10m[i] * 1.5 + Math.max(0, 12 - h.temperature_2m[i]) * 3;
      if (!best || score < best.score) best = { score, t, rain: h.precipitation_probability?.[i] ?? 0, ws: h.wind_speed_10m[i], temp: h.temperature_2m[i] };
    }
    return best;
  },
};
function pointAtRoute(r, d) {
  let i = 1; while (i < r.cum.length - 1 && r.cum[i] < d) i++;
  const seg = r.cum[i] - r.cum[i - 1] || 1, f = Math.min(1, Math.max(0, (d - r.cum[i - 1]) / seg));
  const a = r.coords[i - 1], b = r.coords[i] || a;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}
let wxToken = 0;
async function updateWeather() {
  const r = state.route, box = $('weatherInfo'); if (!r) return;
  const my = ++wxToken;
  if (!Weather.enabled()) { box.innerHTML = '<span class="hint">Počasie sa do odhadu nezapočítava.</span>'; return; }
  box.innerHTML = '<span class="hint">Načítavam predpoveď počasia…</span>';
  try { await Weather.load(r); } catch { if (my === wxToken) box.innerHTML = '<span class="hint">Predpoveď počasia sa nepodarilo načítať.</span>'; return; }
  if (my !== wxToken || r !== state.route) return;
  reanalyseVariants(); renderAll(false, true);
}
function renderWeather() {
  const box = $('weatherInfo'), a = state.analysis, wx = a?.wx;
  if (!Weather.enabled()) { box.innerHTML = '<span class="hint">Počasie sa do odhadu nezapočítava.</span>'; return; }
  if (!Weather.data) return;
  if (!wx) { box.innerHTML = '<span class="hint">Pre zvolený čas ešte nie je predpoveď (ide najviac 7 dní dopredu).</span>'; return; }
  const s = wx.start, from = DIR8_FROM[Math.round(s.wd / 45) % 8];
  const noWind = analyseNoWeather();
  const pct = noWind ? Math.round((a.used / noWind.used - 1) * 100) : 0;
  let h = `<div class="wx-now"><b>${Math.round(s.temp)} °C</b><span>vietor ${Math.round(s.ws)} km/h od ${from}</span><span>dážď ${Math.round(s.rain)} %</span></div>`;
  const notes = [];
  if (Math.abs(pct) >= 3) notes.push(pct > 0 ? `Protivietor zvýši spotrebu asi o ${pct} %.` : `Vietor do chrbta ušetrí asi ${-pct} % batérie.`);
  else notes.push('Vietor spotrebu takmer neovplyvní.');
  if (wx.cold < 1) notes.push(`Pri ${Math.round(wx.temp)} °C má batéria asi o ${Math.round((1 - wx.cold) * 100)} % menšiu kapacitu.`);
  if (s.rain >= 50) notes.push('Počítaj s dažďom, zober si bundu.');
  h += `<p class="hint">${notes.join(' ')}</p>`;
  const b = Weather.best(state.route);
  if (b && Math.abs(b.t - Weather.startTime()) >= 3600e3 && b.score + 15 < (s.rain * 1.2 + s.ws * 1.5 + Math.max(0, 12 - s.temp) * 3)) {
    const day = b.t.toDateString() === new Date().toDateString() ? 'dnes' : b.t.toLocaleDateString('sk', { weekday: 'long' });
    h += `<p class="wx-best">Lepšie bude vyraziť ${day} o ${b.t.getHours()}:00 (${Math.round(b.temp)} °C, vietor ${Math.round(b.ws)} km/h, dážď ${Math.round(b.rain)} %). <button type="button" class="linkbtn" id="wxUseBest">Nastaviť tento čas</button></p>`;
  }
  box.innerHTML = h;
  $('wxUseBest')?.addEventListener('click', () => {
    const t = b.t, pad = (n) => String(n).padStart(2, '0');
    $('rideStart').value = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:00`;
    reanalyseVariants(); renderAll(false, true);
  });
}
function analyseNoWeather() {
  const was = $('useWeather').checked; $('useWeather').checked = false;
  try { return analyse(); } finally { $('useWeather').checked = was; }
}

/* ---------- Povrch trasy z OpenStreetMap ---------- */
const SURF = {
  paved: { name: 'Asfalt', f: 1.0, col: '#5aa9ff' },
  gravel: { name: 'Šotolina', f: 1.15, col: '#f0a35e' },
  rough: { name: 'Terén', f: 1.3, col: '#b9785a' },
  unknown: { name: 'Neznámy', f: null, col: '#4a5f80' },
};
function surfClass(t) {
  const sf = t.surface || '', hw = t.highway || '', tt = t.tracktype || '';
  if (/^(asphalt|paved|concrete|concrete:plates|paving_stones|sett|chipseal|metal|wood)$/.test(sf)) return 'paved';
  if (/^(compacted|fine_gravel|gravel|pebblestone|unhewn_cobblestone)$/.test(sf)) return 'gravel';
  if (/^(dirt|ground|earth|grass|mud|sand|unpaved|rock|roots|woodchips)$/.test(sf)) return 'rough';
  if (hw === 'track') return tt === 'grade1' ? 'paved' : tt === 'grade2' ? 'gravel' : tt ? 'rough' : 'gravel';
  if (/^(path|bridleway)$/.test(hw)) return 'rough';
  if (/^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|cycleway)(_link)?$/.test(hw)) return 'paved';
  return 'unknown';
}
let surfToken = 0; const surfCache = new Map();
async function updateSurface() {
  const r = state.route, my = ++surfToken; if (!r) return;
  $('surfBox').hidden = true;
  if (r.length > 150000) return;
  const n = Math.min(150, Math.max(10, Math.round(r.length / 300)));
  const line = resample(r, n).map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(',');
  const q = `[out:json][timeout:25];way(around:20,${line})["highway"];out tags geom qt;`;
  let ways = surfCache.get(line);
  if (!ways) {
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: new URLSearchParams({ data: q }) });
      if (!res.ok) return;
      ways = (await res.json()).elements.filter((e) => e.geometry);
      surfCache.set(line, ways);
    } catch { return; }
  }
  if (my !== surfToken || r !== state.route) return;
  const C = 0.0004, kx = Math.cos(r.coords[0][0] * Math.PI / 180), grid = new Map(), cell = (la, lo) => Math.floor(la / C) + ':' + Math.floor((lo * kx) / C);
  for (const w of ways) {
    const cls = surfClass(w.tags || {}), g = w.geometry;
    for (let i = 0; i < g.length - 1; i++) {
      const a = [g[i].lat, g[i].lon], c = [g[i + 1].lat, g[i + 1].lon], k = Math.max(1, Math.ceil(haversine(a, c) / 12));
      for (let j = 0; j <= k; j++) { const la = a[0] + ((c[0] - a[0]) * j) / k, lo = a[1] + ((c[1] - a[1]) * j) / k, key = cell(la, lo); (grid.get(key) || grid.set(key, []).get(key)).push([la, lo, cls]); }
    }
  }
  const sm = resample(r, Math.min(1500, Math.max(20, Math.round(r.length / 50))));
  const cnt = { paved: 0, gravel: 0, rough: 0, unknown: 0 };
  for (const p of sm) {
    const ci = Math.floor(p.lat / C), cj = Math.floor((p.lon * kx) / C); let best = null, bd = 25;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const q2 of grid.get((ci + di) + ':' + (cj + dj)) || []) { const d = haversine([p.lat, p.lon], q2); if (d < bd) { bd = d; best = q2[2]; } }
    cnt[best || 'unknown']++;
  }
  const shares = Object.fromEntries(Object.entries(cnt).map(([k, v]) => [k, v / sm.length]));
  const known = 1 - shares.unknown;
  const factor = known > 0.2 ? (shares.paved * 1 + shares.gravel * 1.15 + shares.rough * 1.3 + shares.unknown * Energy.surface[currentRouteType()]) : null;
  state.surface = { route: r, shares, factor };
  reanalyseVariants(); renderAll(false, true);
}
function renderSurface() {
  const sf = state.surface; if (!sf || sf.route !== state.route) { $('surfBox').hidden = true; return; }
  $('surfBox').hidden = false;
  $('surfBar').innerHTML = Object.entries(sf.shares).filter(([, v]) => v > 0.005).map(([k, v]) => `<i style="width:${(v * 100).toFixed(1)}%;background:${SURF[k].col}" title="${SURF[k].name} ${Math.round(v * 100)} %"></i>`).join('');
  $('surfLegend').innerHTML = Object.entries(sf.shares).filter(([, v]) => v >= 0.01).map(([k, v]) => `<span><i style="background:${SURF[k].col}"></i>${SURF[k].name} ${Math.round(v * 100)} %</span>`).join('');
}

/* ---------- Výpočet a vykreslenie ---------- */
let calcToken = 0;
async function recalc() {
  const pts = state.mode === 'ab' ? state.points : null;
  if (state.mode === 'ab' && (!pts || pts.length < 2)) { clearRoute(); return; }
  if (state.mode === 'loop') { renderMarkers(); return; }
  const my = ++calcToken;
  busy(true, 'Hľadám varianty trasy…');
  try {
    const vs = await findAlternatives(pts, () => my !== calcToken);
    if (my !== calcToken || !vs) return;
    state.imported = null; state.variants = vs; pickVariant(0);
    loadVariantThumbs(vs); scoreCycleShare(vs);
  } catch (e) { toast(e.message, true); }
  finally { busy(false); }
}

/* ---------- Varianty trasy z A do B ---------- */
const DIRS = ['sever', 'severovýchod', 'východ', 'juhovýchod', 'juh', 'juhozápad', 'západ', 'severozápad'];
function bearing(a, b) {
  const t = Math.PI / 180, y = Math.sin((b.lon - a.lon) * t) * Math.cos(b.lat * t);
  const x = Math.cos(a.lat * t) * Math.sin(b.lat * t) - Math.sin(a.lat * t) * Math.cos(b.lat * t) * Math.cos((b.lon - a.lon) * t);
  return (Math.atan2(y, x) / t + 360) % 360;
}
const dirName = (deg) => DIRS[Math.round(deg / 45) % 8];
function similar(r1, r2) {
  if (Math.abs(r1.length - r2.length) / Math.max(r1.length, r2.length) > 0.04) return false;
  const a = resample(r1, 12), b = resample(r2, 12);
  return a.reduce((s, p, i) => s + haversine([p.lat, p.lon], [b[i].lat, b[i].lon]), 0) / a.length < 400;
}
async function findAlternatives(pts, cancelled) {
  const sel = $('routeType').value, other = sel === 'bike_road' ? 'bike_mountain' : 'bike_road';
  const cands = [
    { pts, rt: sel, label: 'Odporúčaná' },
    { pts, rt: other, label: other === 'bike_mountain' ? 'Cykloturistická, aj nespevnené cesty' : 'Viac po asfalte' },
  ];
  if (pts.length < 17) {
    // najdlhší úsek medzi bodmi odkloníme vľavo a vpravo
    let li = 0, lmax = 0;
    for (let i = 0; i < pts.length - 1; i++) { const d = haversine([pts[i].lat, pts[i].lon], [pts[i + 1].lat, pts[i + 1].lon]); if (d > lmax) { lmax = d; li = i; } }
    const a = pts[li], b = pts[li + 1], mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }, br = bearing(a, b);
    const km = Math.min(12, Math.max(1, lmax / 1000 * 0.2));
    for (const [mult, side] of [[1, -90], [1, 90], [2, -90], [2, 90]]) {
      const via = { ...destination(mid, km * mult, br + side), label: null, via: true };
      const np = [...pts.slice(0, li + 1), via, ...pts.slice(li + 1)];
      cands.push({ pts: np, rt: sel, label: `Cez ${dirName(bearing(mid, via))}${mult > 1 ? ' (väčší oblúk)' : ''}` });
    }
  }
  const out = [];
  const tryAdd = async (list) => {
    const res = await Promise.allSettled(list.map((c) => fetchRoute(c.pts, c.rt)));
    res.forEach((r, i) => {
      if (r.status !== 'fulfilled') { if (!out.length && i === 0) throw r.reason; return; }
      if (!out.some((o) => similar(o.route, r.value))) out.push({ ...list[i], route: r.value });
    });
  };
  await tryAdd(cands.slice(0, 4));
  if (cancelled()) return null;
  if (out.length < 4 && cands.length > 4) await tryAdd(cands.slice(4));
  if (cancelled()) return null;
  if (!out.length) throw new Error('Trasu sa nepodarilo naplánovať. Skús posunúť body bližšie k cestám.');
  await Promise.all(out.map(async (v) => { v.prof = await fetchProfile(v.route); v.a = analyse(v.route, v.prof, v.rt, v.pts); }));
  markBest(out);
  return out;
}
function markBest(vs) {
  const by = (f) => vs.reduce((b, v) => (f(v) < f(b) ? v : b), vs[0]);
  vs.forEach((v) => (v.tags = []));
  if (vs.length > 1) {
    by((v) => v.route.length).tags.push('najkratšia');
    by((v) => v.a.up).tags.push('najmenej stúpania');
    by((v) => -v.a.endSoc).tags.push('najviac batérie');
  }
}
// Koľko % variantu vedie po značených cyklo a MTB trasách alebo cyklochodníkoch (OpenStreetMap).
// Strava heatmapu nesprístupňuje, značené trasy sú najbližšia náhrada za „kade sa jazdí“.
const cycleCache = new Map();
async function cycleWays(b) {
  const bb = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((x) => x.toFixed(3)).join(',');
  if (cycleCache.has(bb)) return cycleCache.get(bb);
  const q = `[out:json][timeout:25];(rel["route"~"^(bicycle|mtb)$"](${bb});)->.r;(way(r.r)(${bb});way["highway"="cycleway"](${bb});way["bicycle"="designated"](${bb}););out geom qt 20000;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: new URLSearchParams({ data: q }) });
  if (!res.ok) throw new Error('overpass ' + res.status);
  const j = await res.json();
  const ways = j.elements.filter((e) => e.geometry).map((e) => e.geometry.map((g) => [g.lat, g.lon]));
  cycleCache.set(bb, ways);
  return ways;
}
async function scoreCycleShare(vs) {
  if (!vs?.length) return;
  const b = L.latLngBounds(vs.flatMap((v) => v.route.coords)).pad(0.02);
  if (haversine([b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]) > 160000) return; // príliš veľké územie pre Overpass
  let ways;
  try { ways = await cycleWays(b); } catch (e) { return; }
  const C = 0.0005, lat0 = b.getCenter().lat, kx = Math.cos(lat0 * Math.PI / 180);
  const grid = new Map(), cell = (la, lo) => Math.floor(la / C) + ':' + Math.floor((lo * kx) / C);
  for (const w of ways) for (let i = 0; i < w.length - 1; i++) {
    const a = w[i], c = w[i + 1], n = Math.max(1, Math.ceil(haversine(a, c) / 15));
    for (let k = 0; k <= n; k++) {
      const la = a[0] + ((c[0] - a[0]) * k) / n, lo = a[1] + ((c[1] - a[1]) * k) / n, key = cell(la, lo);
      (grid.get(key) || grid.set(key, []).get(key)).push([la, lo]);
    }
  }
  const near = (la, lo) => {
    const ci = Math.floor(la / C), cj = Math.floor((lo * kx) / C);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const g = grid.get((ci + di) + ':' + (cj + dj)); if (!g) continue;
      for (const q of g) if (haversine([la, lo], q) < 30) return true;
    }
    return false;
  };
  for (const v of vs) {
    const sm = resample(v.route, Math.min(2000, Math.max(20, Math.round(v.route.length / 50))));
    v.cycle = Math.round((100 * sm.filter((p) => near(p.lat, p.lon)).length) / sm.length);
  }
  if (vs.length > 1) {
    const best = vs.reduce((m, v) => (v.cycle > m.cycle ? v : m), vs[0]);
    if (best.cycle >= 10) best.tags = [...(best.tags || []).filter((t) => t !== 'najviac po cyklotrasách'), 'najviac po cyklotrasách'];
  }
  if (state.variants === vs) renderVariants();
}

async function loadVariantThumbs(vs) {
  await Promise.all(vs.map(async (v) => {
    const spots = resample(v.route, 5).slice(1, 4); v.thumbs = [];
    for (const s of spots) {
      const ph = await commonsNear(s, 1000, 3).catch(() => []);
      for (const p of ph) if (v.thumbs.length < 3 && !v.thumbs.some((t) => t.href === p.href)) v.thumbs.push(p);
    }
  }));
  if (state.variants === vs) renderVariants();
}

function clearRoute() {
  state.route = null; state.prof = null; state.analysis = null; state.imported = null;
  if (state.mode === 'ab') { state.variants = []; state.variantIdx = -1; renderVariants(); }
  $('webBox').hidden = true;
  layers.route.clearLayers(); layers.extra.clearLayers(); layers.pois.clearLayers(); layers.photos.clearLayers();
  $('results').hidden = true; $('poiList').innerHTML = ''; $('gallery').innerHTML = '';
  ['btnGpx', 'btnShare', 'btnLink', 'btnSave', 'btnCharge', 'btnPhotos', 'btnQr'].forEach((b) => ($(b).disabled = true));
  $('btnMapy').hidden = true;
  renderMarkers(); updateRangeHint(); if (typeof renderSheetSum === 'function') renderSheetSum();
}

function renderAll(fit, fromData = false) {
  if (!fromData && state.surface?.route !== state.route) state.surface = null;
  state.analysis = analyse();
  const r = state.route, a = state.analysis;
  layers.route.clearLayers(); layers.extra.clearLayers();
  state.variants.forEach((v, i) => {
    if (i === state.variantIdx) return;
    L.polyline(v.route.coords, { color: '#5b6b85', weight: 5, opacity: 0.6 }).on('click', (e) => { L.DomEvent.stop(e); pickVariant(i); })
      .bindTooltip(`${v.label}: ${fmtKm(v.route.length)} km, ↑ ${Math.round(v.a.up)} m`, { sticky: true }).addTo(layers.route);
  });
  L.polyline(r.coords, { color: '#ffffff', weight: 9, opacity: 0.9 }).addTo(layers.route);
  L.polyline(r.coords, { color: '#1e5bd8', weight: 5 }).addTo(layers.route);
  for (const [d0, d1] of a.steep) L.polyline(sliceByDist(d0, d1), { color: '#c0702a', weight: 6 }).addTo(layers.extra);
  if (a.at20 != null) L.marker(pointAt(a.at20), { icon: pinIcon('batt', '20'), title: 'Batéria pod 20 %' }).addTo(layers.extra);
  if (a.at0 != null) L.marker(pointAt(a.at0), { icon: pinIcon('batt', '0'), title: 'Batéria sa minie' }).addTo(layers.extra);
  if (fit) map.fitBounds(L.latLngBounds(r.coords), { padding: [30, 30] });
  renderMarkers(); renderStats(); drawChart();
  ['btnGpx', 'btnShare', 'btnLink', 'btnSave', 'btnCharge', 'btnPhotos', 'btnQr'].forEach((b) => ($(b).disabled = false));
  let mp = currentPoints();
  if (mp.length < 2) { const c0 = r.coords[0], c1 = r.coords[r.coords.length - 1]; mp = [{ lat: c0[0], lon: c0[1] }, { lat: c1[0], lon: c1[1] }]; }
  let q = `mapset=${mapyLinkMapset()}&start=${ll(mp[0])}&end=${ll(mp[mp.length - 1])}&routeType=${currentRouteType()}`;
  if (mp.length > 2) q += '&waypoints=' + mp.slice(1, -1).map(ll).join(';');
  $('btnMapy').href = 'https://mapy.com/fnc/v1/route?' + q; $('btnMapy').hidden = false;
  updateRangeHint(); renderSheetSum(); renderSurface(); renderWeather();
  if (!fromData) { renderWebLinks(); updateWeather(); if (state.surface?.route !== r) updateSurface(); rememberRoute(); }
}

function currentPoints() {
  if (state.imported) return [];
  const v = state.variants[state.variantIdx]; if (v) return v.pts;
  return state.mode === 'ab' ? state.points : [];
}
function sliceByDist(d0, d1) {
  const r = state.route, out = [pointAt(d0)];
  for (let i = 0; i < r.cum.length; i++) if (r.cum[i] > d0 && r.cum[i] < d1) out.push(r.coords[i]);
  out.push(pointAt(d1)); return out;
}
function pointAt(d) {
  const r = state.route; let i = 1;
  while (i < r.cum.length - 1 && r.cum[i] < d) i++;
  const seg = r.cum[i] - r.cum[i - 1] || 1, f = Math.min(1, Math.max(0, (d - r.cum[i - 1]) / seg));
  const a = r.coords[i - 1], b = r.coords[i];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

function renderStats() {
  const r = state.route, a = state.analysis; $('results').hidden = false;
  $('sKm').textContent = fmtKm(r.length);
  $('sUp').textContent = Math.round(a.up);
  $('sDown').textContent = Math.round(a.down);
  $('sTime').textContent = fmtTime(ebikeTime(r, a, currentRouteType()));
  $('sGrade').textContent = a.maxGrade.toFixed(0);
  $('sBatt').textContent = a.at0 != null ? '0 %' : Math.round(a.endSoc) + ' %';
  const bar = $('battBar'); bar.style.width = Math.round(a.endSoc) + '%';
  bar.style.background = a.endSoc < 10 ? 'var(--danger)' : a.endSoc < 25 ? 'var(--warn)' : 'var(--ok)';
  const lim = { km: +$('maxKm').value, up: +$('maxUp').value, g: +$('maxGrade').value };
  const chip = (ok, t) => `<span class="chip ${ok ? 'ok' : 'bad'}">${esc(t)}</span>`;
  let h = chip(r.length / 1000 <= lim.km, `Dĺžka ${fmtKm(r.length)} / ${lim.km} km`)
    + chip(a.up <= lim.up, `Stúpanie ${Math.round(a.up)} / ${lim.up} m`)
    + chip(a.maxGrade <= lim.g, `Sklon ${a.maxGrade.toFixed(0)} / ${lim.g} %`);
  if (a.at0 != null) h += `<span class="chip bad">Batéria sa minie na ${fmtKm(a.at0)}. km</span>${state.imported ? '' : '<button type="button" class="primary sm" id="btnAutoCharge">⚡ Pridať nabíjanie automaticky</button>'}`;
  else if (a.at20 != null) h += `<span class="chip warn">Pod 20 % od ${fmtKm(a.at20)}. km</span>`;
  else h += `<span class="chip ok">Spotreba ~${Math.round(a.used)} Wh</span>`;
  const [lv, lvName] = levelOf(r.length / 1000, a.up, a.maxGrade);
  h = `<span class="lvl lvl-${lv}">Obtiažnosť: ${lvName}</span>` + h;
  const over = r.length / 1000 > lim.km || a.up > lim.up || a.maxGrade > lim.g;
  if (over) h += `<p class="hint" style="width:100%">Trasa je nad nastavenú obtiažnosť. ${state.mode === 'loop' ? 'Skús iný variant alebo kratší okruh.' : 'Skús iný povrch, posuň prejazdný bod alebo zvoľ okruh s nižšou dĺžkou.'}</p>`;
  $('checks').innerHTML = h;
  $('btnAutoCharge')?.addEventListener('click', autoCharge);
}

function updateRangeHint() {
  const b = bikeParams(), a = state.analysis;
  let t = `Dojazd na rovine ~${Math.round(Energy.flatRangeKm(b))} km.`;
  if (a && state.route) {
    const perKm = a.used / (state.route.length / 1000);
    t += ` Na tejto trase ~${perKm.toFixed(1)} Wh/km, teda ~${Math.round((b.wh * b.soc / 100 * Energy.usableShare) / perKm)} km na batériu.`;
  }
  $('rangeHint').textContent = t + ' Odhad, reálna spotreba závisí od vetra, teploty a tlaku v pneumatikách.';
}

/* ---------- Výškový profil ---------- */
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function drawChart(hoverX = null) {
  const p = state.prof; if (!p) return;
  const cv = $('chartCanvas'), box = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cv.width = box.width * dpr; cv.height = box.height * dpr;
  const c = cv.getContext('2d'); c.scale(dpr, dpr);
  const W = box.width, H = box.height, padL = 38, padB = 18, padT = 8, padR = 8;
  const min = Math.min(...p.e), max = Math.max(...p.e), span = Math.max(20, max - min);
  const lo = Math.floor((min - span * 0.08) / 10) * 10, hi = Math.ceil((max + span * 0.08) / 10) * 10;
  const total = p.d[p.d.length - 1] || 1;
  const X = (d) => padL + ((W - padL - padR) * d) / total, Y = (e) => padT + (H - padT - padB) * (1 - (e - lo) / (hi - lo));
  c.font = '11px ' + cssVar('--font-body'); c.fillStyle = cssVar('--muted'); c.strokeStyle = cssVar('--line'); c.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const e = lo + ((hi - lo) * i) / 3, y = Y(e);
    c.beginPath(); c.moveTo(padL, y); c.lineTo(W - padR, y); c.stroke();
    c.fillText(Math.round(e) + ' m', 2, y + 4);
  }
  const step = total > 60000 ? 20000 : total > 20000 ? 10000 : total > 8000 ? 2000 : 1000;
  for (let d = 0; d <= total; d += step) c.fillText(d / 1000 + ' km', Math.min(X(d), W - 36), H - 4);
  c.beginPath(); c.moveTo(X(0), Y(lo));
  p.d.forEach((d, i) => c.lineTo(X(d), Y(p.e[i])));
  c.lineTo(X(total), Y(lo)); c.closePath();
  c.fillStyle = cssVar('--accent-soft'); c.fill();
  c.beginPath(); p.d.forEach((d, i) => (i ? c.lineTo(X(d), Y(p.e[i])) : c.moveTo(X(d), Y(p.e[i])))); c.strokeStyle = cssVar('--accent'); c.lineWidth = 2; c.stroke();
  c.strokeStyle = cssVar('--climb'); c.lineWidth = 3;
  for (const [d0, d1] of state.analysis?.steep || []) {
    c.beginPath(); let s = false;
    p.d.forEach((d, i) => { if (d >= d0 && d <= d1) { s ? c.lineTo(X(d), Y(p.e[i])) : c.moveTo(X(d), Y(p.e[i])); s = true; } });
    c.stroke();
  }
  const a = state.analysis;
  for (const [d, col] of [[a?.at20, cssVar('--warn')], [a?.at0, cssVar('--danger')]]) {
    if (d == null) continue; c.strokeStyle = col; c.setLineDash([4, 3]); c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(X(d), padT); c.lineTo(X(d), H - padB); c.stroke(); c.setLineDash([]);
  }
  if (hoverX != null) {
    const d = Math.max(0, Math.min(total, ((hoverX - padL) / (W - padL - padR)) * total));
    let i = 0; while (i < p.d.length - 1 && p.d[i] < d) i++;
    c.strokeStyle = cssVar('--ink'); c.lineWidth = 1; c.beginPath(); c.moveTo(X(p.d[i]), padT); c.lineTo(X(p.d[i]), H - padB); c.stroke();
    const tip = $('tip'); tip.hidden = false;
    tip.textContent = `${(p.d[i] / 1000).toFixed(1)} km · ${Math.round(p.e[i])} m · batéria ${Math.max(0, Math.round(a.socAt[i]))} %`;
    tip.style.left = Math.min(Math.max(0, X(p.d[i]) - 80), W - 200) + 'px';
    const pos = pointAt(p.d[i]);
    if (!hoverMarker) hoverMarker = L.circleMarker(pos, { radius: 7, color: '#fff', weight: 2, fillColor: '#c0702a', fillOpacity: 1 }).addTo(map);
    else hoverMarker.setLatLng(pos);
  }
}
function chartHover(ev) {
  if (!state.prof) return;
  const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - $('chartCanvas').getBoundingClientRect().left;
  drawChart(x);
}
$('chart').addEventListener('mousemove', chartHover);
$('chart').addEventListener('touchmove', (e) => { chartHover(e); e.preventDefault(); }, { passive: false });
$('chart').addEventListener('mouseleave', () => { $('tip').hidden = true; if (hoverMarker) { map.removeLayer(hoverMarker); hoverMarker = null; } drawChart(); });
window.addEventListener('resize', () => drawChart());

/* ---------- Body trasy ---------- */
function renderMarkers() {
  layers.markers.clearLayers();
  const pts = state.mode === 'ab' ? state.points : (state.loopStart ? [state.loopStart] : []);
  pts.forEach((pt, i) => {
    const last = state.mode === 'ab' && i === pts.length - 1 && pts.length > 1;
    const cls = i === 0 ? 'start' : last ? 'end' : pt.charge ? 'charge' : 'mid';
    const txt = i === 0 ? 'A' : last ? 'B' : pt.charge ? '⚡' : String(i);
    const m = L.marker([pt.lat, pt.lon], { icon: pinIcon(cls === 'start' ? '' : cls, txt), draggable: true }).addTo(layers.markers);
    m.on('dragend', () => {
      const p = m.getLatLng(); pt.lat = p.lat; pt.lon = p.lng; pt.label = pt.charge ? pt.label : null;
      if (state.mode === 'loop') { state.variants = []; renderVariants(); clearRoute(); }
      renderPoints(); recalc(); nameLater(pt);
    });
  });
  const cv = state.variants[state.variantIdx];
  if (cv) cv.pts.filter((pt) => pt.via || state.mode === 'loop').slice(state.mode === 'loop' ? 1 : 0).forEach((pt) => L.circleMarker([pt.lat, pt.lon], { radius: 4, color: '#1e5bd8' }).bindTooltip('Pomocný bod variantu').addTo(layers.markers));
}

function renderPoints() {
  const ul = $('points'); ul.innerHTML = '';
  let rows;
  if (state.mode === 'loop') rows = [{ pt: state.loopStart, idx: 0, role: 'start' }];
  else {
    rows = state.points.map((pt, idx) => ({ pt, idx }));
    while (rows.length < 2) rows.push({ pt: null, idx: rows.length });
    if (state.pendingSlot != null && state.points.length >= 2) rows.splice(state.pendingSlot, 0, { pt: null, idx: state.pendingSlot, insert: true });
    rows.forEach((r, i) => (r.role = i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'mid'));
  }
  let num = 0;
  const canMove = state.mode === 'ab' && state.pendingSlot == null && state.points.length >= 2;
  rows.forEach((r, i) => {
    const pt = r.pt, li = document.createElement('li');
    if (r.role === 'mid') num++;
    li.className = 'pt ' + (r.role === 'start' ? 'start' : r.role === 'end' ? 'end' : pt?.charge ? 'charge' : '');
    const ph = r.role === 'start' ? 'Štart' : r.role === 'end' ? 'Cieľ' : 'Prejazdný bod';
    li.innerHTML = `<span class="dot">${r.role === 'start' ? 'A' : r.role === 'end' ? 'B' : pt?.charge ? '⚡' : num}</span>
      <input id="pt${i}" placeholder="${ph}: hľadaj alebo klikni do mapy" value="${esc(pt ? pt.label || `${pt.lat.toFixed(5)}, ${pt.lon.toFixed(5)}` : '')}">
      <span class="pt-act">${canMove ? `<button class="ghost mv" data-up="${i}" title="Posunúť vyššie" aria-label="Posunúť vyššie"${i === 0 ? ' disabled' : ''}>↑</button><button class="ghost mv" data-down="${i}" title="Posunúť nižšie" aria-label="Posunúť nižšie"${i === rows.length - 1 ? ' disabled' : ''}>↓</button>` : ''}${pt || r.insert ? `<button class="ghost" data-del="${i}" title="${r.insert ? 'Zrušiť' : 'Odstrániť'}">✕</button>` : ''}</span>`;
    ul.appendChild(li);
    if (canMove) {
      li.classList.add('movable');
      li.querySelector('[data-up]').addEventListener('click', () => movePoint(i, i - 1));
      li.querySelector('[data-down]').addEventListener('click', () => movePoint(i, i + 1));
      dragHandle(li.querySelector('.dot'), li, i);
    }
    const inp = li.querySelector('input');
    attachSuggest(inp, li, (p) => {
      if (r.insert) { state.points.splice(r.idx, 0, p); state.pendingSlot = null; renderPoints(); renderMarkers(); recalc(); }
      else setPoint(r.idx, p);
    });
    if (r.insert) setTimeout(() => inp.focus(), 0);
    li.querySelector('[data-del]')?.addEventListener('click', () => {
      if (r.insert) { state.pendingSlot = null; renderPoints(); return; }
      if (state.mode === 'ab') state.points.splice(r.idx, 1); else { state.loopStart = null; state.variants = []; renderVariants(); }
      renderPoints(); clearRoute(); recalc();
    });
  });
  $('pointsHint').hidden = state.mode !== 'ab';
  $('btnAddVia').hidden = state.mode !== 'ab';
  $('btnReverse').hidden = state.mode !== 'ab'; $('btnReverse').parentElement.hidden = state.mode !== 'ab';
  $('btnReverse').disabled = state.points.length < 2;
  $('btnAddVia').disabled = state.points.length < 2 || state.points.length >= 17 || state.pendingSlot != null;
}

// zmena poradia bodov trasy (štart, prejazdné body, cieľ)
function movePoint(from, to) {
  const P = state.points;
  if (to < 0 || to >= P.length || from === to) return;
  P.splice(to, 0, P.splice(from, 1)[0]);
  renderPoints(); renderMarkers(); clearRoute(); recalc();
}
function dragHandle(handle, li, from) {
  handle.title = 'Potiahni a zmeň poradie';
  handle.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    const items = [...$('points').children], y0 = e.clientY;
    const mids = items.map((el) => { const b = el.getBoundingClientRect(); return b.top + b.height / 2; });
    let to = from;
    li.classList.add('dragging'); handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dy = ev.clientY - y0, y = mids[from] + dy;
      li.style.transform = `translateY(${dy}px)`;
      to = mids.filter((m, k) => k !== from && m < y).length;
      items.forEach((el, k) => el.classList.toggle('drop-here', k !== from && k === to));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
      li.classList.remove('dragging'); li.style.transform = '';
      items.forEach((el) => el.classList.remove('drop-here'));
      movePoint(from, to);
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  });
}
$('btnReverse').addEventListener('click', () => { if (state.points.length < 2) return; state.points.reverse(); renderPoints(); renderMarkers(); clearRoute(); recalc(); });

// bod bez názvu (klik do mapy, presun) dostane názov ulice a obce
async function nameLater(pt) {
  if (pt.label) return;
  const k = `${pt.lat.toFixed(4)},${pt.lon.toFixed(4)}`;
  let name = pointNameCache[k];
  if (name == null) {
    try {
      const j = await mapy('/rgeocode', { lon: pt.lon, lat: pt.lat, lang: 'sk' });
      const it = j.items?.[0], muni = it?.regionalStructure?.find((x) => x.type === 'regional.municipality')?.name;
      const nm = it?.name || '';
      name = !nm ? (muni || '') : muni && !nm.includes(muni) ? `${nm}, ${muni}` : nm;
    } catch { name = ''; }
    pointNameCache[k] = name;
  }
  if (!name || pt.label) return;
  pt.label = name;
  if (!$('points').contains(document.activeElement)) renderPoints();
  if (state.route) renderWebLinks();
}
const pointNameCache = {};

function setPoint(i, p) {
  if (state.mode === 'loop') { state.loopStart = p; state.variants = []; renderVariants(); clearRoute(); map.setView([p.lat, p.lon], 12); }
  else {
    if (i >= state.points.length) state.points.push(p); else state.points[i] = p;
    if (state.points.length === 1) map.setView([p.lat, p.lon], 12);
  }
  renderPoints(); renderMarkers(); recalc();
}

// nový prejazdný bod vložíme tam, kde najmenej predĺži trasu
function bestInsertIndex(p) {
  let best = 1, bestAdd = Infinity; const P = state.points, d = (a, b) => haversine([a.lat, a.lon], [b.lat, b.lon]);
  for (let i = 0; i < P.length - 1; i++) { const add = d(P[i], p) + d(p, P[i + 1]) - d(P[i], P[i + 1]); if (add < bestAdd) { bestAdd = add; best = i + 1; } }
  return best;
}
$('btnAddVia').addEventListener('click', () => { state.pendingSlot = state.points.length - 1; renderPoints(); toast('Vyhľadaj prejazdný bod alebo klikni do mapy.'); });

map.on('click', (e) => {
  const p = { lat: e.latlng.lat, lon: e.latlng.lng, label: null };
  if (state.mode === 'loop') { setPoint(0, p); nameLater(p); return; }
  if (state.points.length >= 17) { toast('Mapy.com dovolia najviac 15 prejazdných bodov.', true); return; }
  if (state.pendingSlot != null) { state.points.splice(state.pendingSlot, 0, p); state.pendingSlot = null; }
  else if (state.points.length >= 2) state.points.splice(bestInsertIndex(p), 0, p);
  else state.points.push(p);
  renderPoints(); renderMarkers(); recalc(); nameLater(p);
});

function attachSuggest(inp, host, onPick) {
  let t, box;
  const close = () => { box?.remove(); box = null; };
  inp.addEventListener('input', () => {
    clearTimeout(t);
    const q = inp.value.trim(); if (q.length < 2) { close(); return; }
    t = setTimeout(async () => {
      try {
        const c = map.getCenter();
        const j = await mapy('/suggest', { query: q, lang: 'sk', limit: 6, preferNear: `${c.lng},${c.lat}` });
        close(); box = document.createElement('div'); box.className = 'sugg';
        j.items.forEach((it) => {
          const b = document.createElement('button'); b.type = 'button';
          b.innerHTML = `${esc(it.name)}<small>${esc(it.location || it.label || '')}</small>`;
          b.addEventListener('click', () => { close(); onPick({ lat: it.position.lat, lon: it.position.lon, label: it.name }); });
          box.appendChild(b);
        });
        if (j.items.length) host.appendChild(box);
      } catch (e) { toast(e.message, true); }
    }, 300);
  });
  inp.addEventListener('blur', () => setTimeout(close, 200));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter' && box?.firstChild) box.firstChild.click(); });
}

/* ---------- Okruhy ---------- */
// okruh na kilometre alebo na čas: čas prevedieme na km podľa rýchlosti e-biku a obvyklého stúpania (~12 m na km)
function loopTargetKm() {
  if ($('loopBy').value === 'time') {
    const h = Math.max(0.5, +$('loopHours').value || 2), as = $('assist').value;
    const v = EBIKE_SPEED[as] * ($('routeType').value === 'bike_mountain' ? 0.8 : 1);
    const hPerKm = 1 / v + 12 / EBIKE_VAM[as];
    return Math.max(5, Math.round(h / hPerKm));
  }
  return Math.max(5, +$('loopKm').value || 40);
}
function renderLoopBy() {
  const t = $('loopBy').value === 'time';
  $('loopKmWrap').hidden = t; $('loopHoursWrap').hidden = !t;
  $('loopHint').textContent = t ? `Približne ${loopTargetKm()} km podľa tvojho bicykla a režimu podpory.` : '';
}
$('loopBy').addEventListener('change', () => { saveForm(); renderLoopBy(); });
$('loopHours').addEventListener('input', renderLoopBy);
async function makeLoops() {
  if (!state.loopStart) { toast('Najprv zadaj štart okruhu (klikni do mapy alebo ho vyhľadaj).', true); return; }
  const km = loopTargetKm();
  const s = state.loopStart, base = Math.random() * 360;
  busy(true, 'Navrhujem okruhy…');
  const out = [];
  try {
    for (let v = 0; v < 3; v++) {
      const dir = base + v * 120;
      let r = (km / (2 * Math.PI)) * 0.78, best = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const c = destination(s, r, dir);
        const wps = [1, 2, 3].map((k) => destination(c, r, dir + 180 + k * 90));
        const pts = [s, ...wps, s];
        try {
          const route = await fetchRoute(pts, $('routeType').value);
          best = { pts, route };
          const ratio = route.length / 1000 / km;
          if (ratio > 0.85 && ratio < 1.15) break;
          r = r / ratio;
        } catch (e) { if (attempt === 1 && !best) throw e; }
      }
      if (best) { best.prof = await fetchProfile(best.route); best.rt = $('routeType').value; best.label = `Okruh na ${dirName(dir % 360)}`; out.push(best); }
    }
    // zoradiť podľa súladu s obtiažnosťou
    const maxUp = +$('maxUp').value;
    out.forEach((v) => { v.a = analyse(v.route, v.prof, v.rt, v.pts); });
    out.sort((x, y) => (x.a.up > maxUp) - (y.a.up > maxUp) || Math.abs(x.route.length / 1000 - km) - Math.abs(y.route.length / 1000 - km));
    markBest(out); state.variants = out; pickVariant(0); loadVariantThumbs(out); scoreCycleShare(out);
  } catch (e) { toast(e.message, true); }
  finally { busy(false); }
}
function renderVariants() {
  const box = $('variants'); box.innerHTML = '';
  const vh = $('variantsHint'), n = state.variants.length;
  vh.hidden = n < 2;
  vh.textContent = `Našiel som ${n} ${n > 4 ? 'variantov' : 'varianty'}. Vyber si kliknutím sem alebo na šedú čiaru v mape.`;
  const lim = { km: +$('maxKm').value, up: +$('maxUp').value, g: +$('maxGrade').value };
  state.variants.forEach((v, i) => {
    const b = document.createElement('button'); b.className = 'variant'; b.setAttribute('aria-pressed', i === state.variantIdx);
    const km = v.route.length / 1000, over = km > lim.km || v.a.up > lim.up || v.a.maxGrade > lim.g;
    const [lv, lvName] = levelOf(km, v.a.up, v.a.maxGrade);
    b.innerHTML = `<span class="vmain"><span class="vtitle"><b>${esc(v.label || 'Variant ' + (i + 1))}</b><span class="lvl lvl-${lv}" title="Obtiažnosť trasy">${lvName}</span></span>
        <small>${fmtKm(v.route.length)} km · ↑ ${Math.round(v.a.up)} m · ${fmtTime(ebikeTime(v.route, v.a, v.rt))} · batéria v cieli ${v.a.at0 != null ? '0' : Math.round(v.a.endSoc)} %${v.cycle != null ? ` · <span class="vcyc">${v.cycle} % po cyklotrasách</span>` : ''}</small>
        <span class="chips">${(v.tags || []).map((t) => `<span class="chip ok">${esc(t)}</span>`).join('')}${v.a.at0 != null ? '<span class="chip bad">nevyjde na batériu</span>' : over ? '<span class="chip warn">nad tvoj limit</span>' : ''}</span></span>
      ${v.thumbs?.length ? `<span class="vthumbs">${v.thumbs.map((t) => `<img loading="lazy" src="${esc(t.thumb)}" alt="">`).join('')}</span>` : ''}`;
    b.addEventListener('click', () => pickVariant(i)); box.appendChild(b);
  });
  const sel = box.children[state.variantIdx];
  if (sel && box.scrollWidth > box.clientWidth) box.scrollTo({ left: sel.offsetLeft - box.offsetLeft - 4, behavior: 'smooth' });
  const ex = $('variantsExtra'); ex.innerHTML = '';
  if (state.variants.length && state.mode === 'loop') {
    const e = document.createElement('button'); e.textContent = 'Upraviť tento okruh bodmi';
    e.addEventListener('click', () => {
      const v = state.variants[state.variantIdx]; if (!v) return;
      state.points = v.pts.map((p) => ({ ...p, via: false })); setMode('ab');
    });
    ex.appendChild(e);
  }
}
function pickVariant(i) {
  state.variantIdx = i; const v = state.variants[i];
  state.route = v.route; state.prof = v.prof; renderVariants(); layers.pois.clearLayers(); layers.photos.clearLayers();
  $('poiList').innerHTML = ''; renderAll(true); findPhotos(true);
}

function setMode(m) {
  state.mode = m;
  $('modeAB').setAttribute('aria-pressed', m === 'ab'); $('modeLoop').setAttribute('aria-pressed', m === 'loop');
  $('loopBox').hidden = m !== 'loop';
  if (m === 'loop') { state.loopStart = state.loopStart || state.points[0] || null; state.variants = []; renderVariants(); clearRoute(); }
  renderPoints(); renderMarkers(); if (m === 'ab') recalc();
}
$('modeAB').addEventListener('click', () => setMode('ab'));
$('modeLoop').addEventListener('click', () => setMode('loop'));
$('btnLoop').addEventListener('click', makeLoops);

/* ---------- Nastavenia formulára ---------- */
document.querySelectorAll('[data-lvl]').forEach((b) => b.addEventListener('click', () => {
  const l = LEVELS[b.dataset.lvl];
  document.querySelectorAll('[data-lvl]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  $('maxKm').value = l.maxKm; $('maxUp').value = l.maxUp; $('maxGrade').value = l.maxGrade;
  if (state.mode === 'loop') $('loopKm').value = Math.round(l.maxKm * 0.8 / 5) * 5;
  saveForm(); if (state.route) { renderStats(); renderVariants(); }
}));
['maxKm', 'maxUp', 'maxGrade'].forEach((id) => $(id).addEventListener('change', () => { saveForm(); if (state.route) renderStats(); }));
['wh', 'soc', 'mass', 'assist', 'chargeMin'].forEach((id) => $(id).addEventListener('change', () => { if (id !== 'soc' && id !== 'chargeMin') Bikes.edit(); bikeChanged(); }));
// po zmene bicykla prepočítať batériu aj pri ostatných variantoch
function reanalyseVariants() {
  state.variants.forEach((v) => { if (v.prof) v.a = analyse(v.route, v.prof, v.rt, v.pts); });
  if (state.variants.length) renderVariants();
}
$('bikeType').addEventListener('change', () => {
  const b = BIKES[$('bikeType').value]; $('wh').value = b.wh; $('mass').value = b.mass; $('routeType').value = b.routeType;
  Bikes.edit(); saveForm(); if (state.imported) renderAll(false); else if (state.mode === 'ab') recalc(); else { state.variants = []; renderVariants(); clearRoute(); } updateRangeHint();
});
$('routeType').addEventListener('change', () => { saveForm(); if (state.imported) renderAll(false); else if (state.mode === 'ab') recalc(); else { state.variants = []; renderVariants(); clearRoute(); } });
$('useWeather').addEventListener('change', () => { saveForm(); if (Weather.enabled() && state.route) updateWeather(); reanalyseVariants(); if (state.route) renderAll(false, true); });
$('rideStart').addEventListener('change', () => { reanalyseVariants(); if (state.route) renderAll(false, true); });
const FORM = ['bikeType', 'wh', 'soc', 'mass', 'assist', 'routeType', 'maxKm', 'maxUp', 'maxGrade', 'loopKm', 'loopBy', 'loopHours', 'chargeMin'];
const CHECKS = ['useWeather', 'incCafe', 'incWater', 'incService', 'incView', 'incShop'];
function saveForm() { store.set('form', { ...Object.fromEntries(FORM.map((k) => [k, $(k).value])), ...Object.fromEntries(CHECKS.map((k) => [k, $(k).checked])) }); }
function loadForm() { const f = store.get('form', {}); FORM.forEach((k) => { if (f[k] != null) $(k).value = f[k]; }); CHECKS.forEach((k) => { if (f[k] != null) $(k).checked = !!f[k]; }); }
CHECKS.forEach((k) => $(k).addEventListener('change', saveForm));

/* ---------- Moje bicykle (v prehliadači a po prihlásení aj v účte) ---------- */
const BIKE_NAMES = { city: 'Mestský', trek: 'Trekingový', hardtail: 'Horský hardtail', full: 'Horský celoodpružený', gravel: 'Cestný / gravel', cargo: 'Nákladný' };
const Bikes = {
  list: [], id: null,
  load() {
    this.list = store.get('bikes', []);
    if (!this.list.length) this.list = [this.fromForm({ id: 'b' + Date.now(), name: 'Môj e-bike', calib: 1, rides: 0 })];
    this.id = store.get('bikeId', this.list[0].id);
    if (!this.current()) this.id = this.list[0].id;
    this.toForm(); this.render();
  },
  current() { return this.list.find((b) => b.id === this.id); },
  fromForm(b) { return { ...b, name: ($('bikeName').value || b.name || 'Môj e-bike').trim(), type: $('bikeType').value, wh: +$('wh').value || 500, mass: +$('mass').value || 100, assist: $('assist').value }; },
  toForm() {
    const b = this.current(); if (!b) return;
    $('bikeName').value = b.name; $('bikeType').value = b.type; $('wh').value = b.wh; $('mass').value = b.mass; $('assist').value = b.assist;
  },
  render() {
    $('bikeSel').innerHTML = this.list.map((b) => `<option value="${esc(b.id)}">${esc(b.name)} · ${esc(BIKE_NAMES[b.type] || '')}, ${b.wh} Wh</option>`).join('');
    $('bikeSel').value = this.id; $('btnBikeDel').disabled = this.list.length < 2;
    const b = this.current();
    $('calibHint').textContent = b?.rides ? `Odhad batérie je prispôsobený podľa ${b.rides} ${b.rides === 1 ? 'jazdy' : b.rides < 5 ? 'jázd' : 'jázd'} (spotreba ×${b.calib.toFixed(2)}).` : '';
    $('calibHint').hidden = !b?.rides;
  },
  persist(sync = true) {
    store.set('bikes', this.list); store.set('bikeId', this.id); this.render();
    if (sync && Account.user) { clearTimeout(this.t); this.t = setTimeout(() => Account.saveSettings().catch((e) => toast(e.message, true)), 800); }
  },
  edit() { const i = this.list.findIndex((b) => b.id === this.id); if (i >= 0) { this.list[i] = this.fromForm(this.list[i]); this.persist(); } },
  add() {
    const b = this.fromForm({ id: 'b' + Date.now(), name: `Bicykel ${this.list.length + 1}`, calib: 1, rides: 0 });
    b.name = `Bicykel ${this.list.length + 1}`; this.list.push(b); this.id = b.id; this.toForm(); this.persist();
    $('bikeName').focus(); $('bikeName').select();
  },
  remove() {
    if (this.list.length < 2) return;
    this.list = this.list.filter((b) => b.id !== this.id); this.id = this.list[0].id; this.toForm(); this.persist(); bikeChanged();
  },
  pick(id) {
    this.id = id; this.toForm(); this.persist(false); store.set('bikeId', id);
    const rt = BIKES[this.current()?.type]?.routeType;
    if (rt && rt !== $('routeType').value) { $('routeType').value = rt; saveForm(); if (state.mode === 'ab' && !state.imported) { recalc(); return; } }
    bikeChanged();
  },
  // po prihlásení: bicykle z účtu majú prednosť, tie len v prehliadači sa pridajú
  merge(remote) {
    if (!Array.isArray(remote) || !remote.length) return;
    const ids = new Set(remote.map((b) => b.id));
    const localOnly = this.list.filter((b) => !ids.has(b.id) && !(b.name === 'Môj e-bike' && !b.rides && this.list.length === 1));
    this.list = [...remote, ...localOnly];
    if (!this.current()) this.id = this.list[0].id;
    this.toForm(); this.persist(false); bikeChanged();
  },
};
function bikeChanged() { saveForm(); reanalyseVariants(); if (state.route) renderAll(false); else updateRangeHint(); }
$('bikeSel').addEventListener('change', (e) => Bikes.pick(e.target.value));
$('btnBikeNew').addEventListener('click', () => Bikes.add());
$('btnBikeDel').addEventListener('click', () => {
  const b = $('btnBikeDel');
  if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Naozaj?'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Zmazať'; }, 3000); return; }
  b.dataset.sure = ''; b.textContent = 'Zmazať'; Bikes.remove();
});
$('bikeName').addEventListener('change', () => Bikes.edit());

// učenie z jázd: po jazde zadáš, koľko batérie ostalo, a appka upraví odhad pre tento bicykel
$('btnCalib').addEventListener('click', () => {
  const a = state.analysis, b = Bikes.current(), end = +$('calEnd').value, start = +$('soc').value || 100;
  const out = $('calMsg'); out.hidden = false; out.className = 'msg';
  if (!a || !b) return;
  if (!$('calEnd').value || end < 0 || end >= start) { out.textContent = `Zadaj, koľko percent batérie ti ostalo na konci (menej ako ${start} %).`; out.className = 'msg err'; return; }
  if (currentPoints().some((p) => p.charge)) { out.textContent = 'Trasa má zastávku na nabíjanie, z takej jazdy sa odhad upraviť nedá. Použi jazdu bez nabíjania.'; out.className = 'msg err'; return; }
  const usedReal = ((start - end) / 100) * b.wh * Energy.usableShare, usedModel = a.used / (b.calib || 1);
  if (usedModel < 20) { out.textContent = 'Trasa je na úpravu odhadu príliš krátka.'; out.className = 'msg err'; return; }
  const ratio = Math.min(2, Math.max(0.5, usedReal / usedModel)), n = Math.min(5, b.rides || 0);
  b.calib = Math.min(2, Math.max(0.5, ((b.calib || 1) * n + ratio) / (n + 1))); b.rides = (b.rides || 0) + 1;
  Bikes.persist(); bikeChanged();
  out.textContent = `Ďakujem. Na tejto jazde si minula ${ratio > 1.05 ? 'viac' : ratio < 0.95 ? 'menej' : 'približne toľko'}, ako appka odhadla. Odhad pre bicykel ${b.name} je teraz ×${b.calib.toFixed(2)}.`;
  $('calEnd').value = '';
});

/* ---------- Nabíjanie a miesta pri trase ---------- */
const PLACE_KINDS = {
  cafe: 'Kaviareň', restaurant: 'Reštaurácia', pub: 'Krčma', guest_house: 'Penzión', hotel: 'Hotel', alpine_hut: 'Chata',
  drinking_water: 'Pitná voda', bicycle_repair_station: 'Cyklo stojan s náradím', bicycle: 'Cykloservis', viewpoint: 'Vyhliadka',
  supermarket: 'Obchod', convenience: 'Potraviny',
};
async function fetchPlaces(r, opt) {
  const b = L.latLngBounds(r.coords).pad(0.05);
  const bb = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
  let q = `[out:json][timeout:25];(node["amenity"="charging_station"]["bicycle"="yes"](${bb});node["amenity"="charging_station"]["bicycle:charging"](${bb});node["amenity"="bicycle_charging"](${bb});node["amenity"="bicycle_repair_station"]["charging"="yes"](${bb});`;
  if (opt.cafe) q += `node["amenity"~"^(cafe|restaurant|pub)$"]["name"](${bb});node["tourism"~"^(guest_house|hotel|alpine_hut)$"]["name"](${bb});`;
  if (opt.water) q += `node["amenity"="drinking_water"](${bb});`;
  if (opt.service) q += `nwr["shop"="bicycle"](${bb});node["amenity"="bicycle_repair_station"](${bb});`;
  if (opt.view) q += `node["tourism"="viewpoint"](${bb});`;
  if (opt.shop) q += `nwr["shop"~"^(supermarket|convenience)$"](${bb});`;
  q += ');out center body 600;';
  const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: new URLSearchParams({ data: q }) });
  if (!res.ok) throw new Error('OpenStreetMap (Overpass) teraz neodpovedá. Skús to o chvíľu.');
  const j = await res.json();
  const sample = resample(r, Math.min(1500, Math.max(50, Math.round(r.length / 100))));
  const seen = new Set();
  return j.elements.map((el) => {
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon, t = el.tags || {};
    if (lat == null) return null;
    let best = Infinity, at = 0;
    for (const s of sample) { const d = haversine([lat, lon], [s.lat, s.lon]); if (d < best) { best = d; at = s.d; } }
    const charger = t.amenity === 'charging_station' || t.amenity === 'bicycle_charging' || t.charging === 'yes';
    const maybe = !charger && /^(cafe|restaurant|pub|guest_house|hotel|alpine_hut)$/.test(t.amenity || t.tourism || '');
    const kindKey = charger ? 'charger' : t.amenity === 'drinking_water' ? 'drinking_water' : t.shop === 'bicycle' ? 'bicycle' : t.amenity || t.tourism || t.shop;
    const limit = charger || maybe ? 2000 : kindKey === 'viewpoint' ? 500 : 300; // voda a servis musia byť pri trase
    if (best > limit || seen.has(el.type + el.id)) return null;
    seen.add(el.type + el.id);
    return { el: { ...el, lat, lon, tags: t }, dist: best, at, charger, maybe, kindKey };
  }).filter(Boolean).sort((x, y) => (y.charger - x.charger) || x.at - y.at).slice(0, 80);
}
function placeOpts() { return { cafe: $('incCafe').checked, water: $('incWater').checked, service: $('incService').checked, view: $('incView').checked, shop: $('incShop').checked }; }
function placeInfo(x) {
  const t = x.el.tags, name = t.name || (x.charger ? 'Nabíjačka pre bicykle' : PLACE_KINDS[x.kindKey] || 'Bez názvu');
  const kind = x.charger ? 'Nabíjačka' : (PLACE_KINDS[x.kindKey] || 'Miesto') + (x.maybe ? ' · nabitie možno' : '');
  return { name, info: `${kind} · ${fmtKm(x.at)}. km trasy · ${Math.round(x.dist)} m od trasy${t.opening_hours ? ' · ' + t.opening_hours : ''}` };
}
async function findCharging() {
  const r = state.route; if (!r) return;
  busy(true, 'Hľadám miesta pri trase…');
  try {
    const items = await fetchPlaces(r, placeOpts());
    layers.pois.clearLayers();
    const list = $('poiList'); list.innerHTML = '';
    if (!items.length) list.innerHTML = '<p class="hint">Pri trase sa nenašli žiadne miesta. Skús zapnúť kaviarne a penzióny.</p>';
    items.forEach((x) => {
      const { name, info } = placeInfo(x);
      const cls = x.charger || x.maybe ? 'poi' : 'poi place';
      L.marker([x.el.lat, x.el.lon], { icon: pinIcon(cls), title: name }).bindPopup(`<b>${esc(name)}</b><br>${esc(info)}`).addTo(layers.pois);
      const row = document.createElement('div'); row.className = 'poi';
      row.innerHTML = `<div>${esc(name)}<small>${esc(info)}</small></div><button>${x.charger || x.maybe ? 'Pridať zastávku' : 'Pridať do trasy'}</button>`;
      row.querySelector('button').addEventListener('click', () => addChargeStop(x, name, x.charger || x.maybe));
      row.firstElementChild.addEventListener('click', () => map.setView([x.el.lat, x.el.lon], 15));
      list.appendChild(row);
    });
    toast(`Nájdených miest: ${items.length}.`);
  } catch (e) { toast(e.message || 'Hľadanie miest zlyhalo.', true); }
  finally { busy(false); }
}
// keď trasa nevyjde na batériu, appka sama nájde nabíjačku pred miestom, kde batéria dôjde
async function autoCharge() {
  const r = state.route, a = state.analysis; if (!r || a?.at0 == null) return;
  busy(true, 'Hľadám najvhodnejšiu nabíjačku…');
  try {
    const items = await fetchPlaces(r, { ...placeOpts(), cafe: true });
    const limit = a.at0 - 2000, already = currentPoints().filter((p) => p.charge);
    const ok = items.filter((x) => (x.charger || x.maybe) && x.at < limit && x.at > r.length * 0.15 && !already.some((p) => haversine([p.lat, p.lon], [x.el.lat, x.el.lon]) < 50));
    // najlepšia je skutočná nabíjačka čo najneskôr pred vybitím, blízko trasy
    ok.sort((x, y) => (y.charger - x.charger) || (y.at - y.dist * 3) - (x.at - x.dist * 3));
    const x = ok[0];
    if (!x) { toast('Pred miestom, kde dôjde batéria, som nenašiel nabíjanie. Skús nižší režim podpory alebo kratší variant.', true); return; }
    addChargeStop(x, placeInfo(x).name, true);
    toast(`Pridal som zastávku: ${placeInfo(x).name} (${fmtKm(x.at)}. km). ${x.charger ? '' : 'Nabitie si tam vopred dohodni.'}`);
  } catch (e) { toast(e.message, true); }
  finally { busy(false); }
}
function addChargeStop(x, name, charge = true) {
  if (state.imported) { toast('Do nahratej trasy sa zastávka pridať nedá. Naplánuj trasu cez body.', true); return; }
  const v = state.variants[state.variantIdx];
  if (v) state.points = v.pts.map((p) => ({ ...p, via: false }));
  if (state.mode === 'loop') setMode('ab');
  if (state.points.length >= 17) { toast('Trasa už má maximum bodov.', true); return; }
  // vložiť medzi body podľa vzdialenosti na trase
  let acc = 0, idx = state.points.length - 1;
  for (let i = 0; i < state.route.parts.length; i++) { acc += state.route.parts[i].length; if (x.at <= acc) { idx = i + 1; break; } }
  state.points.splice(idx, 0, { lat: x.el.lat, lon: x.el.lon, label: (charge ? '⚡ ' : '') + name, charge });
  renderPoints(); recalc(); if (charge) toast('Zastávka na nabíjanie pridaná, dojazd sa prepočítal.');
}
$('btnCharge').addEventListener('click', findCharging);

/* ---------- Fotky ---------- */
async function commonsNear(s, radius = 800, limit = 6) {
  const q = new URLSearchParams({ action: 'query', format: 'json', origin: '*', generator: 'geosearch', ggscoord: `${s.lat}|${s.lon}`, ggsradius: String(radius), ggslimit: String(limit), ggsnamespace: '6', prop: 'imageinfo|coordinates', iiprop: 'url|extmetadata', iiurlwidth: '360' });
  const j = await (await fetch('https://commons.wikimedia.org/w/api.php?' + q)).json();
  const out = [];
  for (const pg of Object.values(j.query?.pages || {})) {
    const ii = pg.imageinfo?.[0]; if (!ii || !/\.(jpe?g|png|webp)$/i.test(pg.title)) continue;
    const md = ii.extmetadata || {};
    const author = (md.Artist?.value || '').replace(/<[^>]+>/g, '').trim() || 'neznámy autor';
    out.push({ id: pg.pageid, thumb: ii.thumburl, href: ii.descriptionurl, lat: pg.coordinates?.[0]?.lat, lon: pg.coordinates?.[0]?.lon, credit: `${author} · ${md.LicenseShortName?.value || 'Wikimedia'}`, d: s.d });
  }
  return out;
}
let photoToken = 0;
async function findPhotos(quiet = false) {
  const r = state.route; if (!r) return;
  const my = ++photoToken;
  const n = Math.min(10, Math.max(3, Math.round(r.length / 5000)));
  const spots = resample(r, n);
  if (!quiet) busy(true, 'Hľadám fotky…');
  $('gallery').innerHTML = '<p class="hint" style="grid-column:1/-1">Hľadám fotky pri trase…</p>';
  const seen = new Set(), photos = [];
  try {
    await Promise.all(spots.map(async (s) => {
      try { for (const p of await commonsNear(s)) if (!seen.has(p.id)) { seen.add(p.id); photos.push(p); } } catch {}
    }));
    const tok = store.get('mly', '');
    if (tok) await Promise.all(spots.map(async (s) => {
      const bb = [s.lon - 0.003, s.lat - 0.002, s.lon + 0.003, s.lat + 0.002].join(',');
      try {
        const j = await (await fetch(`https://graph.mapillary.com/images?access_token=${encodeURIComponent(tok)}&fields=id,thumb_256_url,geometry,creator&bbox=${bb}&limit=3`)).json();
        for (const im of j.data || []) {
          if (seen.has(im.id)) continue; seen.add(im.id);
          photos.push({ thumb: im.thumb_256_url, href: `https://www.mapillary.com/app/?pKey=${im.id}`, lat: im.geometry.coordinates[1], lon: im.geometry.coordinates[0], credit: `${im.creator?.username || 'Mapillary'} · CC BY-SA`, d: s.d });
        }
      } catch {}
    }));
    if (my !== photoToken || r !== state.route) return;
    photos.sort((a, b) => a.d - b.d);
    const g = $('gallery'); g.innerHTML = ''; layers.photos.clearLayers();
    if (!photos.length) g.innerHTML = '<p class="hint" style="grid-column:1/-1">Pri tejto trase sa fotky nenašli.</p>';
    photos.slice(0, 48).forEach((p) => {
      const a = document.createElement('a'); a.href = p.href; a.target = '_blank'; a.rel = 'noopener';
      a.innerHTML = `<img loading="lazy" src="${esc(p.thumb)}" alt=""><span>${esc(p.credit)}</span>`; g.appendChild(a);
      if (p.lat != null) L.marker([p.lat, p.lon], { icon: pinIcon('photo') }).bindPopup(`<a href="${esc(p.href)}" target="_blank" rel="noopener"><img src="${esc(p.thumb)}" style="width:200px;border-radius:6px"></a><br><small>${esc(p.credit)}</small>`).addTo(layers.photos);
    });
    if (!quiet) toast(`Nájdených fotiek: ${photos.length}.`);
  } finally { if (!quiet) busy(false); }
}
$('btnPhotos').addEventListener('click', () => findPhotos(false));

/* ---------- Podobné trasy na webe ---------- */
const placeCache = {};
async function placeName(p) {
  if (p.label && !p.label.startsWith('⚡') && p.label !== 'Moja poloha') return p.label;
  const k = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
  if (placeCache[k]) return placeCache[k];
  try {
    const j = await mapy('/rgeocode', { lon: p.lon, lat: p.lat, lang: 'sk' });
    const it = j.items?.[0]; const reg = it?.regionalStructure?.find((x) => x.type === 'regional.municipality');
    return (placeCache[k] = reg?.name || it?.location?.split(',')[0] || it?.name || '');
  } catch { return ''; }
}
let webToken = 0;
async function renderWebLinks() {
  const r = state.route, box = $('webBox'); if (!r) { box.hidden = true; return; }
  const my = ++webToken;
  const c0 = r.coords[0], c1 = r.coords[r.coords.length - 1];
  const [a, b] = await Promise.all([placeName({ lat: c0[0], lon: c0[1], label: currentPoints()[0]?.label }), placeName({ lat: c1[0], lon: c1[1], label: currentPoints().at(-1)?.label })]);
  if (my !== webToken) return;
  const place = a || 'Slovensko', ab = b && b !== a ? `${a} ${b}` : place;
  const g = (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q);
  const links = [
    ['Komoot', 'trasy a fotky od jazdcov', g(`site:komoot.com e-bike ${ab}`)],
    ['Facebook skupiny', 'komunity e-bikerov v okolí', 'https://www.facebook.com/search/groups/?q=' + encodeURIComponent(`ebike ${place}`)],
    ['Strava', 'verejné trasy', g(`site:strava.com/routes ${ab}`)],
  ];
  $('webLinks').innerHTML = links.map(([n, d, u]) => `<a class="weblink" href="${esc(u)}" target="_blank" rel="noopener"><b>${esc(n)}</b><small>${esc(d)}</small></a>`).join('');
  $('webPlace').textContent = ab;
  box.hidden = false;
}

/* ---------- Nahratie GPX (napr. z Komootu) ---------- */
$('gpxFile').addEventListener('change', async (ev) => {
  const f = ev.target.files?.[0]; ev.target.value = ''; if (!f) return;
  try { await importGpx(await f.text(), f.name.replace(/\.gpx$/i, '')); }
  catch (e) { toast(e.message || 'Súbor sa nepodarilo načítať.', true); }
});
async function importGpx(text, fallbackName, quiet = false) {
  {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    let nodes = [...doc.getElementsByTagName('trkpt')]; if (!nodes.length) nodes = [...doc.getElementsByTagName('rtept')];
    if (nodes.length < 2) throw new Error('V súbore som nenašiel trasu. Nahraj GPX s trasou (track).');
    const coords = [], ele = [];
    nodes.forEach((n) => { const la = +n.getAttribute('lat'), lo = +n.getAttribute('lon'); if (isFinite(la) && isFinite(lo)) { coords.push([la, lo]); const e = n.getElementsByTagName('ele')[0]; ele.push(e ? +e.textContent : NaN); } });
    const cum = [0]; for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
    const length = cum[cum.length - 1];
    const route = { coords, cum, length, duration: Math.round(length / (18 / 3.6)), parts: [] };
    let prof;
    if (ele.filter((x) => isFinite(x)).length > ele.length * 0.8) {
      const step = Math.max(1, Math.floor(coords.length / 800)), d = [], e = [];
      for (let i = 0; i < coords.length; i += step) if (isFinite(ele[i])) { d.push(cum[i]); e.push(ele[i]); }
      if (d[d.length - 1] !== length && isFinite(ele[ele.length - 1])) { d.push(length); e.push(ele[ele.length - 1]); }
      prof = { d, e };
    } else { busy(true, 'Načítavam výšky…'); try { prof = await fetchProfile(route); } finally { busy(false); } }
    const name = doc.getElementsByTagName('name')[0]?.textContent?.trim() || fallbackName || 'Nahraná trasa';
    if (state.mode !== 'ab') { state.mode = 'ab'; $('modeAB').setAttribute('aria-pressed', true); $('modeLoop').setAttribute('aria-pressed', false); $('loopBox').hidden = true; }
    calcToken++; state.points = []; state.pendingSlot = null; state.variants = []; state.variantIdx = -1; renderVariants();
    state.route = route; state.prof = prof; state.imported = { name };
    renderPoints(); layers.pois.clearLayers(); $('poiList').innerHTML = '';
    renderAll(true); findPhotos(true);
    if (!quiet) toast(`Nahraná trasa „${name}“: ${fmtKm(length)} km. Batéria, nabíjanie aj fotky sa rátajú pre ňu.`);
  }
}

/* ---------- Export ---------- */
function routeName() {
  if (state.imported) return state.imported.name;
  const pts = currentPoints(); const a = pts[0]?.label, b = pts[pts.length - 1]?.label;
  const base = state.mode === 'loop' ? `Okruh ${fmtKm(state.route.length)} km${a ? ' – ' + a : ''}` : `${a || 'Štart'} – ${b || 'Cieľ'}`;
  return base.replace(/⚡\s?/g, '');
}
function buildGpx() {
  const r = state.route, p = state.prof, name = routeName();
  let k = 0;
  const ele = (d) => { while (k < p.d.length - 2 && p.d[k + 1] < d) k++; const f = (d - p.d[k]) / ((p.d[k + 1] - p.d[k]) || 1); return p.e[k] + (p.e[k + 1] - p.e[k]) * Math.min(1, Math.max(0, f)); };
  const wpts = currentPoints().filter((x) => x.charge).map((x) => `<wpt lat="${x.lat.toFixed(6)}" lon="${x.lon.toFixed(6)}"><name>${esc(x.label.replace('⚡ ', 'Nabíjanie: '))}</name><sym>Restroom</sym></wpt>`).join('\n');
  const trk = r.coords.map((c, i) => `<trkpt lat="${c[0].toFixed(6)}" lon="${c[1].toFixed(6)}"><ele>${ele(r.cum[i]).toFixed(1)}</ele></trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Ebike Trasy (Mapy.com)" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${esc(name)}</name><copyright author="Seznam.cz a.s. a OpenStreetMap"/></metadata>
${wpts}
<trk><name>${esc(name)}</name><type>cycling</type><trkseg>
${trk}
</trkseg></trk>
</gpx>`;
}
function gpxFile() {
  const fn = routeName().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'trasa';
  return new File([buildGpx()], fn + '.gpx', { type: 'application/gpx+xml' });
}
$('btnGpx').addEventListener('click', () => {
  const f = gpxFile(), url = URL.createObjectURL(f), a = document.createElement('a');
  a.href = url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});
$('btnShare').addEventListener('click', async () => {
  const f = gpxFile();
  if (navigator.canShare?.({ files: [f] })) {
    try { await navigator.share({ files: [f], title: routeName() }); } catch (e) { if (e.name !== 'AbortError') toast('Zdieľanie zlyhalo, použi Stiahnuť GPX.', true); }
  } else { toast('Tento prehliadač nevie posielať súbory do appiek. Použi Stiahnuť GPX.', true); }
});

function encodeState() {
  const pts = currentPoints().map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}${p.charge ? ',c' : ''}`).join(';');
  return `#r=${$('routeType').value === 'bike_mountain' ? 'm' : 'r'}|${pts}`;
}
function decodeState(h) {
  const m = /^#r=([rm])\|(.+)$/.exec(h || ''); if (!m) return false;
  $('routeType').value = m[1] === 'm' ? 'bike_mountain' : 'bike_road';
  state.points = m[2].split(';').map((s) => { const [lat, lon, c] = s.split(','); return { lat: +lat, lon: +lon, label: null, charge: c === 'c' }; }).filter((p) => isFinite(p.lat) && isFinite(p.lon));
  return state.points.length >= 2;
}
$('btnLink').addEventListener('click', async () => {
  if (state.imported) { toast('Pre nahratú trasu odkaz nejde vytvoriť. Pošli radšej GPX súbor.', true); return; }
  const url = location.href.split('#')[0] + encodeState();
  try { await navigator.clipboard.writeText(url); toast('Odkaz na trasu je skopírovaný.'); }
  catch { toast(url); }
});

/* ---------- QR kód: trasa z počítača do mobilu ---------- */
function loadScript(src) {
  return new Promise((ok, fail) => { const sc = document.createElement('script'); sc.src = src; sc.onload = ok; sc.onerror = () => fail(new Error('Knižnica na QR kód sa nenačítala. Skontroluj internet.')); document.head.appendChild(sc); });
}
async function showQr(which) {
  const box = $('qrBox'), hosted = /^https?:/.test(location.protocol);
  const appUrl = hosted && !state.imported ? location.href.split('#')[0] + encodeState() : null;
  if (!which) which = appUrl ? 'app' : 'mapy';
  $('qrApp').hidden = !appUrl; $('qrApp').parentElement.hidden = !appUrl;
  $('qrMapy').setAttribute('aria-pressed', which === 'mapy'); $('qrApp').setAttribute('aria-pressed', which === 'app');
  const url = which === 'app' ? appUrl : $('btnMapy').href;
  $('qrHint').textContent = which === 'app'
    ? 'Naskenuj fotoaparátom v mobile. Trasa sa otvorí v appke Ebike Trasy aj s variantmi a batériou.'
    : 'Naskenuj fotoaparátom v mobile. Trasa sa otvorí v appke Mapy.com, kde môžeš hneď spustiť navigáciu.' + (state.imported ? ' Nahratá GPX trasa sa v Mapy.com otvorí len podľa štartu a cieľa, presnú trasu pošli ako GPX.' : '');
  if (!$('dlgQr').open) $('dlgQr').showModal();
  box.innerHTML = '<p class="hint">Pripravujem QR kód…</p>';
  try {
    if (!window.qrcode) await loadScript('https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js');
    const qr = window.qrcode(0, 'M'); qr.addData(url); qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
  } catch (e) { box.innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
}
$('btnQr').addEventListener('click', () => showQr());
$('qrMapy').addEventListener('click', () => showQr('mapy'));
$('qrApp').addEventListener('click', () => showQr('app'));

/* ---------- Uložené trasy ---------- */
function savedRecord() {
  return { name: routeName(), km: +fmtKm(state.route.length), up: Math.round(state.analysis.up), hash: state.imported ? null : encodeState(), gpx: state.imported ? buildGpx() : null };
}
$('btnSave').addEventListener('click', async () => {
  const rec = savedRecord();
  if (Account.user) {
    try { await Account.save(rec); toast('Trasa uložená do tvojho účtu.'); }
    catch (e) { toast(e.message, true); }
    return;
  }
  if (rec.gpx) { toast('Nahraté trasy sa ukladajú len do účtu. Prihlás sa cez Účet.', true); return; }
  const list = store.get('saved', []);
  list.unshift({ ...rec, at: Date.now() });
  store.set('saved', list.slice(0, 50)); toast('Trasa uložená v tomto prehliadači. Prihlás sa, aby sa ukladala do účtu.');
});
async function openSaved(s) {
  $('dlgSaved').close();
  if (s.gpx) { try { await importGpx(s.gpx, s.name, true); } catch (e) { toast(e.message, true); } return; }
  if (decodeState(s.hash)) { setMode('ab'); state.points.forEach(nameLater); }
}
let savedCache = { list: [], remote: false };
$('btnSaved').addEventListener('click', async () => {
  const box = $('savedList'); box.innerHTML = '<p class="hint">Načítavam…</p>';
  $('savedWhere').textContent = Account.user ? `Trasy v účte ${Account.user.email}` : 'Trasy v tomto prehliadači. Po prihlásení sa presunú do účtu.';
  $('dlgSaved').showModal();
  const remote = !!Account.user;
  try { savedCache = { list: remote ? await Account.list() : store.get('saved', []), remote }; }
  catch (e) { box.innerHTML = `<p class="msg err">${esc(e.message)}</p>`; return; }
  renderSavedList();
});
$('savedSearch').addEventListener('input', () => renderSavedList());
document.querySelectorAll('[data-sfilter]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-sfilter]').forEach((x) => x.setAttribute('aria-pressed', x === b)); renderSavedList();
}));
const STATUS = { want: 'Chcem ísť', done: 'Jazdené' };
async function updateSaved(s, patch) {
  Object.assign(s, patch);
  if (savedCache.remote) await Account.update(s.id, patch);
  else { const l = store.get('saved', []), i = l.findIndex((x) => x.at === s.at); if (i >= 0) { l[i] = { ...l[i], ...patch }; store.set('saved', l); } }
}
function renderSavedList() {
  const box = $('savedList'), { list, remote } = savedCache;
  const q = $('savedSearch').value.trim().toLowerCase();
  const f = document.querySelector('[data-sfilter][aria-pressed="true"]')?.dataset.sfilter || 'all';
  const shown = list.filter((s) => (f === 'all' || s.status === f) && (!q || `${s.name} ${s.note || ''}`.toLowerCase().includes(q)));
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<p class="hint">Zatiaľ nemáš uložené trasy. Naplánuj trasu a daj Uložiť trasu.</p>'; return; }
  if (!shown.length) { box.innerHTML = '<p class="hint">Žiadna trasa nezodpovedá hľadaniu.</p>'; return; }
  shown.forEach((s) => {
    const row = document.createElement('div'); row.className = 'saved';
    const when = new Date(s.created_at || s.at).toLocaleDateString('sk');
    row.innerHTML = `<div class="saved-top"><div>${esc(s.name)}<small>${s.km} km · ↑ ${s.up} m · ${when}${s.gpx ? ' · nahratá GPX' : ''}</small></div>
      <div class="saved-act"><button type="button" class="sm" data-open>Otvoriť</button><button type="button" class="ghost" data-del title="Zmazať">✕</button></div></div>
      <div class="saved-meta"><span class="stars" role="group" aria-label="Hodnotenie">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" aria-pressed="${(s.rating || 0) >= n}" aria-label="${n} z 5">★</button>`).join('')}</span>
      <select data-status aria-label="Stav"><option value="">Bez stavu</option><option value="want">Chcem ísť</option><option value="done">Jazdené</option></select>
      <button type="button" class="ghost sm" data-note>${s.note ? 'Poznámka ✎' : '+ Poznámka'}</button></div>
      ${s.note ? `<p class="saved-note">${esc(s.note)}</p>` : ''}
      <textarea data-notein rows="2" hidden placeholder="Napr. pekný výhľad, nabíjačka v kaviarni pri kostole…">${esc(s.note || '')}</textarea>`;
    row.querySelector('[data-status]').value = s.status || '';
    const fail = (e) => toast(e.message, true);
    row.querySelector('[data-open]').addEventListener('click', () => openSaved(s));
    row.querySelectorAll('[data-star]').forEach((b) => b.addEventListener('click', () => {
      const n = +b.dataset.star, val = s.rating === n ? 0 : n;
      updateSaved(s, { rating: val }).then(renderSavedList, fail);
    }));
    row.querySelector('[data-status]').addEventListener('change', (e) => updateSaved(s, { status: e.target.value || null }).then(renderSavedList, fail));
    const ta = row.querySelector('[data-notein]');
    row.querySelector('[data-note]').addEventListener('click', () => { ta.hidden = !ta.hidden; if (!ta.hidden) ta.focus(); });
    ta.addEventListener('change', () => updateSaved(s, { note: ta.value.trim() || null }).then(renderSavedList, fail));
    const del = row.querySelector('[data-del]');
    del.addEventListener('click', async () => {
      if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = 'Naozaj zmazať?'; return; }
      try {
        if (remote) await Account.remove(s.id); else { const l = store.get('saved', []); l.splice(l.findIndex((x) => x.at === s.at), 1); store.set('saved', l); }
        list.splice(list.indexOf(s), 1); renderSavedList();
      } catch (e) { toast(e.message, true); }
    });
    box.appendChild(row);
  });
}

/* ---------- Účty (Supabase) ---------- */
const SUPA_URL = 'https://zwapgiajvmqtrkrxqcqs.supabase.co';
const SUPA_KEY = 'sb_publishable_S-4hYnvv1KJqs98QUjp2Cg_APbanwPA';
const Account = {
  client: null, user: null,
  init() {
    if (!window.supabase?.createClient) { $('btnAccount').hidden = true; return; }
    this.client = window.supabase.createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    this.client.auth.onAuthStateChange((ev, session) => {
      const was = this.user; this.user = session?.user || null; this.render();
      if (this.user && !was) { this.migrateLocal(); this.loadSettings().catch((e) => toast(e.message, true)); }
    });
  },
  err(e) {
    const m = e?.message || String(e);
    const missingTable = e?.code === 'PGRST205' || e?.code === '42P01' || /relation .* does not exist|Could not find the table/i.test(m);
    if (missingTable && /user_settings/i.test(m)) return new Error('V Supabase chýba tabuľka na bicykle. Spusti v SQL Editore súbor supabase-update.sql.');
    if (missingTable) return new Error('V Supabase ešte chýba tabuľka na trasy. Spusti v Supabase SQL z návodu (súbor supabase-setup.sql).');
    if (e?.code === '42703' || e?.code === 'PGRST204' || /column .* does not exist|Could not find the '.*' column/i.test(m)) return new Error('V Supabase treba doplniť nové stĺpce. Spusti v Supabase SQL Editore súbor supabase-update.sql.');
    if (/Invalid login credentials/i.test(m)) return new Error('Nesprávny e-mail alebo heslo.');
    if (/Email not confirmed/i.test(m)) return new Error('E-mail ešte nie je potvrdený. Klikni na odkaz v e-maile od Supabase.');
    if (/already registered/i.test(m)) return new Error('Konto s týmto e-mailom už existuje. Prihlás sa.');
    if (/Password should be/i.test(m)) return new Error('Heslo musí mať aspoň 6 znakov.');
    if (/Failed to fetch|NetworkError/i.test(m)) return new Error('Nepodarilo sa spojiť so serverom účtov. Skontroluj internet.');
    return new Error(m);
  },
  async list() {
    const { data, error } = await this.client.from('routes').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) throw this.err(error); return data;
  },
  async save(rec) { const { error } = await this.client.from('routes').insert(rec); if (error) throw this.err(error); },
  async remove(id) { const { error } = await this.client.from('routes').delete().eq('id', id); if (error) throw this.err(error); },
  async loadSettings() {
    const { data, error } = await this.client.from('user_settings').select('bikes').limit(1);
    if (error) throw this.err(error);
    if (data?.[0]?.bikes?.length) Bikes.merge(data[0].bikes); else await this.saveSettings();
  },
  async saveSettings() {
    const { error } = await this.client.from('user_settings').upsert({ user_id: this.user.id, bikes: Bikes.list, updated_at: new Date().toISOString() });
    if (error) throw this.err(error);
  },
  async update(id, patch) { const { error } = await this.client.from('routes').update(patch).eq('id', id); if (error) throw this.err(error); },
  async migrateLocal() {
    const local = store.get('saved', []); if (!local.length) return;
    try {
      const { error } = await this.client.from('routes').insert(local.map(({ name, km, up, hash }) => ({ name, km: +km, up, hash })));
      if (error) throw this.err(error);
      store.set('saved', []); toast(`Presunul som ${local.length} uložených trás do tvojho účtu.`);
    } catch (e) { toast(e.message, true); }
  },
  render() {
    const lbl = $('btnAccount').querySelector('span') || $('btnAccount'); lbl.textContent = this.user ? 'Môj účet' : 'Prihlásiť';
    $('accOut').hidden = !!this.user; $('accIn').hidden = !this.user;
    if (this.user) $('accEmail').textContent = this.user.email;
  },
};
function accMsg(t, err = false) { const el = $('accMsg'); el.textContent = t; el.className = 'msg' + (err ? ' err' : ''); el.hidden = !t; }
$('btnAccount').addEventListener('click', () => { accMsg(''); Account.render(); $('dlgAccount').showModal(); });
$('formAccount').addEventListener('submit', (e) => e.preventDefault());
async function accAction(kind) {
  const email = $('accMailIn').value.trim(), password = $('accPass').value;
  if (!Account.client) { accMsg('Účty sa nenačítali. Skontroluj internet a obnov stránku.', true); return; }
  if (kind !== 'reset' && (!email || !password)) { accMsg('Zadaj e-mail aj heslo.', true); return; }
  if (kind === 'reset' && !email) { accMsg('Zadaj e-mail, pošlem naň odkaz na nové heslo.', true); return; }
  const redirect = /^https?:/.test(location.protocol) ? location.href.split('#')[0] : undefined;
  accMsg('Moment…');
  try {
    if (kind === 'in') {
      const { error } = await Account.client.auth.signInWithPassword({ email, password }); if (error) throw Account.err(error);
      accMsg(''); $('dlgAccount').close(); toast('Si prihlásená. Trasy sa ukladajú do účtu.');
    } else if (kind === 'up') {
      const { data, error } = await Account.client.auth.signUp({ email, password, options: { emailRedirectTo: redirect } }); if (error) throw Account.err(error);
      if (data.session) { accMsg(''); $('dlgAccount').close(); toast('Konto je vytvorené a si prihlásená.'); }
      else accMsg('Konto je vytvorené. Na e-mail ti prišiel odkaz na potvrdenie. Po potvrdení sa tu prihlás.');
    } else {
      const { error } = await Account.client.auth.resetPasswordForEmail(email, { redirectTo: redirect }); if (error) throw Account.err(error);
      accMsg('Poslal som e-mail s odkazom na zmenu hesla.');
    }
  } catch (e) { accMsg(e.message, true); }
}
$('btnSignIn').addEventListener('click', () => accAction('in'));
$('btnSignUp').addEventListener('click', () => accAction('up'));
$('btnReset').addEventListener('click', () => accAction('reset'));
$('btnSignOut').addEventListener('click', async () => { await Account.client.auth.signOut(); $('dlgAccount').close(); toast('Si odhlásená.'); });
$('btnNewPass').addEventListener('click', async () => {
  const pw = $('accNewPass').value; if (pw.length < 6) { accMsg('Heslo musí mať aspoň 6 znakov.', true); return; }
  const { error } = await Account.client.auth.updateUser({ password: pw });
  accMsg(error ? Account.err(error).message : 'Heslo je zmenené.', !!error);
});
Account.init();

/* ---------- Nastavenia ---------- */
function openSettings() { $('setKey').value = store.get('key', ''); $('setMly').value = store.get('mly', ''); if (!$('dlgSettings').open) $('dlgSettings').showModal(); }
$('btnSettings').addEventListener('click', openSettings);
$('btnTestKey').addEventListener('click', async () => {
  const k = $('setKey').value.trim(), out = $('keyTest');
  if (!k) { out.textContent = 'Najprv vlož kľúč.'; out.hidden = false; return; }
  if (/\.\.\.|…/.test(k)) { out.textContent = 'Kľúč končí bodkami, takže je skrátený. Na developer.mapy.com ho skopíruj zelenou ikonkou kopírovania vedľa kľúča, nie označením textu.'; out.hidden = false; return; }
  out.textContent = 'Overujem…'; out.hidden = false;
  try {
    const r = await fetch(`${API}/suggest?query=Praha&limit=1&apikey=${encodeURIComponent(k)}`);
    out.textContent = r.ok ? 'Kľúč funguje. Daj Uložiť.' : (await diagnoseKey(k));
  } catch { out.textContent = await diagnoseKey(k); }
});
$('btnKey').addEventListener('click', openSettings);
$('dlgSettings').addEventListener('close', () => {
  if ($('dlgSettings').returnValue !== 'ok') return;
  store.set('key', $('setKey').value.replace(/\s+/g, '')); store.set('mly', $('setMly').value.trim()); setTiles();
  if (state.mode === 'ab' && state.points.length > 1) recalc();
});

$('btnLocate').addEventListener('click', () => {
  if (!navigator.geolocation) { toast('Prehliadač nepozná polohu.', true); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => setPoint(0, { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Moja poloha' }),
    () => toast('Polohu sa nepodarilo zistiť. Povoľ ju v prehliadači.', true), { enableHighAccuracy: true, timeout: 10000 });
});
$('btnClear').addEventListener('click', () => { state.points = []; state.loopStart = null; state.variants = []; renderVariants(); clearRoute(); renderPoints(); });

/* ---------- Mobil: panel sa dá ťahať hore a dole (ako v Komoote) ---------- */
const Sheet = {
  mq: window.matchMedia('(max-width: 820px)'),
  snaps() { const h = window.innerHeight; return [150, Math.round(h * 0.52), Math.round(h * 0.8)]; },
  h: null,
  set(px, animate = true) {
    const app = document.querySelector('.app'), [lo, , hi] = this.snaps();
    this.h = Math.max(lo, Math.min(hi, px));
    app.classList.toggle('snapping', animate);
    app.style.setProperty('--sheet', this.h + 'px');
    const big = this.h > this.snaps()[1] + 20;
    $('sheetSumAct').textContent = this.h <= lo + 10 ? '▲ viac' : big ? '▼ menej' : '▲ viac';
    clearTimeout(this.t); this.t = setTimeout(() => { app.classList.remove('snapping'); map.invalidateSize(); }, animate ? 280 : 30);
  },
  snap(target) { const s = this.snaps(); this.set(s.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a))); },
  level(i) { if (this.mq.matches) this.set(this.snaps()[i]); },
  init() {
    const hd = document.querySelector('header.top');
    hd.addEventListener('pointerdown', (e) => {
      if (!this.mq.matches || e.target.closest('button,a,input,select')) return;
      const y0 = e.clientY, h0 = this.h ?? this.snaps()[1]; let moved = false;
      hd.setPointerCapture(e.pointerId);
      const mv = (ev) => { if (Math.abs(ev.clientY - y0) > 4) moved = true; this.set(h0 - (ev.clientY - y0), false); };
      const up = (ev) => {
        hd.removeEventListener('pointermove', mv); hd.removeEventListener('pointerup', up); hd.removeEventListener('pointercancel', up);
        if (!moved) { this.toggle(); return; }
        const v = ev.clientY - y0; // rýchle švihnutie posunie o úroveň
        this.snap(h0 - v * 1.6);
      };
      hd.addEventListener('pointermove', mv); hd.addEventListener('pointerup', up); hd.addEventListener('pointercancel', up);
    });
    $('sheetSum').addEventListener('click', () => this.toggle());
    window.addEventListener('resize', () => { if (this.mq.matches && this.h != null) this.snap(this.h); });
  },
  toggle() { const s = this.snaps(), h = this.h ?? s[1]; this.set(h < s[1] - 10 ? s[1] : h < s[2] - 10 ? s[2] : s[0]); if (this.h === s[0]) document.querySelector('.panel').scrollTo({ top: 0 }); },
};
Sheet.init();
function renderSheetSum() {
  const r = state.route, a = state.analysis;
  $('sheetSumTxt').textContent = r && a
    ? `${fmtKm(r.length)} km · ↑ ${Math.round(a.up)} m · ${fmtTime(ebikeTime(r, a, currentRouteType()))} · batéria ${a.at0 != null ? '0' : Math.round(a.endSoc)} %`
    : state.mode === 'loop' ? 'Vyber štart okruhu a dĺžku' : 'Vyber štart a cieľ alebo klikni do mapy';
}

/* ---------- Tipy pri bodoch ---------- */
$('btnPtsMore').addEventListener('click', () => {
  const m = $('ptsMore'); m.hidden = !m.hidden;
  $('btnPtsMore').textContent = m.hidden ? 'Viac tipov' : 'Menej'; $('btnPtsMore').setAttribute('aria-expanded', String(!m.hidden));
});

/* ---------- Úvodný sprievodca pri prvom otvorení ---------- */
const Welcome = {
  step: 0,
  open() {
    this.step = 0;
    document.querySelectorAll('#wBikes [data-wbike]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.wbike === $('bikeType').value));
    $('wWh').value = $('wh').value; $('wMass').value = $('mass').value;
    const lvl = document.querySelector('[data-lvl][aria-pressed="true"]')?.dataset.lvl || 'mid';
    document.querySelectorAll('#wLevels [data-wlvl]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.wlvl === lvl));
    this.show(); if (!$('dlgWelcome').open) $('dlgWelcome').showModal();
  },
  show() {
    document.querySelectorAll('#dlgWelcome .wstep').forEach((el, i) => (el.hidden = i !== this.step));
    document.querySelectorAll('#wDots i').forEach((el, i) => el.classList.toggle('on', i === this.step));
    $('wBack').hidden = this.step === 0; $('wNext').hidden = this.step === 2;
    $('wKeyNote').hidden = !!mapyKey();
  },
  apply() {
    const t = document.querySelector('#wBikes [aria-pressed="true"]')?.dataset.wbike;
    if (t && t !== $('bikeType').value) { $('bikeType').value = t; $('routeType').value = BIKES[t].routeType; }
    if (+$('wWh').value) $('wh').value = $('wWh').value;
    if (+$('wMass').value) $('mass').value = $('wMass').value;
    const l = document.querySelector('#wLevels [aria-pressed="true"]')?.dataset.wlvl;
    if (l) document.querySelector(`[data-lvl="${l}"]`)?.click();
    Bikes.edit(); bikeChanged();
  },
  finish(go) {
    this.apply(); store.set('welcomed', true); $('dlgWelcome').close();
    if (go === 'loop') {
      setMode('loop');
      if (navigator.geolocation) navigator.geolocation.getCurrentPosition(
        (pos) => { setPoint(0, { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Moja poloha' }); toast('Štart je tvoja poloha. Nastav dĺžku a daj Navrhnúť.'); },
        () => toast('Polohu sa nepodarilo zistiť. Klikni do mapy, kde chceš začať okruh.', true), { enableHighAccuracy: true, timeout: 10000 });
      $('loopKm').scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else if (go === 'ab') { setMode('ab'); setTimeout(() => $('pt0')?.focus(), 50); }
    if (!mapyKey()) openSettings();
  },
};
document.querySelectorAll('#wBikes [data-wbike]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#wBikes [data-wbike]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  $('wWh').value = BIKES[b.dataset.wbike].wh; $('wMass').value = BIKES[b.dataset.wbike].mass;
}));
document.querySelectorAll('#wLevels [data-wlvl]').forEach((b) => b.addEventListener('click', () => document.querySelectorAll('#wLevels [data-wlvl]').forEach((x) => x.setAttribute('aria-pressed', x === b))));
$('wNext').addEventListener('click', () => { Welcome.step = Math.min(2, Welcome.step + 1); Welcome.show(); });
$('wBack').addEventListener('click', () => { Welcome.step = Math.max(0, Welcome.step - 1); Welcome.show(); });
$('wLoop').addEventListener('click', () => Welcome.finish('loop'));
$('wAB').addEventListener('click', () => Welcome.finish('ab'));
$('wSkip').addEventListener('click', () => { store.set('welcomed', true); $('dlgWelcome').close(); });
$('btnWelcomeAgain').addEventListener('click', () => { $('dlgSettings').close(); Welcome.open(); });

/* ---------- Inštalácia do mobilu a offline ---------- */
const hosted = /^https?:/.test(location.protocol);
if (hosted && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('btnInstall').hidden = false; });
$('btnInstall').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $('btnInstall').hidden = true; });
if (hosted && /iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone) {
  $('installHint').hidden = false; $('installHint').textContent = 'Na iPhone: v Safari klikni na Zdieľať a potom Pridať na plochu. Appka bude mať vlastnú ikonu.';
}
// posledná trasa sa pamätá v prehliadači, aby sa dala ukázať aj bez signálu
function rememberRoute() {
  const r = state.route, p = state.prof; if (!r || !p) return;
  const step = Math.max(1, Math.ceil(r.coords.length / 1500));
  const coords = r.coords.filter((_, i) => i % step === 0 || i === r.coords.length - 1).map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]);
  store.set('lastRoute', { name: routeName(), coords, prof: { d: p.d.map(Math.round), e: p.e.map((x) => Math.round(x)) }, length: r.length, duration: r.duration });
}
function showLastRoute() {
  const lr = store.get('lastRoute', null); if (!lr) return;
  const cum = [0]; for (let i = 1; i < lr.coords.length; i++) cum.push(cum[i - 1] + haversine(lr.coords[i - 1], lr.coords[i]));
  calcToken++; state.points = []; state.variants = []; state.variantIdx = -1; renderVariants();
  state.route = { coords: lr.coords, cum, length: lr.length, duration: lr.duration, parts: [] }; state.prof = lr.prof; state.imported = { name: lr.name };
  renderPoints(); renderAll(true, true); toast(`Posledná trasa: ${lr.name}.`);
}
let posMarker = null;
function updateOnline() {
  const off = !navigator.onLine; $('offlineMsg').hidden = !off;
  $('btnLastRoute').hidden = !store.get('lastRoute', null) || !!state.route;
  if (off && navigator.geolocation) navigator.geolocation.getCurrentPosition((pos) => {
    const ll2 = [pos.coords.latitude, pos.coords.longitude];
    if (!posMarker) posMarker = L.circleMarker(ll2, { radius: 8, color: '#fff', weight: 3, fillColor: '#5aa9ff', fillOpacity: 1 }).bindTooltip('Tu si').addTo(map); else posMarker.setLatLng(ll2);
  }, () => {}, { enableHighAccuracy: true, timeout: 10000 });
}
$('btnLastRoute').addEventListener('click', () => { showLastRoute(); $('btnLastRoute').hidden = true; });
window.addEventListener('online', updateOnline); window.addEventListener('offline', updateOnline);

/* ---------- Štart ---------- */
$('rideStart').value = Weather.defaultStart();
loadForm(); Bikes.load(); renderLoopBy();
if (decodeState(location.hash)) { recalc(); state.points.forEach(nameLater); }
else if (!store.get('welcomed', false)) Welcome.open();
renderPoints(); updateRangeHint(); updateOnline();
window.EbikeEnergy = Energy;
