// Customer website: browse kitchens, order, track.
import {
  sb, $, esc, rs, time, dayTime, isPhone, isEmail, store, toast, rpc, guard, errMsg, cities, nearestCity, distKm, locate,
  reverseGeocode, makeMap, marker, riderDot, me, session, renderSignIn, signOut, STATUS, STEPS, MODE, CATS, onOrderChanges,
} from './core.js';
import { FEES } from './config.js';

const main = $('#main');
const S = {
  me: null, cities: [], city: null, loc: null, addresses: [], addrSel: store.get('addrSel', null),
  kitchens: [], kitchen: null, dishes: [], cart: store.get('cart', { cook: null, items: {}, info: {} }),
  mode: 'scheduled', slot: null, note: '', orders: [], afterSignIn: null,
};
const saveCart = () => store.set('cart', S.cart);
const cartCount = () => Object.values(S.cart.items).reduce((a, b) => a + b, 0);
const cartTotal = () => Object.entries(S.cart.items).reduce((a, [id, q]) => a + (S.cart.info[id]?.price || 0) * q, 0);
const addr = () => S.addresses.find((a) => a.id === S.addrSel);
const cityName = (id) => S.cities.find((c) => c.id === id)?.name || '';
let liveSub = null, pollTimer = null, trackMap = null;

/* ---------- boot ---------- */
async function boot() {
  try { S.cities = await cities(); } catch (e) { main.innerHTML = `<div class="empty"><div class="big">Can't reach Gharowa</div>${esc(errMsg(e))}</div>`; return; }
  S.city = S.cities.find((c) => c.id === store.get('cityId')) || null;
  await loadUser();
  sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_IN' || ev === 'SIGNED_OUT') loadUser().then(route); });
  window.addEventListener('hashchange', route);
  route();
  // Work out where the customer is, quietly
  locate().then((p) => {
    if (!p) return;
    S.loc = p;
    const near = nearestCity(S.cities, p.lat, p.lng);
    if (!store.get('cityId') && near) { S.city = near; store.set('cityId', near.id); }
    pickDefaultAddress(); drawTop(); if (!location.hash || location.hash === '#') route();
  });
}
async function loadUser() {
  const s = await session();
  S.me = s ? await me() : null;
  if (S.me) {
    const { data } = await sb.from('addresses').select('*').order('id');
    S.addresses = data || [];
    pickDefaultAddress();
    if (S.afterSignIn) { const go = S.afterSignIn; S.afterSignIn = null; location.hash = go; }
  } else { S.addresses = []; }
  drawTop();
}
// Saved address closest to where the phone is (within 1.5 km); else keep the last one used
function pickDefaultAddress() {
  if (!S.addresses.length) { S.addrSel = null; return; }
  if (S.loc) {
    const near = S.addresses.map((a) => [a, a.lat ? distKm(a.lat, a.lng, S.loc.lat, S.loc.lng) : 999]).sort((x, y) => x[1] - y[1])[0];
    S.addrSel = near[1] < 1.5 ? near[0].id : null;
  } else if (!addr()) S.addrSel = S.addresses[0].id;
  if (addr()) { S.city = S.cities.find((c) => c.id === addr().city_id) || S.city; store.set('cityId', S.city?.id); }
  store.set('addrSel', S.addrSel);
}

/* ---------- header ---------- */
function drawTop() {
  const a = addr();
  $('#where').innerHTML = a
    ? `<b>${esc(a.label)} · ${esc(a.area || a.line1)} ▾</b><span>${esc(a.line1)}, ${esc(cityName(a.city_id))}</span>`
    : `<b>${S.city ? 'Delivering in ' + esc(S.city.name) : 'Choose your city'} ▾</b><span>${S.loc ? 'Using your location' : 'Tap to change'}</span>`;
  const av = $('#avatar');
  av.textContent = S.me ? (S.me.full_name || S.me.email || 'G')[0].toUpperCase() : '→';
  av.setAttribute('aria-label', S.me ? 'My account' : 'Sign in');
}
$('#where').onclick = () => openPlaces();
$('#avatar').onclick = () => { location.hash = S.me ? '#account' : '#signin'; };

/* ---------- router ---------- */
function route() {
  if (liveSub) { sb.removeChannel(liveSub); liveSub = null; }
  clearInterval(pollTimer); trackMap = null;
  const h = location.hash.replace('#', '');
  if (h.startsWith('access_token') || h.startsWith('error')) { location.hash = ''; return; }
  window.scrollTo(0, 0);
  if (h === 'signin') return viewSignIn();
  if (h.startsWith('k-')) return viewKitchen(h.slice(2));
  if (h === 'checkout') return viewCheckout();
  if (h.startsWith('order-')) return viewOrder(h.slice(6));
  if (h === 'account') return viewAccount();
  return viewHome();
}
const loading = () => { main.innerHTML = '<div class="loading">Loading…</div>'; };

/* ---------- home ---------- */
async function viewHome() {
  if (!S.city) {
    main.innerHTML = `<div class="hero"><h1 class="display">Ghorer ranna, far from home.</h1>
      <p class="muted">Home-cooked Bengali food from Bengali home kitchens in your city. Kosha mangsho on Sunday, shorshe ilish when you miss Ma's.</p></div>
      <div class="sec-title" style="margin-top:22px">Where are you?</div>
      <div class="chips">${S.cities.map((c) => `<button class="chip" data-city="${c.id}">${esc(c.name)}</button>`).join('')}</div>`;
    main.querySelectorAll('[data-city]').forEach((b) => (b.onclick = () => setCity(+b.dataset.city)));
    return;
  }
  loading();
  const [{ data: ks, error }, active] = await Promise.all([
    sb.from('cooks').select('id,kitchen_name,bio,home_region,area,is_open,accepts_instant,available_days,rating,rating_count')
      .eq('city_id', S.city.id).eq('is_approved', true).order('is_open', { ascending: false }).order('rating', { ascending: false }),
    S.me ? rpc('my_orders', { p_as: 'customer' }).catch(() => []) : [],
  ]);
  if (error) { main.innerHTML = `<div class="empty">${esc(errMsg(error))}</div>`; return; }
  S.kitchens = ks; S.orders = active;
  const live = active.filter((o) => !['delivered', 'cancelled', 'rejected'].includes(o.status));
  let h = '';
  if (S.me && !addr()) h += `<div class="banner red" style="margin-bottom:14px"><b>${S.addresses.length ? 'New place?' : 'Where should we deliver?'}</b>
    <div class="meta" style="margin:2px 0 10px">${S.addresses.length ? "You aren't near any of your saved addresses." : 'Add your address once and we\'ll remember it.'} Browse now, add it when you order.</div>
    <button class="btn primary sm" id="addHere">Add address here</button></div>`;
  h += live.map((o) => `<a class="banner" style="margin-bottom:10px;text-decoration:none" href="#order-${o.id}"><b>Order #${o.order_no}</b> · ${esc(STATUS[o.status])}<br><span class="meta">${esc(o.kitchen.name)} · tap to track</span></a>`).join('');
  h += `<div class="hero"><h1 class="display">Ghorer ranna in ${esc(S.city.name)}</h1><p class="muted">Cooked fresh in Bengali homes near you. Pre-order for tomorrow, or get today's pot in 15 minutes.</p></div>`;
  h += `<div class="sec-title" style="margin-top:20px">Home kitchens <span class="meta">${ks.length}</span></div><div class="stack">`;
  h += ks.map((k) => `<a class="kitchen" href="#k-${k.id}" style="text-decoration:none">
      <div class="n">${esc(k.kitchen_name)}</div>
      <div class="meta">${esc(k.area || '')}${k.rating_count ? ` · ★ ${k.rating} (${k.rating_count})` : ' · New kitchen'}</div>
      ${k.bio ? `<div class="meta" style="margin-top:4px">${esc(k.bio).slice(0, 120)}</div>` : ''}
      <div class="tags">${k.home_region ? `<span class="tag">${esc(k.home_region)}</span>` : ''}
        ${k.is_open ? '<span class="tag g">Taking orders</span>' : '<span class="tag r">Closed now · pre-order</span>'}
        ${k.is_open && k.accepts_instant ? '<span class="tag y">15 min delivery</span>' : ''}</div></a>`).join('')
    || `<div class="empty"><div class="big">Kitchens are coming to ${esc(S.city.name)}</div>We're signing up home cooks here now. <a href="cook.html">Cook with Gharowa</a></div>`;
  h += '</div>';
  main.innerHTML = h;
  $('#addHere')?.addEventListener('click', () => openAddressEditor(null));
  if (cartCount()) drawCartBar();
}
function setCity(id) {
  S.city = S.cities.find((c) => c.id === id); store.set('cityId', id);
  if (addr() && addr().city_id !== id) { S.addrSel = null; store.set('addrSel', null); }
  if (S.cart.cook && S.cart.city && S.cart.city !== id) clearCart();
  drawTop(); location.hash = ''; route();
}
function drawCartBar() {
  if (!cartCount()) return;
  const b = document.createElement('a');
  b.className = 'cartbar'; b.href = '#checkout'; b.style.textDecoration = 'none';
  b.innerHTML = `<span>${cartCount()} item${cartCount() > 1 ? 's' : ''} · ${rs(cartTotal())}</span><span>View cart →</span>`;
  main.append(b);
}
function clearCart() { S.cart = { cook: null, items: {}, info: {} }; saveCart(); }

/* ---------- kitchen ---------- */
async function viewKitchen(id) {
  loading();
  const [{ data: k }, { data: dishes, error }] = await Promise.all([
    sb.from('cooks').select('id,kitchen_name,bio,home_region,area,city_id,is_open,accepts_instant,available_days,rating,rating_count').eq('id', id).maybeSingle(),
    sb.from('dishes').select('id,name,description,category,price,serves,is_veg,stock_left,order_mode,is_available').eq('cook_id', id).eq('is_available', true).order('category'),
  ]);
  if (!k || error) { main.innerHTML = '<div class="empty"><div class="big">Kitchen not found</div><a href="#">Back to kitchens</a></div>'; return; }
  S.kitchen = k; S.dishes = dishes;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const draw = () => {
    let h = `<button class="link" onclick="history.back()">← All kitchens</button>
      <h1 class="display" style="font-size:32px;margin-top:10px">${esc(k.kitchen_name)}</h1>
      <div class="meta">${esc(k.area || '')} · ${esc(cityName(k.city_id))}${k.rating_count ? ` · ★ ${k.rating} from ${k.rating_count}` : ''}</div>
      ${k.bio ? `<p style="margin:8px 0 0">${esc(k.bio)}</p>` : ''}
      <div class="tags">${k.is_open && k.accepts_instant ? '<span class="tag y">Ready-now dishes in 15 min</span>' : '<span class="tag">Pre-order for a later slot</span>'}
        ${k.available_days?.length ? `<span class="tag">Cooks ${k.available_days.map((d) => days[d]).join(', ')}</span>` : ''}</div>`;
    const groups = {};
    dishes.forEach((d) => (groups[d.category] ||= []).push(d));
    if (!dishes.length) h += '<div class="empty">No dishes listed today. Check back soon.</div>';
    for (const [cat, list] of Object.entries(groups)) {
      h += `<div class="sec-title" style="margin-top:22px">${esc(CATS[cat] || cat)}</div><div class="card" style="padding-block:0">`;
      h += list.map((d) => {
        const q = S.cart.cook === k.id ? S.cart.items[d.id] || 0 : 0;
        const sold = d.stock_left <= 0;
        return `<div class="dish ${sold ? 'sold' : ''}"><div style="min-width:0"><div class="n"><span class="veg ${d.is_veg ? '' : 'nv'}" title="${d.is_veg ? 'Veg' : 'Non-veg'}"></span>${esc(d.name)}</div>
          ${d.description ? `<div class="meta">${esc(d.description)}</div>` : ''}
          <div class="meta num">${rs(d.price)} · serves ${d.serves || 1}</div>
          <div class="tags"><span class="tag ${d.order_mode === 'pre' ? '' : 'y'}">${MODE[d.order_mode]}</span>${sold ? '<span class="tag r">Sold out</span>' : d.stock_left <= 5 ? `<span class="tag r">Only ${d.stock_left} left</span>` : ''}</div></div>
          ${q ? `<div class="step"><button data-dec="${d.id}" aria-label="Remove one">−</button><span>${q}</span><button data-inc="${d.id}" aria-label="Add one" ${q >= d.stock_left ? 'disabled' : ''}>+</button></div>`
              : `<button class="add" data-inc="${d.id}" ${sold ? 'disabled' : ''}>${sold ? 'Sold out' : 'Add'}</button>`}</div>`;
      }).join('');
      h += '</div>';
    }
    main.innerHTML = h;
    main.querySelectorAll('[data-inc]').forEach((b) => (b.onclick = () => change(b.dataset.inc, 1)));
    main.querySelectorAll('[data-dec]').forEach((b) => (b.onclick = () => change(b.dataset.dec, -1)));
    if (S.cart.cook === k.id) drawCartBar();
  };
  const change = (dishId, by) => {
    const d = dishes.find((x) => x.id === dishId);
    if (S.cart.cook && S.cart.cook !== k.id && cartCount()) { clearCart(); toast('Cart cleared. One kitchen per order.'); }
    S.cart.cook = k.id; S.cart.city = k.city_id; S.cart.kitchen = k.kitchen_name;
    const q = (S.cart.items[dishId] || 0) + by;
    if (q > d.stock_left) { toast(`Only ${d.stock_left} plates left today`); return; }
    if (q <= 0) delete S.cart.items[dishId]; else S.cart.items[dishId] = q;
    S.cart.info[dishId] = { name: d.name, price: +d.price, mode: d.order_mode, veg: d.is_veg };
    if (!cartCount()) clearCart();
    saveCart(); draw();
  };
  draw();
}

/* ---------- checkout ---------- */
function slots() {
  const now = new Date(), out = [];
  for (const dayOff of [0, 1, 2]) {
    for (const [label, hh, mm] of [['Lunch', 12, 30], ['Dinner', 20, 0]]) {
      const d = new Date(now); d.setDate(d.getDate() + dayOff); d.setHours(hh, mm, 0, 0);
      if (d - now < 3 * 3600e3) continue;   // cooks need time to shop and cook
      const day = dayOff === 0 ? 'Today' : dayOff === 1 ? 'Tomorrow' : d.toLocaleDateString('en-IN', { weekday: 'long' });
      out.push({ key: d.toISOString(), label: `${day} ${label.toLowerCase()}, ${label === 'Lunch' ? '12:30 to 1:30 pm' : '8 to 9 pm'}`, at: d });
    }
  }
  return out.slice(0, 4);
}
async function viewCheckout() {
  if (!cartCount()) { main.innerHTML = '<div class="empty"><div class="big">Your cart is empty</div><a href="#">Find a kitchen</a></div>'; return; }
  if (!S.me) { S.afterSignIn = '#checkout'; return viewSignIn('Sign in to order', "Enter your email. We'll send a sign-in link and code. Your cart stays as it is."); }
  loading();
  const { data: k } = await sb.from('cooks').select('id,kitchen_name,city_id,is_open,accepts_instant').eq('id', S.cart.cook).maybeSingle();
  if (!k) { clearCart(); main.innerHTML = '<div class="empty">This kitchen is no longer available.</div>'; return; }
  const sl = slots();
  if (!S.slot || !sl.find((s) => s.key === S.slot)) S.slot = sl[0]?.key;
  const draw = () => {
    const items = Object.entries(S.cart.items).map(([id, q]) => ({ id, q, ...S.cart.info[id] }));
    const allNow = items.every((i) => i.mode !== 'pre'), anyNowOnly = items.some((i) => i.mode === 'now');
    const canInstant = k.is_open && k.accepts_instant && allNow;
    const canLater = !anyNowOnly;
    if (S.mode === 'instant' && !canInstant) S.mode = 'scheduled';
    if (S.mode === 'scheduled' && !canLater && canInstant) S.mode = 'instant';
    const a = addr(), sub = cartTotal(), fee = FEES[S.mode], tot = sub + fee + FEES.platform;
    const wrongCity = a && a.city_id !== k.city_id;
    const why = !k.is_open ? 'Kitchen is closed right now' : !k.accepts_instant ? 'This kitchen only takes pre-orders' : 'Some items are pre-order only';
    main.innerHTML = `<button class="link" onclick="history.back()">← ${esc(k.kitchen_name)}</button>
      <h1 class="display" style="font-size:30px;margin:10px 0 14px">Your order</h1>
      <div class="stack">
      <div class="card"><div class="sec-title" style="margin-top:0">Deliver to ${S.addresses.length ? '<button class="link" id="chAddr">Change</button>' : ''}</div>
        ${a ? `<b>${esc(a.label)}</b> · ${esc(a.contact_name || '')}<div class="meta">${esc(a.line1)}, ${esc(a.area || '')}, ${esc(cityName(a.city_id))} ${esc(a.pincode || '')}</div>
               ${wrongCity ? `<div class="warn" style="margin-top:6px">This kitchen is in ${esc(cityName(k.city_id))} and doesn't deliver to ${esc(cityName(a.city_id))}.</div>` : ''}`
            : `<b>Add your delivery address</b><div class="meta" style="margin:2px 0 10px">Name, phone and address, once. We'll remember them.</div><button class="btn primary sm" id="newAddr">Add address</button>`}</div>
      <div class="card"><div class="sec-title" style="margin-top:0">Items</div>
        ${items.map((i) => `<div class="dish" style="padding:9px 0"><div><div class="n"><span class="veg ${i.veg ? '' : 'nv'}"></span>${esc(i.name)}</div><div class="meta num">${rs(i.price * i.q)} · ${MODE[i.mode]}</div></div>
          <div class="step"><button data-dec="${i.id}" aria-label="Remove one">−</button><span>${i.q}</span><button data-inc="${i.id}" aria-label="Add one">+</button></div></div>`).join('')}</div>
      <div class="card"><div class="sec-title" style="margin-top:0">When</div>
        <label class="opt ${S.mode === 'scheduled' ? 'on' : ''} ${canLater && sl.length ? '' : 'off'}"><input type="radio" name="mode" value="scheduled" ${S.mode === 'scheduled' ? 'checked' : ''} ${canLater && sl.length ? '' : 'disabled'}>
          <div><b>Pre-order a slot</b><div class="meta">${canLater ? 'Cooked fresh for your slot' : 'Some items are only available right now'}</div></div></label>
        ${S.mode === 'scheduled' ? `<div class="chips" style="margin:4px 0 8px 34px">${sl.map((s) => `<button class="chip ${s.key === S.slot ? 'on' : ''}" data-slot="${s.key}">${esc(s.label)}</button>`).join('')}</div>` : ''}
        <label class="opt ${S.mode === 'instant' ? 'on' : ''} ${canInstant ? '' : 'off'}"><input type="radio" name="mode" value="instant" ${S.mode === 'instant' ? 'checked' : ''} ${canInstant ? '' : 'disabled'}>
          <div><b>Now, in 15 to 30 min</b><div class="meta">${canInstant ? "From what the cook has ready today" : why}</div></div></label></div>
      <div class="card"><label class="f" for="note" style="margin-top:0">Note for the cook (optional)</label>
        <input id="note" maxlength="200" placeholder="Less spicy please, no onion…" value="${esc(S.note)}"></div>
      <div class="card"><div class="sec-title" style="margin-top:0">Bill</div>
        <div class="row"><span>Items</span><span>${rs(sub)}</span></div><div class="row"><span>Delivery</span><span>${rs(fee)}</span></div>
        <div class="row"><span>Platform fee</span><span>${rs(FEES.platform)}</span></div><div class="row tot"><span>To pay</span><span>${rs(tot)}</span></div>
        <div class="meta" style="margin-top:8px">Pay the rider by cash or UPI when your food arrives.</div></div>
      <button class="btn primary block" id="place" ${!a || wrongCity ? 'disabled' : ''}>Place order · ${rs(tot)}</button>
      </div>`;
    $('#chAddr')?.addEventListener('click', () => openPlaces(true));
    $('#newAddr')?.addEventListener('click', () => openAddressEditor(null, () => draw()));
    $('#note').oninput = (e) => (S.note = e.target.value);
    main.querySelectorAll('input[name=mode]').forEach((r) => (r.onchange = () => { S.mode = r.value; draw(); }));
    main.querySelectorAll('[data-slot]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); S.slot = b.dataset.slot; draw(); }));
    main.querySelectorAll('[data-inc],[data-dec]').forEach((b) => (b.onclick = () => {
      const id = b.dataset.inc || b.dataset.dec, q = (S.cart.items[id] || 0) + (b.dataset.inc ? 1 : -1);
      if (q <= 0) delete S.cart.items[id]; else S.cart.items[id] = q;
      if (!cartCount()) { clearCart(); location.hash = '#k-' + k.id; return; }
      saveCart(); draw();
    }));
    $('#place').onclick = (e) => guard(e.currentTarget, async () => {
      const r = await rpc('place_order', {
        p_cook: k.id, p_items: Object.entries(S.cart.items).map(([dish_id, qty]) => ({ dish_id, qty })),
        p_type: S.mode, p_scheduled_for: S.mode === 'scheduled' ? S.slot : null,
        p_slot: S.mode === 'scheduled' ? sl.find((s) => s.key === S.slot)?.label : 'Now', p_address: a.id, p_note: S.note,
      });
      clearCart(); S.note = '';
      toast(`Order #${r.order_no} sent to ${k.kitchen_name}`);
      location.hash = '#order-' + r.id;
    });
  };
  S._redrawCheckout = draw;
  draw();
}

/* ---------- order tracking ---------- */
async function viewOrder(id) {
  if (!S.me) { S.afterSignIn = '#order-' + id; return viewSignIn(); }
  loading();
  let code = null, map = null, mk = {};
  const load = async () => {
    const all = await rpc('my_orders', { p_as: 'customer' });
    const o = all.find((x) => x.id === id);
    if (!o) { main.innerHTML = '<div class="empty"><div class="big">Order not found</div><a href="#">Home</a></div>'; return; }
    if (o.delivery && !['delivered'].includes(o.status) && !code) code = await rpc('my_code', { p_order: id }).catch(() => null);
    draw(o);
  };
  const draw = (o) => {
    const idx = STEPS.indexOf(o.status), d = o.delivery, dr = o.drop || {}, kt = o.kitchen;
    const stopped = ['cancelled', 'rejected'].includes(o.status);
    const keepMap = map && $('#trackmap');
    let h = `<a class="link" href="#">← Home</a>
      <h1 class="display" style="font-size:30px;margin:10px 0 2px">Order #${o.order_no}</h1>
      <div class="meta">${esc(kt.name)} · ${o.type === 'instant' ? 'Now' : esc(o.slot || dayTime(o.scheduled_for))}</div>
      <div class="stack" style="margin-top:14px">`;
    if (stopped) h += `<div class="banner red"><b>${esc(STATUS[o.status])}</b><div class="meta">${o.status === 'rejected' ? "The cook couldn't take this one. You haven't been charged." : 'This order was cancelled.'}</div></div>`;
    else {
      h += `<div id="trackmap" class="map"></div>`;
      h += `<div class="card"><ol class="track">${STEPS.map((s, i) => `<li class="${i < idx || o.status === 'delivered' ? 'done' : i === idx ? 'now' : ''}"><span class="dot"></span><span>${esc(STATUS[s])}</span><span class="when">${i === 0 ? time(o.created_at) : s === 'picked_up' ? time(d?.picked_up_at) : s === 'delivered' ? time(d?.delivered_at) : ''}</span></li>`).join('')}</ol></div>`;
      if (d && d.rider_name && o.status !== 'delivered') h += `<div class="card"><div class="sec-title" style="margin-top:0">Your rider</div><b>${esc(d.rider_name)}</b>${d.rider_phone ? ` · <span class="num">+91 ${esc(d.rider_phone)}</span>` : ''}
        ${code ? `<div class="meta" style="margin-top:10px">Share this code at your door, only when you have your food</div><div class="otp">${esc(code)}</div>` : ''}</div>`;
      else if (d && !d.rider_name && o.status !== 'delivered') h += `<div class="card"><b>Finding a rider near the kitchen…</b><div class="meta">Usually a few minutes.</div></div>`;
      if (o.status === 'delivered') h += `<div class="card"><div class="sec-title" style="margin-top:0">How was it?</div>
        <div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-star="${n}" class="${(o.stars || 0) >= n ? 'on' : ''}" ${o.stars ? 'disabled' : ''} aria-label="${n} stars">★</button>`).join('')}</div>
        ${o.stars ? `<div class="meta">Thanks! Your rating helps ${esc(kt.cook_name || 'the cook')}.</div>` : ''}</div>`;
    }
    h += `<div class="card"><div class="sec-title" style="margin-top:0">Items</div>${o.items.map((i) => `<div class="row"><span>${i.qty} × ${esc(i.name)}</span><span>${rs(i.qty * i.price)}</span></div>`).join('')}
      <div class="row"><span>Delivery + platform</span><span>${rs(+o.delivery_fee + +o.platform_fee)}</span></div>
      <div class="row tot"><span>${o.status === 'delivered' ? 'Paid' : 'To pay on delivery'}</span><span>${rs(o.grand_total)}</span></div>
      <div class="meta" style="margin-top:8px">To ${esc(dr.label || '')}: ${esc(dr.line1 || '')}, ${esc(dr.area || '')}</div></div>`;
    if (o.status === 'placed') h += `<button class="btn danger block" id="cancel">Cancel order</button>`;
    h += '</div>';
    // keep the existing map element alive between refreshes
    const old = keepMap ? $('#trackmap') : null;
    main.innerHTML = h;
    if (old && $('#trackmap')) $('#trackmap').replaceWith(old);
    if (!stopped && $('#trackmap')) {
      if (!map) {
        const c = [kt.lat || dr.lat || S.city?.lat, kt.lng || dr.lng || S.city?.lng];
        map = makeMap($('#trackmap'), c[0], c[1], 13); trackMap = map;
        if (kt.lat) mk.k = marker(map, kt.lat, kt.lng, 'K', 'k', { title: 'Kitchen (approximate)' });
        if (dr.lat) mk.h = marker(map, dr.lat, dr.lng, 'H', 'h', { title: 'Your address' });
        const pts = [mk.k, mk.h].filter(Boolean).map((m) => m.getLatLng());
        if (pts.length > 1) map.fitBounds(window.L.latLngBounds(pts).pad(0.5));
      }
      if (d?.rider_lat && ['ready', 'picked_up'].includes(o.status)) {
        if (mk.r) mk.r.setLatLng([d.rider_lat, d.rider_lng]); else mk.r = riderDot(map, d.rider_lat, d.rider_lng);
      }
    }
    main.querySelectorAll('[data-star]').forEach((b) => (b.onclick = () => guard(null, async () => {
      const { error } = await sb.from('reviews').insert({ order_id: o.id, cook_id: kt.id, customer_id: S.me.id, stars: +b.dataset.star });
      if (error) throw error; toast('Thanks for rating'); load();
    })));
    $('#cancel')?.addEventListener('click', (e) => guard(e.currentTarget, async () => { await rpc('cancel_my_order', { p_order: o.id }); toast('Order cancelled'); load(); }));
  };
  try { await load(); } catch (e) { main.innerHTML = `<div class="empty">${esc(errMsg(e))}</div>`; return; }
  liveSub = onOrderChanges(() => load().catch(() => {}));
  pollTimer = setInterval(() => { if (document.visibilityState === 'visible') load().catch(() => {}); }, 15000);
}

/* ---------- account ---------- */
async function viewAccount() {
  if (!S.me) { location.hash = '#signin'; return; }
  loading();
  S.me = await me();
  const orders = await rpc('my_orders', { p_as: 'customer' }).catch(() => []);
  const m = S.me;
  main.innerHTML = `<h1 class="display" style="font-size:30px;margin-bottom:14px">My account</h1><div class="stack">
    <div class="card"><div class="sec-title" style="margin-top:0">Profile</div>
      <label class="f" for="pName" style="margin-top:0">Name</label><input id="pName" autocomplete="name" value="${esc(m.full_name || '')}" placeholder="Your full name">
      <label class="f" for="pPhone">Mobile number</label><div class="pfx"><span>+91</span><input id="pPhone" type="tel" inputmode="numeric" maxlength="10" value="${esc(m.phone || '')}" placeholder="98xxxxxxxx"></div>
      <div class="meta" style="margin-top:4px">${m.phone ? (m.phone_verified ? '<span class="ok">✓ Verified</span>' : 'Not verified yet. Phone verification is coming soon.') : 'Riders use this to call you at the door.'}</div>
      <label class="f">Email</label><div class="row"><b style="overflow:hidden;text-overflow:ellipsis">${esc(m.email || '')}</b>${m.email_verified ? '<span class="ok">✓ Verified</span>' : '<span class="meta">Verifies when you use the email link</span>'}</div>
      <button class="btn block" id="saveP" style="margin-top:12px">Save profile</button></div>
    <div class="card"><div class="sec-title" style="margin-top:0">Saved addresses <button class="link" id="addA">Add</button></div>
      ${S.addresses.map((a) => `<div class="row" style="align-items:center;padding:7px 0;border-bottom:1px solid var(--line)"><span><b>${esc(a.label)}</b><span class="meta" style="display:block">${esc(a.line1)}, ${esc(a.area || '')}, ${esc(cityName(a.city_id))}</span></span>
        <span style="display:flex;gap:10px"><button class="link" data-edit="${a.id}">Edit</button><button class="link" data-del="${a.id}" style="color:var(--muted)">Remove</button></span></div>`).join('') || '<div class="meta">None yet. You\'ll add one when you order.</div>'}</div>
    <div class="card"><div class="sec-title" style="margin-top:0">Past orders</div>
      ${orders.map((o) => `<a href="#order-${o.id}" class="row" style="text-decoration:none;color:inherit;padding:8px 0;border-bottom:1px solid var(--line)"><span><b>#${o.order_no}</b> · ${esc(o.kitchen.name)}<span class="meta" style="display:block">${dayTime(o.created_at)} · ${esc(STATUS[o.status])}</span></span><span>${rs(o.grand_total)}</span></a>`).join('') || '<div class="meta">No orders yet.</div>'}</div>
    <div class="card"><div class="sec-title" style="margin-top:0">Work with Gharowa</div>
      <div class="row-btns" style="margin-top:0"><a class="btn" href="cook.html">${m.cook ? 'My kitchen' : 'Cook with us'}</a><a class="btn" href="rider.html">${m.rider ? 'Rider app' : 'Ride with us'}</a></div>
      ${m.is_admin ? '<a class="btn block" href="admin.html" style="margin-top:8px">Admin</a>' : ''}</div>
    <button class="btn danger block" id="out">Sign out</button></div>`;
  $('#pPhone').oninput = (e) => (e.target.value = e.target.value.replace(/\D/g, ''));
  $('#saveP').onclick = (e) => guard(e.currentTarget, async () => {
    const name = $('#pName').value.trim(), phone = $('#pPhone').value.trim();
    if (name.length < 2) throw new Error('Enter your full name');
    if (phone && !isPhone(phone)) throw new Error('Enter a 10-digit Indian mobile number');
    await rpc('set_my_profile', { p_name: name, p_phone: phone }); S.me = await me(); drawTop(); toast('Profile saved');
  });
  $('#addA').onclick = () => openAddressEditor(null, viewAccount);
  main.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => openAddressEditor(S.addresses.find((a) => a.id === b.dataset.edit), viewAccount)));
  main.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => guard(b, async () => {
    const { error } = await sb.from('addresses').delete().eq('id', b.dataset.del); if (error) throw error;
    S.addresses = S.addresses.filter((a) => a.id !== b.dataset.del); if (S.addrSel === b.dataset.del) pickDefaultAddress();
    drawTop(); toast('Address removed'); viewAccount();
  })));
  $('#out').onclick = signOut;
}

function viewSignIn(title, sub) {
  if (S.me) { location.hash = ''; return; }
  main.innerHTML = '<div id="si"></div>';
  renderSignIn($('#si'), { title, sub, onDone: async () => { await loadUser(); toast('Signed in'); if (location.hash === '#signin') location.hash = ''; else route(); } });
}

/* ---------- sheets: places & address editor ---------- */
function sheet(html) {
  const bg = document.createElement('div'); bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  document.body.append(bg);
  const close = () => bg.remove();
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  bg.querySelector('.x')?.addEventListener('click', close);
  document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', k); } });
  return { el: bg.firstElementChild, close };
}
function openPlaces(fromCheckout) {
  const s = sheet(`<div class="hd"><h2 class="display" style="font-size:24px">Deliver to</h2><button class="x" aria-label="Close">×</button></div>
    ${S.addresses.map((a) => `<button class="addr ${a.id === S.addrSel ? 'on' : ''}" data-a="${a.id}" style="margin-bottom:8px"><span class="ic">${esc(a.label[0])}</span><span class="grow"><b>${esc(a.label)}</b><span class="meta" style="display:block">${esc(a.line1)}, ${esc(a.area || '')}, ${esc(cityName(a.city_id))} ${esc(a.pincode || '')}</span></span></button>`).join('')}
    ${S.me ? '<button class="btn primary block" id="pNew" style="margin:6px 0 14px">Add a new address</button>' : '<a class="btn primary block" href="#signin" id="pIn" style="margin:6px 0 14px">Sign in to use saved addresses</a>'}
    <div class="sec-title">Or just browse a city</div>
    <div class="chips">${S.cities.map((c) => `<button class="chip ${c.id === S.city?.id && !addr() ? 'on' : ''}" data-c="${c.id}">${esc(c.name)}</button>`).join('')}</div>`);
  s.el.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => {
    S.addrSel = b.dataset.a; store.set('addrSel', S.addrSel);
    const a = addr(); S.city = S.cities.find((c) => c.id === a.city_id); store.set('cityId', S.city.id);
    s.close(); drawTop(); fromCheckout && S._redrawCheckout ? S._redrawCheckout() : route();
  }));
  s.el.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => { S.addrSel = null; store.set('addrSel', null); s.close(); setCity(+b.dataset.c); }));
  s.el.querySelector('#pNew')?.addEventListener('click', () => { s.close(); openAddressEditor(null, fromCheckout ? S._redrawCheckout : route); });
  s.el.querySelector('#pIn')?.addEventListener('click', () => s.close());
}
async function openAddressEditor(a, after) {
  if (!S.me) { location.hash = '#signin'; return; }
  const start = a?.lat ? { lat: a.lat, lng: a.lng } : S.loc || (S.city ? { lat: S.city.lat, lng: S.city.lng } : { lat: 12.9716, lng: 77.5946 });
  const f = {
    label: a?.label || (S.addresses.some((x) => x.label === 'Home') ? 'Work' : 'Home'),
    contact_name: a?.contact_name || S.me.full_name || '', contact_phone: a?.contact_phone || S.me.phone || '',
    line1: a?.line1 || '', area: a?.area || '', pincode: a?.pincode || '', lat: start.lat, lng: start.lng,
    city_id: a?.city_id || nearestCity(S.cities, start.lat, start.lng)?.id || S.city?.id || S.cities[0].id,
  };
  const s = sheet(`<div class="hd"><h2 class="display" style="font-size:24px">${a ? 'Edit address' : 'Add address'}</h2><button class="x" aria-label="Close">×</button></div>
    <div id="amap" class="map"></div><div class="meta" style="margin:6px 2px">Drag the map pin onto your building.</div>
    <button class="btn block" id="aLoc">Use my current location</button>
    <div class="sec-title" style="margin-top:16px">Who's receiving</div>
    <div class="grid2"><div><label class="f" for="aName" style="margin-top:0">Full name</label><input id="aName" autocomplete="name" value="${esc(f.contact_name)}"></div>
      <div><label class="f" for="aPhone" style="margin-top:0">Mobile</label><input id="aPhone" type="tel" inputmode="numeric" maxlength="10" value="${esc(f.contact_phone)}" placeholder="98xxxxxxxx"></div></div>
    <div class="sec-title" style="margin-top:16px">Address</div>
    <div class="chips">${['Home', 'Work', 'Other'].map((l) => `<button class="chip ${l === f.label ? 'on' : ''}" data-l="${l}">${l}</button>`).join('')}</div>
    <label class="f" for="aLine">Flat, building, street</label><input id="aLine" value="${esc(f.line1)}" placeholder="Flat 402, Prestige Ferns, 5th Cross">
    <label class="f" for="aArea">Area</label><input id="aArea" value="${esc(f.area)}">
    <div class="grid2"><div><label class="f" for="aPin">Pin code</label><input id="aPin" inputmode="numeric" maxlength="6" value="${esc(f.pincode)}"></div>
      <div><label class="f" for="aCity">City</label><select id="aCity">${S.cities.map((c) => `<option value="${c.id}" ${c.id === f.city_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div></div>
    <button class="btn primary block" id="aSave" style="margin-top:16px">Save address</button>`);
  const map = makeMap($('#amap', s.el), f.lat, f.lng, 17);
  const pin = marker(map, f.lat, f.lng, 'H', 'h', { draggable: true });
  const fill = async (lat, lng, force) => {
    f.lat = lat; f.lng = lng;
    const c = nearestCity(S.cities, lat, lng); if (c) { f.city_id = c.id; $('#aCity', s.el).value = c.id; }
    const g = await reverseGeocode(lat, lng);
    if (g.area && (force || !$('#aArea', s.el).value)) $('#aArea', s.el).value = g.area;
    if (g.pincode && (force || !$('#aPin', s.el).value)) $('#aPin', s.el).value = g.pincode;
    if (g.road && !$('#aLine', s.el).value) $('#aLine', s.el).placeholder = 'Flat / house no., ' + g.road;
  };
  pin.on('dragend', () => { const p = pin.getLatLng(); fill(p.lat, p.lng, true); });
  map.on('click', (e) => { pin.setLatLng(e.latlng); fill(e.latlng.lat, e.latlng.lng, true); });
  if (!a) fill(f.lat, f.lng, false);
  $('#aLoc', s.el).onclick = (e) => guard(e.currentTarget, async () => {
    const p = await locate(10000); if (!p) throw new Error('Allow location access in your browser, or drag the pin');
    S.loc = p; map.setView([p.lat, p.lng], 17); pin.setLatLng([p.lat, p.lng]); await fill(p.lat, p.lng, true);
  });
  s.el.querySelectorAll('[data-l]').forEach((b) => (b.onclick = () => { f.label = b.dataset.l; s.el.querySelectorAll('[data-l]').forEach((x) => x.classList.toggle('on', x === b)); }));
  ['aPhone', 'aPin'].forEach((id) => ($('#' + id, s.el).oninput = (e) => (e.target.value = e.target.value.replace(/\D/g, ''))));
  $('#aSave', s.el).onclick = (e) => guard(e.currentTarget, async () => {
    const v = (id) => $('#' + id, s.el).value.trim();
    const row = { user_id: S.me.id, label: f.label, contact_name: v('aName'), contact_phone: v('aPhone'), line1: v('aLine'), area: v('aArea'),
      pincode: v('aPin'), city_id: +v('aCity'), lat: f.lat, lng: f.lng };
    if (row.contact_name.length < 2) throw new Error('Enter the name of the person receiving');
    if (!isPhone(row.contact_phone)) throw new Error('Enter a 10-digit mobile number');
    if (row.line1.length < 4) throw new Error('Add your flat, building and street');
    if (!/^\d{6}$/.test(row.pincode)) throw new Error('Enter a 6-digit pin code');
    const c = S.cities.find((x) => x.id === row.city_id);
    if (distKm(c.lat, c.lng, row.lat, row.lng) > 80) throw new Error(`The pin is far from ${c.name}. Move it onto your building.`);
    const q = a ? sb.from('addresses').update(row).eq('id', a.id).select().single() : sb.from('addresses').insert(row).select().single();
    const { data, error } = await q; if (error) throw error;
    S.addresses = a ? S.addresses.map((x) => (x.id === a.id ? data : x)) : [...S.addresses, data];
    S.addrSel = data.id; store.set('addrSel', data.id); S.city = c; store.set('cityId', c.id);
    // First address fills in a missing name or phone on the profile
    if (!S.me.full_name || !S.me.phone) { await rpc('set_my_profile', { p_name: S.me.full_name || row.contact_name, p_phone: S.me.phone || row.contact_phone }).catch(() => {}); S.me = await me(); }
    s.close(); drawTop(); toast('Address saved');
    after ? after() : route();
  });
}

boot();
