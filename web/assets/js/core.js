// Shared helpers for every Gharowa page: Supabase client, sign-in, UI bits, maps.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/* ---------- tiny utilities ---------- */
export const $ = (s, r = document) => r.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const rs = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
export const time = (t) => (t ? new Date(t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '');
export const dayTime = (t) => (t ? new Date(t).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
export const isPhone = (v) => /^[6-9]\d{9}$/.test(v || '');
export const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((v || '').trim());
export const store = {
  get(k, d) { try { const v = localStorage.getItem('gh.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gh.' + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

let toastTimer;
export function toast(msg, kind = '') {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.append(t); }
  t.textContent = msg; t.className = 'toast show ' + kind;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// Turn database errors into plain sentences
export function errMsg(e) {
  const m = e?.message || String(e);
  if (/JWT|not authenticated|permission denied for function/i.test(m)) return 'Please sign in again.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'No internet connection. Try again.';
  return m.replace(/^.*?ERROR:\s*/, '');
}
export async function rpc(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(errMsg(error));
  return data;
}
export async function guard(btn, fn) {
  if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Please wait…'; }
  try { return await fn(); }
  catch (e) { toast(errMsg(e), 'bad'); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = btn.dataset.label; } }
}

/* ---------- cities ---------- */
let citiesCache;
export async function cities() {
  if (!citiesCache) {
    const { data, error } = await sb.from('cities').select('id,name,lat,lng').eq('is_live', true).order('id');
    if (error) throw error;
    citiesCache = data;
  }
  return citiesCache;
}
export function nearestCity(list, lat, lng) {
  let best = null, bd = Infinity;
  for (const c of list) { const d = (c.lat - lat) ** 2 + (c.lng - lng) ** 2; if (d < bd) { bd = d; best = c; } }
  return bd < 1 ? best : null; // within roughly 100 km
}
export const distKm = (a, b, c, d) => {
  const R = 6371, r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r;
  const h = Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
export function locate(timeout = 8000) {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res(null),
      { enableHighAccuracy: true, timeout, maximumAge: 60000 });
  });
}
// Fill area and pin code from a map pin (OpenStreetMap Nominatim, light use)
export async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`, { headers: { 'Accept-Language': 'en' } });
    const j = await r.json(); const a = j.address || {};
    return {
      area: a.suburb || a.neighbourhood || a.city_district || a.quarter || a.residential || a.village || '',
      pincode: (a.postcode || '').replace(/\s/g, ''),
      road: [a.house_number, a.building, a.road].filter(Boolean).join(', '),
      city: a.city || a.town || a.state_district || '',
    };
  } catch { return {}; }
}

/* ---------- maps (Leaflet + OpenStreetMap) ---------- */
const pinIcon = (letter, cls) => window.L.divIcon({ className: '', html: `<span class="pin ${cls}"><span>${letter}</span></span>`, iconSize: [30, 38], iconAnchor: [15, 36] });
export function makeMap(el, lat, lng, zoom = 14) {
  const m = window.L.map(el, { zoomControl: true, attributionControl: true }).setView([lat, lng], zoom);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
  setTimeout(() => m.invalidateSize(), 60);
  return m;
}
export function marker(map, lat, lng, letter, cls, opts = {}) { return window.L.marker([lat, lng], { icon: pinIcon(letter, cls), ...opts }).addTo(map); }
export function riderDot(map, lat, lng) {
  return window.L.circleMarker([lat, lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#2E6B3B', fillOpacity: 1, className: 'rider-dot' }).addTo(map);
}
export const directions = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

/* ---------- sign-in ---------- */
export async function session() { const { data } = await sb.auth.getSession(); return data.session; }
export async function me() { try { return await rpc('me'); } catch { return null; } }

// Renders the email sign-in flow into `el`. Calls onDone() once signed in.
export function renderSignIn(el, { title = 'Sign in or sign up', sub = 'Enter your email. We\'ll send a sign-in link and code. New here? Your account is created automatically.', onDone } = {}) {
  const st = { step: 'email', email: store.get('lastEmail', '') };
  const draw = () => {
    el.innerHTML = st.step === 'email' ? `
      <div class="signin">
        <h2 class="display">${esc(title)}</h2><p class="muted">${esc(sub)}</p>
        <label class="f" for="si-email">Email address</label>
        <input id="si-email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" value="${esc(st.email)}">
        <button class="btn primary block" id="si-send">Send sign-in email</button>
        <p class="fine">Mobile number sign-in is coming soon. You can add your number after signing in.</p>
      </div>` : `
      <div class="signin">
        <h2 class="display">Check your email</h2>
        <p class="muted">We sent a message to <b>${esc(st.email)}</b>. Tap the link in it on this device, or type the code if your email shows one.</p>
        <label class="f" for="si-code">Code from the email</label>
        <input id="si-code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="••••••">
        <button class="btn primary block" id="si-verify">Continue</button>
        <div class="row-btns"><button class="btn" id="si-resend">Resend email</button><button class="btn" id="si-change">Change email</button></div>
        <p class="fine">Can't find it? Check spam or promotions.</p>
      </div>`;
    if (st.step === 'email') {
      const inp = $('#si-email', el); inp.focus();
      inp.onkeydown = (e) => { if (e.key === 'Enter') $('#si-send', el).click(); };
      $('#si-send', el).onclick = (e) => guard(e.currentTarget, async () => {
        const email = inp.value.trim().toLowerCase();
        if (!isEmail(email)) throw new Error('Enter a valid email address');
        const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } });
        if (error) throw error;
        st.email = email; store.set('lastEmail', email); st.step = 'code'; draw(); toast('Email sent');
      });
    } else {
      const inp = $('#si-code', el); inp.focus();
      inp.oninput = () => { inp.value = inp.value.replace(/\D/g, ''); };
      inp.onkeydown = (e) => { if (e.key === 'Enter') $('#si-verify', el).click(); };
      $('#si-verify', el).onclick = (e) => guard(e.currentTarget, async () => {
        const token = inp.value.trim();
        if (token.length < 6) throw new Error('Enter the code from the email');
        const { error } = await sb.auth.verifyOtp({ email: st.email, token, type: 'email' });
        if (error) throw new Error(/expired|invalid/i.test(error.message) ? 'That code is wrong or has expired. Send a new email.' : error.message);
        onDone && onDone();
      });
      $('#si-resend', el).onclick = (e) => guard(e.currentTarget, async () => {
        const { error } = await sb.auth.signInWithOtp({ email: st.email, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) throw new Error(/rate|seconds/i.test(error.message) ? 'Please wait a minute before asking for another email.' : error.message);
        toast('Sent again');
      });
      $('#si-change', el).onclick = () => { st.step = 'email'; draw(); };
    }
  };
  draw();
}
export async function signOut() { await sb.auth.signOut(); location.reload(); }

/* ---------- status words ---------- */
export const STATUS = {
  placed: 'Waiting for the cook', accepted: 'Cook accepted', preparing: 'Cooking', ready: 'Packed, rider on the way',
  picked_up: 'On the way to you', delivered: 'Delivered', cancelled: 'Cancelled', rejected: 'Declined by the cook',
};
export const STEPS = ['placed', 'accepted', 'preparing', 'ready', 'picked_up', 'delivered'];
export const MODE = { now: 'Available now', pre: 'Pre-order', both: 'Now & pre-order' };
export const CATS = { thali: 'Thali', rice_bread: 'Rice & breads', fish: 'Fish', meat: 'Meat & chicken', veg: 'Veg', dal: 'Dal', snacks: 'Snacks', sweets: 'Sweets' };

// Live updates: run cb whenever an order or delivery the user can see changes
export function onOrderChanges(cb) {
  return sb.channel('orders-' + Math.random().toString(36).slice(2))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, cb)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, cb)
    .subscribe();
}
