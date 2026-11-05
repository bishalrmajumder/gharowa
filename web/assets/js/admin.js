// Admin: approve kitchens and riders, rescue unassigned deliveries, settle rider payouts.
import { sb, $, esc, rs, dayTime, toast, rpc, guard, errMsg, me, session, renderSignIn, signOut, STATUS } from './core.js';

const main = $('#main');
const S = { me: null, data: null, tab: 'today' };
let timer = null;

async function start() {
  const s = await session();
  S.me = s ? await me() : null;
  if (!S.me) { main.innerHTML = '<div id="si"></div>'; renderSignIn($('#si'), { title: 'Admin sign-in', sub: 'Use your admin email.', onDone: start }); return; }
  if (!S.me.is_admin) { main.innerHTML = `<div class="empty"><div class="big">Admins only</div>${esc(S.me.email)} isn't an admin account.<br><br><button class="btn" id="out">Sign out</button></div>`; $('#out').onclick = signOut; return; }
  await load();
  clearInterval(timer); timer = setInterval(() => { if (document.visibilityState === 'visible' && !document.activeElement?.matches('input,select')) load(true); }, 20000);
}
async function load(quiet) {
  try { S.data = await rpc('admin_overview'); } catch (e) { if (!quiet) main.innerHTML = `<div class="empty">${esc(errMsg(e))}</div>`; return; }
  draw();
}
function draw() {
  const D = S.data, st = D.stats;
  const pendingCooks = D.cooks.filter((c) => !c.approved).length, pendingRiders = D.riders.filter((r) => !r.approved).length;
  const pendingPay = D.payouts.filter((p) => ['requested', 'processing'].includes(p.status)).length;
  const tabs = [['today', 'Orders'], ['cooks', `Kitchens${pendingCooks ? ' · ' + pendingCooks : ''}`], ['riders', `Riders${pendingRiders ? ' · ' + pendingRiders : ''}`], ['pay', `Payouts${pendingPay ? ' · ' + pendingPay : ''}`]];
  let h = `<div class="stat" style="margin-bottom:16px"><div><b>${st.orders_today}</b><span>Orders today</span></div><div><b>${rs(st.gmv_today)}</b><span>Order value today</span></div>
    <div><b>${st.customers}</b><span>Accounts</span></div><div><b style="color:${st.waiting_for_rider ? 'var(--alta)' : 'inherit'}">${st.waiting_for_rider}</b><span>Waiting for a rider</span></div></div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${S.tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>`;
  if (S.tab === 'today') {
    const riders = D.riders.filter((r) => r.approved);
    h += `<div class="table-wrap"><table><thead><tr><th>#</th><th>When</th><th>Kitchen</th><th>City</th><th>Status</th><th>Delivery</th><th>Total</th></tr></thead><tbody>
      ${D.orders.map((o) => `<tr><td class="num">${o.order_no}</td><td>${dayTime(o.created_at)}</td><td>${esc(o.kitchen)}</td><td>${esc(o.city)}</td><td>${esc(STATUS[o.status])}</td>
        <td>${o.delivery === 'searching' ? `<select data-assign="${o.id}" aria-label="Assign a rider"><option value="">Assign rider…</option>${riders.filter((r) => r.city === o.city).map((r) => `<option value="${r.id}">${esc(r.name)}${r.online ? ' (online)' : ''}</option>`).join('')}</select>` : esc(o.delivery ? `${o.delivery}${o.rider ? ' · ' + o.rider : ''}` : '–')}</td>
        <td class="num">${rs(o.total)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No orders yet.</td></tr>'}</tbody></table></div>`;
  }
  if (S.tab === 'cooks') {
    h += `<div class="table-wrap"><table><thead><tr><th>Kitchen</th><th>Cook</th><th>City / area</th><th>Pickup address</th><th>FSSAI</th><th>Dishes</th><th></th></tr></thead><tbody>
      ${D.cooks.map((c) => `<tr><td><b>${esc(c.kitchen)}</b><div class="fine">${dayTime(c.created_at)}</div></td><td>${esc(c.cook || '')}<div class="fine">${esc(c.email || '')}<br>${esc(c.phone || '')}</div></td>
        <td>${esc(c.city)}<div class="fine">${esc(c.area || '')}</div></td><td>${esc(c.address || '')}</td><td>${esc(c.fssai || '–')}</td><td class="num">${c.dishes}</td>
        <td>${c.approved ? `<span class="ok">Live</span><br><button class="link" data-ap="cook|${c.id}|0">Pause</button>` : `<button class="btn leaf sm" data-ap="cook|${c.id}|1">Approve</button>`}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No kitchens yet.</td></tr>'}</tbody></table></div>`;
  }
  if (S.tab === 'riders') {
    h += `<div class="table-wrap"><table><thead><tr><th>Rider</th><th>City</th><th>Vehicle</th><th>Status</th><th>Wallet</th><th>UPI</th><th></th></tr></thead><tbody>
      ${D.riders.map((r) => `<tr><td><b>${esc(r.name || '')}</b><div class="fine">${esc(r.email || '')}<br>${esc(r.phone || '')}</div></td><td>${esc(r.city)}</td><td>${esc(r.vehicle)}</td>
        <td>${r.online ? '<span class="ok">Online</span>' : 'Offline'}<div class="fine">${r.last_seen ? 'seen ' + dayTime(r.last_seen) : ''}</div></td><td class="num">${rs(r.wallet)}</td><td>${esc(r.upi || '–')}</td>
        <td>${r.approved ? `<span class="ok">Approved</span><br><button class="link" data-ap="rider|${r.id}|0">Suspend</button>` : `<button class="btn leaf sm" data-ap="rider|${r.id}|1">Approve</button>`}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No riders yet.</td></tr>'}</tbody></table></div>`;
  }
  if (S.tab === 'pay') {
    h += `<p class="muted" style="margin-top:0">Send the amount by UPI from your bank app, then enter the reference (UTR) here. Marking failed puts the money back in the rider's wallet.</p>
      <div class="table-wrap"><table><thead><tr><th>Requested</th><th>Rider</th><th>UPI ID</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>
      ${D.payouts.map((p) => `<tr><td>${dayTime(p.created_at)}</td><td>${esc(p.rider || '')}</td><td><b>${esc(p.upi)}</b></td><td class="num"><b>${rs(p.amount)}</b></td>
        <td>${p.status === 'paid' ? `<span class="ok">Paid</span><div class="fine">${esc(p.utr || '')}</div>` : p.status === 'failed' ? '<span class="warn">Failed</span>' : 'To send'}</td>
        <td>${['requested', 'processing'].includes(p.status) ? `<div style="display:flex;gap:6px;min-width:260px"><input data-utr="${p.id}" placeholder="UTR / reference" style="flex:1"><button class="btn leaf sm" data-paid="${p.id}">Paid</button><button class="btn sm" data-fail="${p.id}">Failed</button></div>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No payout requests.</td></tr>'}</tbody></table></div>`;
  }
  main.innerHTML = h;
  main.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; draw(); }));
  main.querySelectorAll('[data-ap]').forEach((b) => (b.onclick = () => guard(b, async () => {
    const [kind, id, ok] = b.dataset.ap.split('|');
    await rpc('admin_set_approval', { p_kind: kind, p_id: id, p_ok: ok === '1' }); toast(ok === '1' ? 'Approved' : 'Paused'); load(true);
  })));
  main.querySelectorAll('[data-assign]').forEach((s) => (s.onchange = () => s.value && guard(null, async () => {
    await rpc('admin_assign_rider', { p_order: s.dataset.assign, p_rider: s.value }); toast('Rider assigned'); load(true);
  })));
  main.querySelectorAll('[data-paid],[data-fail]').forEach((b) => (b.onclick = () => guard(b, async () => {
    const id = b.dataset.paid || b.dataset.fail, utr = main.querySelector(`[data-utr="${id}"]`)?.value.trim();
    if (b.dataset.paid && !utr) throw new Error('Enter the UPI reference (UTR) first');
    await rpc('admin_mark_payout', { p_id: id, p_utr: utr || null, p_paid: !!b.dataset.paid }); toast(b.dataset.paid ? 'Marked paid' : 'Marked failed, money returned to wallet'); load(true);
  })));
}

sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_IN' || ev === 'SIGNED_OUT') start(); });
start().catch((e) => { main.innerHTML = `<div class="empty">${esc(errMsg(e))}</div>`; });
