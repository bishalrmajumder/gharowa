-- =====================================================================
-- GHAROWA — 002: server functions for the website
-- Everything that changes money, stock or order state goes through
-- these functions, so the browser can never fake a total, skip a
-- pickup code or approve itself.
-- =====================================================================
begin;

-- ---------- Small schema additions ----------
alter table public.cities add column if not exists lat double precision;
alter table public.cities add column if not exists lng double precision;
update public.cities set lat = 12.9716, lng = 77.5946 where name = 'Bangalore';
update public.cities set lat = 13.0827, lng = 80.2707 where name = 'Chennai';
update public.cities set lat = 28.4595, lng = 77.0266 where name = 'Gurgaon';
update public.cities set lat = 17.3850, lng = 78.4867 where name = 'Hyderabad';

alter table public.riders add column if not exists is_approved boolean not null default false;
alter table public.riders add column if not exists phone text;

alter table public.orders add column if not exists payment_method text not null default 'cod';
alter table public.orders add column if not exists slot_label text;
alter table public.orders add column if not exists drop_snapshot jsonb;   -- address frozen at order time

-- Orders keep working if a customer later deletes the address
alter table public.orders drop constraint if exists orders_address_id_fkey;
alter table public.orders add constraint orders_address_id_fkey
  foreign key (address_id) references public.addresses (id) on delete set null;

-- Pickup / drop codes live in their own locked table (no policies = no direct access)
create table if not exists public.delivery_codes (
  order_id   uuid primary key references public.orders (id) on delete cascade,
  pickup_otp text not null default lpad((floor(random()*10000))::int::text, 4, '0'),
  drop_otp   text not null default lpad((floor(random()*10000))::int::text, 4, '0')
);
alter table public.delivery_codes enable row level security;
alter table public.deliveries drop column if exists pickup_otp;
alter table public.deliveries drop column if exists drop_otp;

-- Admins (by sign-in email)
create table if not exists public.app_admins (email text primary key);
alter table public.app_admins enable row level security;
insert into public.app_admins (email) values ('brmcomid@gmail.com') on conflict do nothing;

-- ---------- Helpers ----------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins a
                 join auth.users u on lower(u.email) = lower(a.email)
                 where u.id = auth.uid())
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin');
$$;

create or replace function public.city_id_by_name(p_name text)
returns smallint language sql stable security definer set search_path = '' as $$
  select id from public.cities where lower(name) = lower(trim(p_name)) and is_live;
$$;

-- Keep verified flags in step with Supabase Auth
create or replace function public.sync_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set
    email = coalesce(new.email, email),
    email_verified = new.email_confirmed_at is not null,
    phone_verified = case when new.phone is not null and new.phone_confirmed_at is not null then true else phone_verified end
  where id = new.id;
  return new;
end $$;
drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update of email, email_confirmed_at, phone, phone_confirmed_at on auth.users
  for each row execute function public.sync_auth_user();

-- Dispatch: only approved riders, stamp the rider fee, create the codes
create or replace function public.dispatch_on_ready()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_cook public.cooks%rowtype; v_rider uuid;
begin
  if new.status = 'ready' and old.status is distinct from 'ready' then
    select * into v_cook from public.cooks where id = new.cook_id;
    select r.id into v_rider from public.riders r
    where r.city_id = new.city_id and r.is_online and r.is_approved
      and not exists (select 1 from public.deliveries d
                      where d.rider_id = r.id and d.status in ('assigned','at_pickup','picked_up'))
    order by ((r.current_lat - v_cook.lat)^2 + (r.current_lng - v_cook.lng)^2) nulls last
    limit 1;
    insert into public.deliveries (order_id, rider_id, status, assigned_at, cost)
    values (new.id, v_rider,
            case when v_rider is null then 'searching'::public.delivery_status else 'assigned'::public.delivery_status end,
            case when v_rider is null then null else now() end, 40)
    on conflict (order_id) do nothing;
    insert into public.delivery_codes (order_id) values (new.id) on conflict do nothing;
  end if;
  return new;
end $$;

-- ---------- Profile ----------
create or replace function public.me()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'full_name', p.full_name, 'phone', p.phone, 'email', p.email,
    'phone_verified', p.phone_verified, 'email_verified', p.email_verified,
    'is_admin', public.is_admin(),
    'cook', (select to_jsonb(c) - 'fssai_verified' || jsonb_build_object('city', ci.name)
             from public.cooks c join public.cities ci on ci.id = c.city_id where c.id = p.id),
    'rider', (select to_jsonb(r) || jsonb_build_object('city', ci.name)
              from public.riders r join public.cities ci on ci.id = r.city_id where r.id = p.id))
  from public.profiles p where p.id = auth.uid();
$$;

create or replace function public.set_my_profile(p_name text, p_phone text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_phone is not null and p_phone <> '' and p_phone !~ '^[6-9][0-9]{9}$' then
    raise exception 'Enter a 10-digit Indian mobile number';
  end if;
  update public.profiles set
    full_name = coalesce(nullif(trim(p_name), ''), full_name),
    phone_verified = case when nullif(p_phone, '') is distinct from phone then false else phone_verified end,
    phone = coalesce(nullif(p_phone, ''), phone)
  where id = auth.uid();
end $$;

-- ---------- Cook & rider sign-up ----------
create or replace function public.register_cook(
  p_kitchen text, p_bio text, p_region text, p_city text, p_area text,
  p_pickup_address text, p_lat double precision, p_lng double precision, p_fssai text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_city smallint := public.city_id_by_name(p_city);
begin
  if auth.uid() is null then raise exception 'Please sign in first'; end if;
  if v_city is null then raise exception 'We are not live in % yet', p_city; end if;
  if length(trim(coalesce(p_kitchen, ''))) < 3 then raise exception 'Give your kitchen a name'; end if;
  if length(trim(coalesce(p_pickup_address, ''))) < 8 then raise exception 'Add your full pickup address'; end if;
  insert into public.cooks (id, kitchen_name, bio, home_region, city_id, area, pickup_address, lat, lng, fssai_number)
  values (auth.uid(), trim(p_kitchen), p_bio, p_region, v_city, p_area, trim(p_pickup_address), p_lat, p_lng, nullif(trim(p_fssai), ''))
  on conflict (id) do update set kitchen_name = excluded.kitchen_name, bio = excluded.bio, home_region = excluded.home_region,
    city_id = excluded.city_id, area = excluded.area, pickup_address = excluded.pickup_address,
    lat = excluded.lat, lng = excluded.lng, fssai_number = excluded.fssai_number;
end $$;

create or replace function public.register_rider(p_city text, p_vehicle text, p_phone text, p_upi text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_city smallint := public.city_id_by_name(p_city);
begin
  if auth.uid() is null then raise exception 'Please sign in first'; end if;
  if v_city is null then raise exception 'We are not live in % yet', p_city; end if;
  if coalesce(p_phone, '') !~ '^[6-9][0-9]{9}$' then raise exception 'Enter a 10-digit mobile number'; end if;
  insert into public.riders (id, city_id, vehicle, phone, upi_id)
  values (auth.uid(), v_city, coalesce(nullif(p_vehicle, ''), 'bike'), p_phone, nullif(trim(p_upi), ''))
  on conflict (id) do update set city_id = excluded.city_id, vehicle = excluded.vehicle,
    phone = excluded.phone, upi_id = coalesce(excluded.upi_id, public.riders.upi_id);
end $$;

-- Rider heartbeat: location + online toggle. Going online also picks up a waiting job.
create or replace function public.rider_ping(p_lat double precision, p_lng double precision, p_online boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_r public.riders%rowtype; v_job uuid;
begin
  update public.riders set current_lat = coalesce(p_lat, current_lat), current_lng = coalesce(p_lng, current_lng),
    is_online = p_online, last_seen_at = now()
  where id = auth.uid() returning * into v_r;
  if not found then raise exception 'Register as a rider first'; end if;
  if p_online and v_r.is_approved and not exists (
      select 1 from public.deliveries where rider_id = v_r.id and status in ('assigned','at_pickup','picked_up')) then
    select d.order_id into v_job from public.deliveries d join public.orders o on o.id = d.order_id
    where d.status = 'searching' and o.city_id = v_r.city_id order by d.created_at limit 1 for update skip locked;
    if v_job is not null then
      update public.deliveries set rider_id = v_r.id, status = 'assigned', assigned_at = now() where order_id = v_job;
    end if;
  end if;
end $$;

-- ---------- Ordering ----------
create or replace function public.place_order(
  p_cook uuid, p_items jsonb, p_type text, p_scheduled_for timestamptz, p_slot text,
  p_address uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_cook public.cooks%rowtype; v_addr public.addresses%rowtype;
  v_order uuid; v_total numeric := 0; v_type public.order_type; it jsonb; v_d public.dishes%rowtype; v_no bigint;
begin
  if v_uid is null then raise exception 'Please sign in first'; end if;
  select * into v_cook from public.cooks where id = p_cook and is_approved;
  if not found then raise exception 'This kitchen is not taking orders'; end if;
  if v_cook.id = v_uid then raise exception 'You cannot order from your own kitchen'; end if;
  select * into v_addr from public.addresses where id = p_address and user_id = v_uid;
  if not found then raise exception 'Choose a delivery address'; end if;
  if v_addr.city_id <> v_cook.city_id then raise exception 'This kitchen does not deliver to that city'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Your cart is empty'; end if;
  v_type := case when p_type = 'instant' then 'instant'::public.order_type else 'scheduled'::public.order_type end;
  if v_type = 'instant' and not (v_cook.is_open and v_cook.accepts_instant) then
    raise exception 'This kitchen is not taking orders for right now. Choose a pre-order slot.';
  end if;
  if v_type = 'scheduled' and (p_scheduled_for is null or p_scheduled_for < now() + interval '2 hours') then
    raise exception 'Pick a delivery slot at least 2 hours away';
  end if;

  insert into public.orders (customer_id, cook_id, address_id, city_id, type, scheduled_for, slot_label,
                             delivery_fee, platform_fee, note, drop_snapshot)
  values (v_uid, v_cook.id, v_addr.id, v_cook.city_id, v_type,
          case when v_type = 'scheduled' then p_scheduled_for end, p_slot,
          case when v_type = 'instant' then 69 else 39 end, 10, nullif(trim(p_note), ''),
          jsonb_build_object('label', v_addr.label, 'line1', v_addr.line1, 'area', v_addr.area, 'pincode', v_addr.pincode,
                             'lat', v_addr.lat, 'lng', v_addr.lng, 'name', v_addr.contact_name, 'phone', v_addr.contact_phone))
  returning id, order_no into v_order, v_no;

  for it in select * from jsonb_array_elements(p_items) loop
    select * into v_d from public.dishes where id = (it->>'dish_id')::uuid and cook_id = v_cook.id and not is_deleted and is_available;
    if not found then raise exception 'An item in your cart is no longer available'; end if;
    if v_type = 'instant' and v_d.order_mode = 'pre' then raise exception '% is pre-order only', v_d.name; end if;
    if v_type = 'scheduled' and v_d.order_mode = 'now' then raise exception '% is only available for right now', v_d.name; end if;
    if coalesce((it->>'qty')::int, 0) < 1 or (it->>'qty')::int > 20 then raise exception 'Check the quantity for %', v_d.name; end if;
    insert into public.order_items (order_id, dish_id, dish_name, unit_price, qty)
    values (v_order, v_d.id, v_d.name, v_d.price, (it->>'qty')::int);   -- trigger reserves stock or fails
    v_total := v_total + v_d.price * (it->>'qty')::int;
  end loop;

  update public.orders set items_total = v_total where id = v_order;
  return jsonb_build_object('id', v_order, 'order_no', v_no);
end $$;

-- Customer can cancel only before the cook accepts
create or replace function public.cancel_my_order(p_order uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.orders set status = 'cancelled' where id = p_order and customer_id = auth.uid() and status = 'placed';
  if not found then raise exception 'This order can no longer be cancelled'; end if;
end $$;

-- Cook moves the order along
create or replace function public.cook_set_status(p_order uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_o public.orders%rowtype;
begin
  select * into v_o from public.orders where id = p_order and cook_id = auth.uid() for update;
  if not found then raise exception 'Order not found'; end if;
  if not ((v_o.status = 'placed' and p_status in ('accepted','rejected'))
       or (v_o.status = 'accepted' and p_status in ('preparing','rejected'))
       or (v_o.status = 'preparing' and p_status = 'ready')) then
    raise exception 'Cannot move an order from % to %', v_o.status, p_status;
  end if;
  update public.orders set status = p_status::public.order_status where id = p_order;
end $$;

-- Rider reached the kitchen
create or replace function public.rider_arrived(p_order uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.deliveries set status = 'at_pickup' where order_id = p_order and rider_id = auth.uid() and status = 'assigned';
  if not found then raise exception 'Nothing to pick up here'; end if;
end $$;

-- Cook enters the rider's pickup code to hand over the food
create or replace function public.cook_handover(p_order uuid, p_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_ok boolean;
begin
  if not exists (select 1 from public.orders where id = p_order and cook_id = auth.uid() and status = 'ready') then
    raise exception 'This order is not waiting for pickup';
  end if;
  if not exists (select 1 from public.deliveries where order_id = p_order and rider_id is not null and status in ('assigned','at_pickup')) then
    raise exception 'No rider has been assigned yet';
  end if;
  select pickup_otp = trim(p_code) into v_ok from public.delivery_codes where order_id = p_order;
  if not coalesce(v_ok, false) then raise exception 'Wrong code. Do not hand over yet.'; end if;
  update public.deliveries set status = 'picked_up', picked_up_at = now() where order_id = p_order;
end $$;

-- Rider enters the customer's code at the door
create or replace function public.rider_deliver(p_order uuid, p_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_ok boolean;
begin
  if not exists (select 1 from public.deliveries where order_id = p_order and rider_id = auth.uid() and status = 'picked_up') then
    raise exception 'This delivery is not on its way';
  end if;
  select drop_otp = trim(p_code) into v_ok from public.delivery_codes where order_id = p_order;
  if not coalesce(v_ok, false) then raise exception 'That code does not match. Ask the customer to check their screen.'; end if;
  update public.deliveries set status = 'delivered', delivered_at = now() where order_id = p_order;
end $$;

-- The one code each person is allowed to see
create or replace function public.my_code(p_order uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from public.orders where id = p_order and customer_id = auth.uid()) then c.drop_otp
    when exists (select 1 from public.deliveries where order_id = p_order and rider_id = auth.uid()) then c.pickup_otp
  end
  from public.delivery_codes c where c.order_id = p_order;
$$;

-- Order cards for each side, with only what that side may see
create or replace function public.my_orders(p_as text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(card order by sort_key desc), '[]'::jsonb) from (
    select o.created_at as sort_key, jsonb_build_object(
      'id', o.id, 'order_no', o.order_no, 'status', o.status, 'type', o.type,
      'scheduled_for', o.scheduled_for, 'slot', o.slot_label, 'created_at', o.created_at, 'updated_at', o.updated_at,
      'items_total', o.items_total, 'delivery_fee', o.delivery_fee, 'platform_fee', o.platform_fee, 'grand_total', o.grand_total,
      'payment_method', o.payment_method, 'note', o.note,
      'items', (select jsonb_agg(jsonb_build_object('name', i.dish_name, 'qty', i.qty, 'price', i.unit_price)) from public.order_items i where i.order_id = o.id),
      'kitchen', jsonb_build_object('id', c.id, 'name', c.kitchen_name, 'area', c.area,
          'lat', case when p_as = 'rider' then c.lat else round(c.lat::numeric, 3) end,
          'lng', case when p_as = 'rider' then c.lng else round(c.lng::numeric, 3) end,
          'address', case when p_as = 'rider' then c.pickup_address end,
          'phone', case when p_as = 'rider' then cp.phone end,
          'cook_name', cp.full_name),
      'drop', case when p_as in ('customer','rider') then o.drop_snapshot
                   else jsonb_build_object('name', split_part(coalesce(o.drop_snapshot->>'name', ''), ' ', 1), 'area', o.drop_snapshot->>'area') end,
      'delivery', (select jsonb_build_object('status', d.status, 'provider', d.provider,
            'rider_name', rp.full_name, 'rider_phone', case when p_as = 'customer' then r.phone end,
            'rider_lat', r.current_lat, 'rider_lng', r.current_lng, 'cost', d.cost,
            'assigned_at', d.assigned_at, 'picked_up_at', d.picked_up_at, 'delivered_at', d.delivered_at)
          from public.deliveries d left join public.riders r on r.id = d.rider_id left join public.profiles rp on rp.id = d.rider_id
          where d.order_id = o.id),
      'stars', (select stars from public.reviews rv where rv.order_id = o.id)) as card
    from public.orders o
    join public.cooks c on c.id = o.cook_id
    join public.profiles cp on cp.id = c.id
    where (p_as = 'customer' and o.customer_id = auth.uid())
       or (p_as = 'cook' and o.cook_id = auth.uid())
       or (p_as = 'rider' and exists (select 1 from public.deliveries d where d.order_id = o.id and d.rider_id = auth.uid()))
    order by o.created_at desc limit 60) t;
$$;

-- Cook's own full kitchen row (public listing hides the home address)
create or replace function public.my_dishes()
returns setof public.dishes language sql stable security definer set search_path = '' as $$
  select * from public.dishes where cook_id = auth.uid() and not is_deleted order by created_at;
$$;

-- ---------- Admin ----------
create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return jsonb_build_object(
    'cooks', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'kitchen', c.kitchen_name, 'cook', p.full_name, 'email', p.email,
               'phone', p.phone, 'city', ci.name, 'area', c.area, 'address', c.pickup_address, 'fssai', c.fssai_number,
               'approved', c.is_approved, 'dishes', (select count(*) from public.dishes d where d.cook_id = c.id and not d.is_deleted),
               'created_at', c.created_at) order by c.is_approved, c.created_at desc), '[]')
              from public.cooks c join public.profiles p on p.id = c.id join public.cities ci on ci.id = c.city_id),
    'riders', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', p.full_name, 'email', p.email, 'phone', r.phone,
               'city', ci.name, 'vehicle', r.vehicle, 'online', r.is_online, 'approved', r.is_approved,
               'wallet', r.wallet_balance, 'upi', r.upi_id, 'last_seen', r.last_seen_at) order by r.is_approved, p.full_name), '[]')
              from public.riders r join public.profiles p on p.id = r.id join public.cities ci on ci.id = r.city_id),
    'payouts', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'rider', p.full_name, 'amount', x.amount, 'upi', x.upi_id,
               'status', x.status, 'utr', x.utr, 'created_at', x.created_at) order by x.created_at desc), '[]')
              from public.rider_payouts x join public.profiles p on p.id = x.rider_id),
    'orders', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'order_no', o.order_no, 'status', o.status, 'type', o.type,
               'kitchen', c.kitchen_name, 'city', ci.name, 'total', o.grand_total, 'created_at', o.created_at,
               'delivery', d.status, 'rider', rp.full_name) order by o.created_at desc), '[]')
              from (select * from public.orders order by created_at desc limit 100) o
              join public.cooks c on c.id = o.cook_id join public.cities ci on ci.id = o.city_id
              left join public.deliveries d on d.order_id = o.id left join public.profiles rp on rp.id = d.rider_id),
    'stats', jsonb_build_object(
      'orders_today', (select count(*) from public.orders where created_at > date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'),
      'gmv_today', (select coalesce(sum(grand_total), 0) from public.orders where status not in ('cancelled','rejected')
                    and created_at > date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'),
      'customers', (select count(*) from public.profiles),
      'waiting_for_rider', (select count(*) from public.deliveries where status = 'searching')));
end $$;

create or replace function public.admin_set_approval(p_kind text, p_id uuid, p_ok boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_kind = 'cook' then update public.cooks set is_approved = p_ok where id = p_id;
  elsif p_kind = 'rider' then update public.riders set is_approved = p_ok, is_online = case when p_ok then is_online else false end where id = p_id;
  else raise exception 'Unknown kind'; end if;
end $$;

create or replace function public.admin_assign_rider(p_order uuid, p_rider uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  update public.deliveries set rider_id = p_rider, status = 'assigned', assigned_at = now()
  where order_id = p_order and status in ('searching','assigned');
  if not found then raise exception 'This delivery can no longer be reassigned'; end if;
end $$;

create or replace function public.admin_mark_payout(p_id uuid, p_utr text, p_paid boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_p public.rider_payouts%rowtype;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  select * into v_p from public.rider_payouts where id = p_id and status in ('requested','processing') for update;
  if not found then raise exception 'Payout already settled'; end if;
  if p_paid then
    update public.rider_payouts set status = 'paid', utr = nullif(trim(p_utr), ''), paid_at = now() where id = p_id;
  else
    update public.rider_payouts set status = 'failed' where id = p_id;
    update public.riders set wallet_balance = wallet_balance + v_p.amount where id = v_p.rider_id;  -- money back to wallet
  end if;
end $$;

-- ---------- Tighten direct table access ----------
-- Writes that matter go through the functions above only.
revoke insert, delete on public.cooks from anon, authenticated;
revoke insert, delete on public.riders from anon, authenticated;
revoke update on public.riders from anon, authenticated;            -- location/online via rider_ping()
revoke insert, update, delete on public.orders from anon, authenticated;
revoke insert, update, delete on public.order_items from anon, authenticated;
revoke insert, update, delete on public.deliveries from anon, authenticated;
revoke all on public.delivery_codes from anon, authenticated;
revoke all on public.app_admins from anon, authenticated;
revoke update, insert, delete on public.profiles from anon, authenticated;  -- via set_my_profile()

-- Public kitchen listing must not reveal the cook's home address or exact location
revoke select on public.cooks from anon, authenticated;
grant select (id, kitchen_name, bio, home_region, city_id, area, is_open, accepts_instant, available_days,
              rating, rating_count, is_approved, fssai_verified, created_at) on public.cooks to anon, authenticated;

-- Reviews must name the right kitchen
drop policy if exists "customer reviews own order" on public.reviews;
create policy "customer reviews own order" on public.reviews for insert with check (
  customer_id = auth.uid() and exists (
    select 1 from public.orders o where o.id = order_id and o.cook_id = reviews.cook_id
      and o.customer_id = auth.uid() and o.status = 'delivered'));

-- Anonymous visitors can browse kitchens and dishes but call nothing else
do $$ declare f text; begin
  for f in select p.oid::regprocedure::text from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
    and p.proname in ('me','set_my_profile','register_cook','register_rider','rider_ping','place_order','cancel_my_order',
      'cook_set_status','rider_arrived','cook_handover','rider_deliver','my_code','my_orders','my_dishes',
      'admin_overview','admin_set_approval','admin_assign_rider','admin_mark_payout','request_payout')
  loop execute format('revoke execute on function %s from public, anon', f);
       execute format('grant execute on function %s to authenticated', f); end loop;
end $$;

commit;
