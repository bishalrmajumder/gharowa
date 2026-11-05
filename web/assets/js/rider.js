// Rider website: go online, get auto-assigned pickups, codes at both ends, UPI settlement.
import {
  sb, $, esc, rs, time, dayTime, isPhone, toast, rpc, guard, errMsg, cities, nearestCity, locate,
  makeMap, marker, riderDot, directions, me, session, renderSignIn, signOut, onOrderChanges, store,
} from './core.js';
import { RIDER_PAY } from './config.js';

const main = $('#main');
const S = { me: null, cities: [], tab: 'jobs', orders: [], pos: null, code: {}, dropIn: '', payouts: [], confirm: null };
let sub = null, poll = null, watchId = null, pingTimer = null, map = null, mk = {};

async function boot() {
  S.cities = await cities();
  sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_IN' || ev === 'SIGNED_OUT') start(); });
  start();
}
async function start() {
  const s = await session();
  S.me = s ? await me() : null;
  $('#who').textContent = S.me?.rider ? (S.me.full_name || 'Rider') : 'Ride with Gharowa';
  if (!S.me) return viewSignedOut();
  if (!S.me.rider) return viewRegister();
  if (S.me.rider.is_online) startTracking();
  viewApp();
}

function viewSignedOut() {
  main.innerHTML = `<div class="hero"><h1 class="display">Deliver home food, get paid the same day.</h1>
    <p class="muted">Short trips from home kitchens to homes nearby. ${rs(RIDER_PAY)} a delivery, and you can move your earnings to UPI whenever you like.</p></div>
    <div id="si" style="margin-top:12px"></div>`;
  renderSignIn($('#si'), { title: 'Start with your email', onDone: start });
}
function viewRegister() {
  main.innerHTML = `<h1 class="display" style="font-size:30px">Become a Gharowa rider</h1>
    <p class="muted">We'll check your details and switch you on, usually within a day.</p>
    <div class="card stack" style="margin-top:12px">
      <div><label class="f" for="rName" style="margin-top:0">Full name</label><input id="rName" autocomplete="name" value="${esc(S.me.full_name || '')}"></div>
      <div><label class="f" for="rPhone" style="margin-top:0">Mobile number</label><input id="rPhone" type="tel" inputmode="numeric" maxlength="10" value="${esc(S.me.phone || '')}" placeholder="98xxxxxxxx"></div>
      <div class="grid2"><div><label class="f" for="rCity" style="margin-top:0">City</label><select id="rCity">${S.cities.map((c) => `<option>${esc(c.name)}</option>`).join('')}</select></div>
        <div><label class="f" for="rVeh" style="margin-top:0">Vehicle</label><select id="rVeh"><option value="bike">Motorbike</option><option value="scooter">Scooter</option><option value="ev">Electric scooter</option><option value="cycle">Bicycle</option></select></div></div>
      <div><label class="f" for="rUpi" style="margin-top:0">UPI ID for payouts</label><input id="rUpi" autocomplete="off" placeholder="name@okaxis"></div>
      <button class="btn primary block" id="rGo">Send for approval</button></div>`;
  locate().then((p) => { const c = p && nearestCity(S.cities, p.lat, p.lng); if (c) $('#rCity').value = c.name; });
  $('#rPhone').oninput = (e) => (e.target.value = e.target.value.replace(/\D/g, ''));
  $('#rGo').onclick = (e) => guard(e.currentTarget, async () => {
    const v = (id) => $('#' + id).value.trim();
    if (v('rName').length < 2) throw new Error('Enter your full name');
    if (!isPhone(v('rPhone'))) throw new Error('Enter a 10-digit mobile number');
    if (v('rUpi') && !/^[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}$/.test(v('rUpi'))) throw new Error('Enter a UPI ID like name@okaxis');
    await rpc('set_my_profile', { p_name: v('rName'), p_phone: v('rPhone') });
    await rpc('register_rider', { p_city: v('rCity'), p_vehicle: v('rVeh'), p_phone: v('rPhone'), p_upi: v('rUpi') });
    toast('Sent! We\'ll switch you on soon.'); start();
  });
}

/* ---------- location ---------- */
function startTracking() {
  if (watchId == null && navigator.geolocation) {
    watchId = navigator.geolocation.watchPosition((p) => { S.pos = { lat: p.coords.latitude, lng: p.coords.longitude }; moveMe(); },
      () => {}, { enableHighAccuracy: true, maximumAge: 15000 });
  }
  clearInterval(pingTimer);
  pingTimer = setInterval(() => ping(true), 20000);
  ping(true);
}
function stopTracking() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null; clearInterval(pingTimer);
}
async function ping(online) {
  try { await rpc('rider_ping', { p_lat: S.pos?.lat ?? null, p_lng: S.pos?.lng ?? null, p_online: online }); } catch { /* retry next tick */ }
}
function moveMe() { if (map && S.pos) { if (mk.me) mk.me.setLatLng([S.pos.lat, S.pos.lng]); else mk.me = riderDot(map, S.pos.lat, S.pos.lng); } }

/* ---------- main app ---------- */
function viewApp() {
  const r = S.me.rider;
  const draw = () => {
    main.innerHTML = `${r.is_approved ? '' : `<div class="banner" style="margin-bottom:12px"><b>Waiting for approval</b><div class="meta">We're checking your details. You can go online once you're approved.</div></div>`}
      <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px">
        <span><b>${r.is_online ? "You're online" : "You're offline"}</b><span class="meta" style="display:block">${esc(r.city)} · ${esc(r.vehicle)}</span></span>
        <button class="switch" id="online" role="switch" aria-checked="${r.is_online}" ${r.is_approved ? '' : 'disabled'}><i></i>Online</button></div>
      <div class="tabs">${[['jobs', 'Pickups'], ['money', 'Earnings ' + rs(r.wallet_balance)], ['me', 'Account']].map(([k, l]) => `<button class="${S.tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
      <div id="pane"></div>`;
    $('#online').onclick = () => guard(null, async () => {
      const on = !r.is_online;
      if (on) { const p = await locate(10000); if (!p) throw new Error('Allow location access so we can send you nearby pickups'); S.pos = p; }
      await rpc('rider_ping', { p_lat: S.pos?.lat ?? null, p_lng: S.pos?.lng ?? null, p_online: on });
      r.is_online = on; on ? startTracking() : stopTracking();
      toast(on ? "You're online. Pickups will appear here." : "You're offline"); draw();
    });
    main.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; draw(); }));
    map = null; mk = {};
    if (S.tab === 'jobs') paneJobs(); else if (S.tab === 'money') paneMoney(); else paneMe();
  };
  S.redraw = draw;
  if (sub) sb.removeChannel(sub);
  sub = onOrderChanges(() => { if (S.tab === 'jobs') paneJobs(true); });
  clearInterval(poll); poll = setInterval(() => { if (S.tab === 'jobs' && document.visibilityState === 'visible') paneJobs(true); }, 15000);
  draw();
}

async function paneJobs(quiet) {
  const pane = $('#pane'); if (!pane) return;
  let all;
  try { all = await rpc('my_orders', { p_as: 'rider' }); } catch (e) { if (!quiet) pane.innerHTML = `<div class="empty">${esc(errMsg(e))}</div>`; return; }
  const job = all.find((o) => o.delivery && ['assigned', 'at_pickup', 'picked_up'].includes(o.delivery.status));
  const prevId = S.orders.find((o) => o.delivery && ['assigned', 'at_pickup', 'picked_up'].includes(o.delivery.status))?.id;
  S.orders = all;
  if (quiet && job && job.id !== prevId) { toast(`New pickup #${job.order_no}`); try { navigator.vibrate?.([200, 100, 200]); } catch { /* ignore */ } }
  if (job && !S.code[job.id]) S.code[job.id] = await rpc('my_code', { p_order: job.id }).catch(() => null);
  const r = S.me.rider;
  if (!job) {
    map = null; mk = {};
    const today = all.filter((o) => o.delivery?.status === 'delivered' && new Date(o.delivery.delivered_at).toDateString() === new Date().toDateString());
    pane.innerHTML = `<div class="stat" style="margin-bottom:14px"><div><b>${today.length}</b><span>Deliveries today</span></div><div><b>${rs(today.reduce((a, o) => a + +(o.delivery.cost || RIDER_PAY), 0))}</b><span>Earned today</span></div></div>
      ${r.is_online ? `<div class="empty"><div class="big">Waiting for a pickup</div>Jobs go to the nearest free rider the moment a cook packs the food. Keep this page open.</div>`
        : `<div class="empty"><div class="big">You're offline</div>Go online to get pickups.</div>`}`;
    return;
  }
  const d = job.delivery, k = job.kitchen, dr = job.drop || {}, st = d.status;
  const keep = map && $('#rmap');
  const old = keep ? $('#rmap') : null;
  const typing = document.activeElement?.id === 'dropIn';
  if (typing && quiet) return;   // don't disturb the rider mid-typing
  pane.innerHTML = `<div id="rmap" class="map tall"></div>
    <div class="order new" style="margin-top:12px"><div class="hd"><b>#${job.order_no}</b><span class="tag y">You earn ${rs(d.cost || RIDER_PAY)}</span></div>
    ${st !== 'picked_up' ? `
      <div class="meta">Pick up from</div><b>${esc(k.name)}</b><div class="meta">${esc(k.cook_name || '')}${k.phone ? ` · <span class="num">+91 ${esc(k.phone)}</span>` : ''}</div>
      <div style="margin:4px 0 8px">${esc(k.address || '')}</div>
      <a class="btn sm" href="${directions(k.lat, k.lng)}" target="_blank" rel="noopener">Directions to kitchen</a>
      <ul>${job.items.map((i) => `<li>${i.qty} × ${esc(i.name)}</li>`).join('')}</ul>
      <div class="meta">Show this code to the cook</div><div class="otp">${esc(S.code[job.id] || '····')}</div>
      ${st === 'assigned' ? `<button class="btn haldi block" id="arrived" style="margin-top:10px">I've reached the kitchen</button>`
        : `<div class="banner" style="margin-top:10px"><b>Waiting for the cook</b><div class="meta">They type your code to hand over the food. This screen moves on by itself.</div></div>`}`
    : `
      <div class="meta">Deliver to</div><b>${esc(dr.name || 'Customer')}</b>${dr.phone ? ` · <span class="num">+91 ${esc(dr.phone)}</span>` : ''}
      <div style="margin:4px 0 8px">${esc(dr.line1 || '')}, ${esc(dr.area || '')} ${esc(dr.pincode || '')}</div>
      <a class="btn sm" href="${directions(dr.lat, dr.lng)}" target="_blank" rel="noopener">Directions to customer</a>
      <div class="row" style="margin-top:10px"><span>Collect from customer</span><b>${rs(job.grand_total)}</b></div>
      <div class="meta">Cash or UPI to Gharowa's account.</div>
      <label class="f" for="dropIn">Customer's 4-digit code</label>
      <input id="dropIn" class="code" inputmode="numeric" maxlength="4" placeholder="••••" value="${esc(S.dropIn)}">
      <button class="btn leaf block" id="deliver" style="margin-top:10px">Mark delivered</button>`}
    </div>`;
  if (old) $('#rmap').replaceWith(old);
  if (!map) {
    map = makeMap($('#rmap'), k.lat, k.lng, 13);
    mk.k = marker(map, k.lat, k.lng, 'K', 'k'); if (dr.lat) mk.h = marker(map, dr.lat, dr.lng, 'H', 'h');
    const pts = [[k.lat, k.lng], dr.lat && [dr.lat, dr.lng], S.pos && [S.pos.lat, S.pos.lng]].filter(Boolean);
    map.fitBounds(window.L.latLngBounds(pts).pad(0.3));
  }
  moveMe();
  $('#arrived')?.addEventListener('click', (e) => guard(e.currentTarget, async () => { await rpc('rider_arrived', { p_order: job.id }); toast('Cook has been told you\'re here'); paneJobs(true); }));
  const di = $('#dropIn'); if (di) di.oninput = () => { di.value = di.value.replace(/\D/g, ''); S.dropIn = di.value; };
  $('#deliver')?.addEventListener('click', (e) => guard(e.currentTarget, async () => {
    if (S.dropIn.length < 4) throw new Error("Ask the customer for the 4-digit code on their screen");
    await rpc('rider_deliver', { p_order: job.id, p_code: S.dropIn });
    S.dropIn = ''; S.me = await me(); toast(`Delivered. ${rs(d.cost || RIDER_PAY)} added to your earnings.`); S.redraw();
  }));
}

async function paneMoney() {
  const pane = $('#pane'), r = S.me.rider;
  const { data } = await sb.from('rider_payouts').select('*').order('created_at', { ascending: false }).limit(30);
  S.payouts = data || [];
  const draw = () => {
    pane.innerHTML = `<div class="wallet"><div class="meta" style="color:inherit;opacity:.85">Ready to settle</div><div class="amt">${rs(r.wallet_balance)}</div>
        <div style="opacity:.85;font-size:13px">${rs(RIDER_PAY)} for every delivery</div></div>
      <div class="card" style="margin-top:12px">${S.confirm ? `
        <div class="sec-title" style="margin-top:0">Check before sending</div>
        <div class="row"><span>Amount</span><b>${rs(S.confirm.amt)}</b></div><div class="row"><span>To</span><b>${esc(S.confirm.upi)}</b></div>
        <div class="row-btns"><button class="btn" id="pEdit">Edit</button><button class="btn leaf" id="pSend">Request ${rs(S.confirm.amt)}</button></div>`
      : `<div class="sec-title" style="margin-top:0">Settle to UPI, anytime</div>
        <label class="f" for="pUpi" style="margin-top:0">UPI ID</label><input id="pUpi" autocomplete="off" value="${esc(r.upi_id || '')}" placeholder="name@okaxis">
        <label class="f" for="pAmt">Amount (₹)</label><input id="pAmt" type="number" min="1" inputmode="numeric" value="${Math.floor(r.wallet_balance) || ''}">
        <button class="btn leaf block" id="pGo" style="margin-top:12px" ${r.wallet_balance > 0 ? '' : 'disabled'}>Settle now</button>
        <div class="meta" style="margin-top:8px">No minimum and no fee. Gharowa sends it to your UPI, usually the same day.</div>`}</div>
      <div class="card" style="margin-top:12px"><div class="sec-title" style="margin-top:0">Payouts</div>
        ${S.payouts.map((p) => `<div class="row"><span>${dayTime(p.created_at)}<span class="meta" style="display:block">${esc(p.upi_id)} · ${p.status === 'paid' ? '<span class="ok">Paid</span>' + (p.utr ? ' · Ref ' + esc(p.utr) : '') : p.status === 'failed' ? '<span class="warn">Failed, money back in wallet</span>' : 'Processing'}</span></span><b>${rs(p.amount)}</b></div>`).join('') || '<div class="meta">No payouts yet.</div>'}</div>`;
    $('#pGo')?.addEventListener('click', () => {
      const upi = $('#pUpi').value.trim(), amt = Math.floor(+$('#pAmt').value);
      if (!/^[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}$/.test(upi)) return toast('Enter a UPI ID like name@okaxis', 'bad');
      if (!(amt > 0) || amt > r.wallet_balance) return toast('Enter an amount up to ' + rs(r.wallet_balance), 'bad');
      S.confirm = { upi, amt }; draw();
    });
    $('#pEdit')?.addEventListener('click', () => { S.confirm = null; draw(); });
    $('#pSend')?.addEventListener('click', (e) => guard(e.currentTarget, async () => {
      await rpc('request_payout', { p_amount: S.confirm.amt, p_upi: S.confirm.upi });
      toast(`${rs(S.confirm.amt)} requested to ${S.confirm.upi}`); S.confirm = null; S.me = await me(); S.redraw();
    }));
  };
  draw();
}

function paneMe() {
  const r = S.me.rider;
  $('#pane').innerHTML = `<div class="card"><div class="row"><span>Name</span><b>${esc(S.me.full_name || '')}</b></div>
      <div class="row"><span>Mobile</span><b class="num">+91 ${esc(r.phone || '')}</b></div><div class="row"><span>Email</span><b>${esc(S.me.email || '')}</b></div>
      <div class="row"><span>City</span><b>${esc(r.city)}</b></div><div class="row"><span>Status</span><b>${r.is_approved ? '<span class="ok">Approved</span>' : 'Under review'}</b></div></div>
    <a class="btn block" href="index.html" style="margin-top:12px">Order food on Gharowa</a>
    <button class="btn danger block" id="out" style="margin-top:8px">Sign out</button>`;
  $('#out').onclick = async () => { if (r.is_online) await ping(false); signOut(); };
}

boot().catch((e) => { main.innerHTML = `<div class="empty">${esc(errMsg(e))}</div>`; });
