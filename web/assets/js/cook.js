// Cook website: kitchen sign-up, live orders, menu with stock, handover codes.
import {
  sb, $, esc, rs, time, dayTime, isPhone, toast, rpc, guard, errMsg, cities, nearestCity, locate, reverseGeocode,
  makeMap, marker, me, session, renderSignIn, signOut, STATUS, MODE, CATS, onOrderChanges, store,
} from './core.js';

const main = $('#main');
const S = { me: null, cities: [], tab: store.get('cookTab', 'orders'), orders: [], dishes: [], confirmDel: null, codes: {} };
let sub = null, poll = null;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function boot() {
  S.cities = await cities();
  sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_IN' || ev === 'SIGNED_OUT') start(); });
  start();
}
async function start() {
  const s = await session();
  S.me = s ? await me() : null;
  $('#who').textContent = S.me?.cook ? S.me.cook.kitchen_name : 'Cook with Gharowa';
  if (!S.me) return viewSignedOut();
  if (!S.me.cook) return viewRegister();
  viewDashboard();
}

function viewSignedOut() {
  main.innerHTML = `<div class="hero"><h1 class="display">Your kitchen, their home.</h1>
    <p class="muted">Cook Bengali food from your home on the days you choose, for Bengalis in your city who miss it. Set your own menu, plates and prices. We bring the riders.</p></div>
    <div class="stat" style="margin:18px 0 6px"><div><b>You set</b><span>menu, price, plates per day</span></div><div><b>Weekends</b><span>or any days you like</span></div><div><b>Paid</b><span>for every delivered plate</span></div></div>
    <div id="si"></div>`;
  renderSignIn($('#si'), { title: 'Start with your email', onDone: start });
}

/* ---------- registration / kitchen details ---------- */
function kitchenForm(el, c, onSaved) {
  const start = c?.lat ? { lat: c.lat, lng: c.lng } : { lat: 12.9716, lng: 77.5946 };
  const f = { lat: start.lat, lng: start.lng, city: c?.city || nearestCity(S.cities, start.lat, start.lng)?.name || 'Bangalore' };
  el.innerHTML = `<div class="stack">
    <div><label class="f" for="kName" style="margin-top:0">Kitchen name</label><input id="kName" maxlength="60" value="${esc(c?.kitchen_name || '')}" placeholder="e.g. Mashi's Rannaghor"></div>
    <div><label class="f" for="kBio" style="margin-top:0">About your cooking</label><textarea id="kBio" maxlength="300" placeholder="Bangal-style fish curries the way my mother made them in Barisal…">${esc(c?.bio || '')}</textarea></div>
    <div class="grid2"><div><label class="f" for="kRegion" style="margin-top:0">Style</label><select id="kRegion">
      ${['Ghoti home style', 'Bangal (East Bengal) style', 'Pure veg / niramish', 'Kolkata street food', 'Mixed'].map((r) => `<option ${r === c?.home_region ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
      <div><label class="f" for="kPhone" style="margin-top:0">Your mobile</label><input id="kPhone" type="tel" inputmode="numeric" maxlength="10" value="${esc(S.me.phone || '')}" placeholder="98xxxxxxxx"></div></div>
    <div><label class="f" style="margin-top:0">Pickup location</label><div id="kMap" class="map"></div>
      <div class="meta" style="margin-top:4px">Riders come here. Customers only see your area, never your address.</div>
      <button class="btn block" id="kLoc" style="margin-top:8px">Use my current location</button></div>
    <div><label class="f" for="kAddr" style="margin-top:0">Full pickup address</label><input id="kAddr" value="${esc(c?.pickup_address || '')}" placeholder="Flat, building, street, landmark"></div>
    <div class="grid2"><div><label class="f" for="kArea" style="margin-top:0">Area</label><input id="kArea" value="${esc(c?.area || '')}"></div>
      <div><label class="f" for="kCity" style="margin-top:0">City</label><select id="kCity">${S.cities.map((x) => `<option ${x.name === f.city ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div></div>
    <div><label class="f" for="kFssai" style="margin-top:0">FSSAI registration number (if you have one)</label><input id="kFssai" value="${esc(c?.fssai_number || '')}" placeholder="14 digits">
      <div class="meta" style="margin-top:4px">Home cooks need basic FSSAI registration to sell food. We can help you apply.</div></div>
    <button class="btn primary block" id="kSave">${c ? 'Save kitchen details' : 'Send for approval'}</button></div>`;
  const map = makeMap($('#kMap', el), f.lat, f.lng, c ? 17 : 12);
  const pin = marker(map, f.lat, f.lng, 'K', 'k', { draggable: true });
  const fill = async (lat, lng) => {
    f.lat = lat; f.lng = lng; const near = nearestCity(S.cities, lat, lng); if (near) $('#kCity', el).value = near.name;
    const g = await reverseGeocode(lat, lng); if (g.area) $('#kArea', el).value = g.area;
    if (g.road && !$('#kAddr', el).value) $('#kAddr', el).placeholder = 'House / flat no., ' + g.road;
  };
  pin.on('dragend', () => { const p = pin.getLatLng(); fill(p.lat, p.lng); });
  map.on('click', (e) => { pin.setLatLng(e.latlng); fill(e.latlng.lat, e.latlng.lng); });
  const useLoc = async () => { const p = await locate(10000); if (!p) return false; map.setView([p.lat, p.lng], 17); pin.setLatLng([p.lat, p.lng]); await fill(p.lat, p.lng); return true; };
  if (!c) useLoc();
  $('#kLoc', el).onclick = (e) => guard(e.currentTarget, async () => { if (!(await useLoc())) throw new Error('Allow location access, or drag the pin'); });
  $('#kPhone', el).oninput = (e) => (e.target.value = e.target.value.replace(/\D/g, ''));
  $('#kSave', el).onclick = (e) => guard(e.currentTarget, async () => {
    const v = (id) => $('#' + id, el).value.trim();
    if (!isPhone(v('kPhone'))) throw new Error('Enter your 10-digit mobile number');
    if (v('kFssai') && !/^\d{14}$/.test(v('kFssai'))) throw new Error('FSSAI numbers are 14 digits');
    await rpc('set_my_profile', { p_name: S.me.full_name || '', p_phone: v('kPhone') });
    await rpc('register_cook', { p_kitchen: v('kName'), p_bio: v('kBio'), p_region: v('kRegion'), p_city: v('kCity'), p_area: v('kArea'),
      p_pickup_address: v('kAddr'), p_lat: f.lat, p_lng: f.lng, p_fssai: v('kFssai') });
    toast(c ? 'Kitchen details saved' : 'Sent! We\'ll review your kitchen soon.');
    onSaved();
  });
}
function viewRegister() {
  main.innerHTML = `<h1 class="display" style="font-size:30px">Set up your kitchen</h1>
    <p class="muted">Takes two minutes. You can add dishes while we review it.</p>
    ${S.me.full_name ? '' : `<label class="f" for="kYou">Your full name</label><input id="kYou" autocomplete="name">`}
    <div id="kf" style="margin-top:14px"></div>`;
  kitchenForm($('#kf'), null, start);
  const you = $('#kYou');
  if (you) you.onchange = () => rpc('set_my_profile', { p_name: you.value.trim(), p_phone: '' }).then(async () => { S.me = await me(); }).catch(() => {});
}

/* ---------- dashboard ---------- */
async function viewDashboard() {
  const c = S.me.cook;
  const draw = () => {
    main.innerHTML = `${c.is_approved ? '' : `<div class="banner" style="margin-bottom:12px"><b>Your kitchen is being reviewed</b><div class="meta">Add your dishes now. Customers will see you once we approve the kitchen, usually within a day.</div></div>`}
      <div class="card" style="display:flex;flex-wrap:wrap;gap:14px 22px;margin-bottom:14px">
        <button class="switch" id="tOpen" role="switch" aria-checked="${c.is_open}"><i></i>Kitchen open</button>
        <button class="switch" id="tInst" role="switch" aria-checked="${c.accepts_instant}"><i></i>15-minute orders</button></div>
      <div class="tabs" role="tablist">${[['orders', 'Orders'], ['menu', 'My menu'], ['kitchen', 'Kitchen']].map(([k, l]) => `<button class="${S.tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
      <div id="pane"></div>`;
    $('#tOpen').onclick = () => toggle('is_open');
    $('#tInst').onclick = () => toggle('accepts_instant');
    main.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; store.set('cookTab', S.tab); draw(); }));
    if (S.tab === 'orders') paneOrders(); else if (S.tab === 'menu') paneMenu(); else paneKitchen();
  };
  const toggle = (col) => guard(null, async () => {
    const val = !c[col]; const { error } = await sb.from('cooks').update({ [col]: val }).eq('id', c.id); if (error) throw error;
    c[col] = val; toast(col === 'is_open' ? (val ? 'Kitchen open' : 'Kitchen closed. Customers can still pre-order.') : val ? '15-minute orders on' : '15-minute orders off');
    draw();
  });
  if (sub) sb.removeChannel(sub);
  sub = onOrderChanges(() => { if (S.tab === 'orders') paneOrders(true); });
  clearInterval(poll); poll = setInterval(() => { if (S.tab === 'orders' && document.visibilityState === 'visible') paneOrders(true); }, 20000);
  draw();
}

async function paneOrders(quiet) {
  const pane = $('#pane'); if (!pane) return;
  if (!quiet) pane.innerHTML = '<div class="loading">Loading orders…</div>';
  let all;
  try { all = await rpc('my_orders', { p_as: 'cook' }); } catch (e) { pane.innerHTML = `<div class="empty">${esc(errMsg(e))}</div>`; return; }
  const before = new Set(S.orders.filter((o) => o.status === 'placed').map((o) => o.id));
  S.orders = all;
  const open = all.filter((o) => !['delivered', 'cancelled', 'rejected'].includes(o.status));
  const fresh = open.filter((o) => o.status === 'placed' && !before.has(o.id));
  if (quiet && fresh.length) { toast(`New order #${fresh[0].order_no}`); try { navigator.vibrate?.(200); } catch { /* ignore */ } }
  const today = new Date().toDateString();
  const todayDone = all.filter((o) => o.status === 'delivered' && new Date(o.created_at).toDateString() === today);
  if ($('#pane') !== pane) return;
  const focused = document.activeElement?.id;
  pane.innerHTML = `<div class="stat" style="margin-bottom:14px"><div><b>${rs(todayDone.reduce((a, o) => a + +o.items_total, 0))}</b><span>Earned today</span></div>
      <div><b>${open.length}</b><span>Open orders</span></div><div><b>${all.filter((o) => o.status === 'delivered').length}</b><span>Delivered, all time</span></div></div>
    <div class="stack">${open.map(orderCard).join('') || `<div class="empty"><div class="big">No orders right now</div>New orders appear here instantly. Keep this page open while you cook.</div>`}</div>
    ${all.length > open.length ? `<div class="sec-title" style="margin-top:22px">Earlier</div><div class="card">${all.filter((o) => !open.includes(o)).slice(0, 20).map((o) => `<div class="row"><span>#${o.order_no} · ${dayTime(o.created_at)}<span class="meta" style="display:block">${esc(STATUS[o.status])}${o.stars ? ' · ' + '★'.repeat(o.stars) : ''}</span></span><span>${o.status === 'delivered' ? rs(o.items_total) : '–'}</span></div>`).join('')}</div>` : ''}`;
  for (const [id, v] of Object.entries(S.codes)) { const inp = $('#code-' + id); if (inp) inp.value = v; }
  if (focused) $('#' + focused)?.focus();
  pane.querySelectorAll('[data-st]').forEach((b) => (b.onclick = () => guard(b, async () => {
    const [id, st] = b.dataset.st.split('|');
    await rpc('cook_set_status', { p_order: id, p_status: st });
    toast(st === 'accepted' ? 'Accepted' : st === 'preparing' ? 'Cooking started' : st === 'ready' ? 'Calling a rider' : 'Order declined');
    paneOrders(true);
  })));
  pane.querySelectorAll('[data-code]').forEach((inp) => (inp.oninput = () => { inp.value = inp.value.replace(/\D/g, ''); S.codes[inp.dataset.code] = inp.value; }));
  pane.querySelectorAll('[data-hand]').forEach((b) => (b.onclick = () => guard(b, async () => {
    const id = b.dataset.hand, code = (S.codes[id] || '').trim();
    if (code.length < 4) throw new Error("Enter the 4-digit code from the rider's phone");
    await rpc('cook_handover', { p_order: id, p_code: code }); delete S.codes[id];
    toast('Handed over. On its way!'); paneOrders(true);
  })));
}
function orderCard(o) {
  const d = o.delivery;
  let act = '';
  if (o.status === 'placed') act = `<div class="row-btns"><button class="btn" data-st="${o.id}|rejected">Decline</button><button class="btn leaf" data-st="${o.id}|accepted">Accept</button></div>`;
  else if (o.status === 'accepted') act = `<div class="row-btns"><button class="btn" data-st="${o.id}|rejected">Can't make it</button><button class="btn haldi" data-st="${o.id}|preparing">Start cooking</button></div>`;
  else if (o.status === 'preparing') act = `<button class="btn primary block" data-st="${o.id}|ready">Food packed, call a rider</button>`;
  else if (o.status === 'ready') act = !d?.rider_name ? '<div class="meta">Finding a rider near you…</div>' : `
      <div class="meta">${esc(d.rider_name)} ${d.status === 'at_pickup' ? '<b>is at your door.</b>' : 'is on the way.'} Hand over the food only after you enter the code on their phone.</div>
      <label class="f" for="code-${o.id}">Rider's pickup code</label>
      <div style="display:flex;gap:8px"><input id="code-${o.id}" class="code" data-code="${o.id}" inputmode="numeric" maxlength="4" placeholder="••••" style="flex:1">
      <button class="btn leaf" data-hand="${o.id}">Hand over</button></div>`;
  else if (o.status === 'picked_up') act = `<div class="meta">Picked up at ${time(d?.picked_up_at)}. On its way to the customer.</div>`;
  return `<div class="order ${o.status === 'placed' ? 'new' : ''}"><div class="hd"><b>#${o.order_no} · ${esc(o.drop?.name || 'Customer')}, ${esc(o.drop?.area || '')}</b>
      <span class="tag ${o.type === 'instant' ? 'y' : ''}">${o.type === 'instant' ? 'Now' : esc(o.slot || dayTime(o.scheduled_for))}</span></div>
    <ul>${o.items.map((i) => `<li>${i.qty} × ${esc(i.name)}</li>`).join('')}</ul>
    ${o.note ? `<div class="meta" style="margin:-4px 0 10px">Note: “${esc(o.note)}”</div>` : ''}
    <div class="meta" style="margin-bottom:10px">You earn <b>${rs(o.items_total)}</b> · ${esc(STATUS[o.status])}</div>${act}</div>`;
}

async function paneMenu() {
  const pane = $('#pane');
  try { S.dishes = await rpc('my_dishes'); } catch (e) { pane.innerHTML = `<div class="empty">${esc(errMsg(e))}</div>`; return; }
  const draw = () => {
    pane.innerHTML = `<div class="card" style="padding-block:4px">${S.dishes.map((d) => `<div style="padding:13px 0;border-bottom:1px solid var(--line)">
        <div class="row" style="align-items:flex-start"><span><b><span class="veg ${d.is_veg ? '' : 'nv'}"></span>${esc(d.name)}</b><span class="meta" style="display:block">${rs(d.price)} · ${esc(CATS[d.category])} · serves ${d.serves || 1}</span></span>
          <button class="switch" data-avail="${d.id}" role="switch" aria-checked="${d.is_available}"><i></i>${d.is_available ? 'Listed' : 'Hidden'}</button></div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:9px">
          <span class="meta">Plates left</span><div class="step mini"><button data-stk="${d.id}|-1" aria-label="One fewer" ${d.stock_left <= 0 ? 'disabled' : ''}>−</button><span>${d.stock_left}</span><button data-stk="${d.id}|1" aria-label="One more">+</button></div>
          <div class="seg" role="group" aria-label="When customers can order">${['now', 'pre', 'both'].map((m) => `<button class="${d.order_mode === m ? 'on' : ''}" data-mode="${d.id}|${m}">${m === 'now' ? 'Now' : m === 'pre' ? 'Pre-order' : 'Both'}</button>`).join('')}</div>
          <button class="link" data-del="${d.id}" style="color:var(--muted);margin-left:auto">Delete</button></div>
        ${S.confirmDel === d.id ? `<div class="confirm"><b>Delete ${esc(d.name)}?</b><div class="meta">Customers won't see it any more. Past orders keep their record.</div><div class="row-btns"><button class="btn" data-keep>Keep it</button><button class="btn primary" data-dodel="${d.id}">Delete</button></div></div>` : ''}
      </div>`).join('') || '<div class="empty"><div class="big">Your menu is empty</div>Add your first dish below.</div>'}</div>
      <div class="card" style="margin-top:14px"><div class="sec-title" style="margin-top:0">Add a dish</div>
        <label class="f" for="dN" style="margin-top:0">Dish name</label><input id="dN" maxlength="60" placeholder="e.g. Chicken Rezala">
        <label class="f" for="dD">Short description (optional)</label><input id="dD" maxlength="140" placeholder="Slow-cooked in yoghurt and poppy seed">
        <div class="grid2"><div><label class="f" for="dP">Price (₹)</label><input id="dP" type="number" min="1" inputmode="numeric" placeholder="280"></div>
          <div><label class="f" for="dS">Plates available</label><input id="dS" type="number" min="0" inputmode="numeric" value="6"></div></div>
        <div class="grid2"><div><label class="f" for="dC">Category</label><select id="dC">${Object.entries(CATS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <div><label class="f" for="dSv">Serves</label><input id="dSv" type="number" min="1" max="10" value="1"></div></div>
        <div class="grid2"><div><label class="f" for="dV">Type</label><select id="dV"><option value="0">Non-veg</option><option value="1">Veg</option></select></div>
          <div><label class="f" for="dM">Customers can order</label><select id="dM"><option value="both">Now & pre-order</option><option value="pre">Pre-order only</option><option value="now">Available now only</option></select></div></div>
        <button class="btn primary block" id="dAdd" style="margin-top:14px">Add to menu</button></div>`;
    const upd = (id, patch) => guard(null, async () => {
      const { error } = await sb.from('dishes').update(patch).eq('id', id); if (error) throw error;
      Object.assign(S.dishes.find((d) => d.id === id), patch); draw();
    });
    pane.querySelectorAll('[data-avail]').forEach((b) => (b.onclick = () => { const d = S.dishes.find((x) => x.id === b.dataset.avail); upd(d.id, { is_available: !d.is_available }); }));
    pane.querySelectorAll('[data-stk]').forEach((b) => (b.onclick = () => { const [id, by] = b.dataset.stk.split('|'); const d = S.dishes.find((x) => x.id === id); upd(id, { stock_left: Math.max(0, d.stock_left + +by) }); }));
    pane.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { const [id, m] = b.dataset.mode.split('|'); upd(id, { order_mode: m }); }));
    pane.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { S.confirmDel = b.dataset.del; draw(); }));
    pane.querySelector('[data-keep]')?.addEventListener('click', () => { S.confirmDel = null; draw(); });
    pane.querySelector('[data-dodel]')?.addEventListener('click', (e) => guard(e.currentTarget, async () => {
      const id = e.currentTarget.dataset.dodel, name = S.dishes.find((d) => d.id === id).name;
      const { error } = await sb.from('dishes').update({ is_deleted: true, is_available: false }).eq('id', id); if (error) throw error;
      S.dishes = S.dishes.filter((d) => d.id !== id); S.confirmDel = null; toast(`${name} deleted`); draw();
    }));
    $('#dAdd').onclick = (e) => guard(e.currentTarget, async () => {
      const v = (id) => $('#' + id).value.trim();
      const row = { cook_id: S.me.id, name: v('dN'), description: v('dD') || null, price: +v('dP'), stock_left: +v('dS'), daily_limit: +v('dS'),
        category: v('dC'), serves: +v('dSv') || 1, is_veg: v('dV') === '1', order_mode: v('dM') };
      if (row.name.length < 2) throw new Error('Add a dish name');
      if (!(row.price > 0)) throw new Error('Add a price');
      if (!(row.stock_left >= 0)) throw new Error('How many plates can you make?');
      const { data, error } = await sb.from('dishes').insert(row).select().single(); if (error) throw error;
      S.dishes.push(data); toast(`${row.name} added`); draw();
    });
  };
  draw();
}

function paneKitchen() {
  const c = S.me.cook, pane = $('#pane');
  pane.innerHTML = `<div class="card" style="margin-bottom:14px"><div class="sec-title" style="margin-top:0">Days you cook</div>
      <div class="chips">${DAYS.map((d, i) => `<button class="chip ${(c.available_days || []).includes(i) ? 'on' : ''}" data-day="${i}">${d}</button>`).join('')}</div>
      <div class="meta" style="margin-top:8px">Customers can pre-order for these days.</div></div>
    <div class="card"><div class="sec-title" style="margin-top:0">Kitchen details</div><div id="kf"></div></div>
    <button class="btn danger block" id="out" style="margin-top:14px">Sign out</button>`;
  pane.querySelectorAll('[data-day]').forEach((b) => (b.onclick = () => guard(null, async () => {
    const i = +b.dataset.day, set = new Set(c.available_days || []); set.has(i) ? set.delete(i) : set.add(i);
    const days = [...set].sort(); const { error } = await sb.from('cooks').update({ available_days: days }).eq('id', c.id); if (error) throw error;
    c.available_days = days; b.classList.toggle('on');
  })));
  kitchenForm($('#kf'), c, start);
  $('#out').onclick = signOut;
}

boot().catch((e) => { main.innerHTML = `<div class="empty">${esc(errMsg(e))}</div>`; });
