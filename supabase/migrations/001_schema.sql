-- =====================================================================
-- GHAROWA — home-cooked Bengali food marketplace
-- Supabase / Postgres schema v2 (stock, pre-order, verification, rider payouts)
-- Run once in: Supabase Dashboard → SQL Editor → New query → Run
begin;
-- =====================================================================

-- ---------- Enums ----------
create type public.user_role      as enum ('customer', 'cook', 'rider', 'admin');
create type public.order_type     as enum ('scheduled', 'instant');
create type public.order_status   as enum (
  'placed',        -- customer paid / placed
  'accepted',      -- cook accepted
  'preparing',     -- cook cooking
  'ready',         -- packed, waiting for rider
  'picked_up',     -- rider has it
  'delivered',
  'cancelled',
  'rejected'       -- cook declined
);
create type public.delivery_status as enum (
  'searching', 'assigned', 'at_pickup', 'picked_up', 'delivered', 'failed'
);
create type public.delivery_provider as enum ('own_fleet', 'pidge', 'shiprocket_quick', 'borzo', 'shadowfax');
create type public.dish_mode      as enum ('now', 'pre', 'both');   -- available now / pre-order only / both
create type public.payout_status  as enum ('requested', 'processing', 'paid', 'failed');
create type public.dish_category  as enum (
  'rice_bread', 'fish', 'meat', 'veg', 'dal', 'sweets', 'snacks', 'thali'
);

-- ---------- Cities ----------
create table public.cities (
  id          smallserial primary key,
  name        text not null unique,
  is_live     boolean not null default true
);
insert into public.cities (name) values
  ('Bangalore'), ('Chennai'), ('Gurgaon'), ('Hyderabad');

-- ---------- Profiles (one per auth user) ----------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  phone       text unique,
  email       text unique,
  phone_verified boolean not null default false,
  email_verified boolean not null default false,
  role        public.user_role not null default 'customer',
  city_id     smallint references public.cities (id),
  created_at  timestamptz not null default now()
);

-- Customer addresses
create table public.addresses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  label       text default 'Home',            -- Home / Work / Other
  contact_name  text,
  contact_phone text,
  line1       text not null,
  area        text,
  city_id     smallint not null references public.cities (id),
  pincode     text check (pincode ~ '^[0-9]{6}$'),
  lat         double precision,
  lng         double precision,
  is_default  boolean not null default false
);

-- ---------- Cooks (home kitchens) ----------
create table public.cooks (
  id               uuid primary key references public.profiles (id) on delete cascade,
  kitchen_name     text not null,
  bio              text,
  home_region      text,                     -- e.g. 'Kolkata', 'Bangal', 'Ghoti'
  city_id          smallint not null references public.cities (id),
  area             text,
  pickup_address   text,
  lat              double precision,
  lng              double precision,
  fssai_number     text,                     -- filled once registered
  fssai_verified   boolean not null default false,
  is_open          boolean not null default false,   -- live toggle
  accepts_instant  boolean not null default false,   -- 10–15 min orders
  available_days   smallint[] default '{6,0}',       -- 0=Sun … 6=Sat
  rating           numeric(2,1) default 0,
  rating_count     int not null default 0,
  is_approved      boolean not null default false,   -- admin approval
  created_at       timestamptz not null default now()
);

-- ---------- Dishes ----------
create table public.dishes (
  id              uuid primary key default gen_random_uuid(),
  cook_id         uuid not null references public.cooks (id) on delete cascade,
  name            text not null,
  description     text,
  category        public.dish_category not null,
  price           numeric(8,2) not null check (price > 0),
  serves          smallint default 1,
  is_veg          boolean not null default false,
  photo_url       text,
  prep_minutes    smallint default 60,
  daily_limit     smallint,                  -- default plates per day
  stock_left      smallint not null default 0 check (stock_left >= 0),  -- plates left right now
  order_mode      public.dish_mode not null default 'both',
  is_available    boolean not null default true,  -- listed / hidden
  is_deleted      boolean not null default false, -- soft delete keeps past orders intact
  created_at      timestamptz not null default now()
);

-- ---------- Riders (own fleet, for later) ----------
create table public.riders (
  id             uuid primary key references public.profiles (id) on delete cascade,
  city_id        smallint not null references public.cities (id),
  vehicle        text default 'bike',
  is_online      boolean not null default false,
  current_lat    double precision,
  current_lng    double precision,
  last_seen_at   timestamptz,
  upi_id         text check (upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}$'),
  wallet_balance numeric(10,2) not null default 0 check (wallet_balance >= 0)
);

-- Rider payouts to UPI (settle anytime). Executed by an Edge Function via RazorpayX Payouts.
create table public.rider_payouts (
  id            uuid primary key default gen_random_uuid(),
  rider_id      uuid not null references public.riders (id) on delete cascade,
  amount        numeric(10,2) not null check (amount > 0),
  upi_id        text not null,
  status        public.payout_status not null default 'requested',
  utr           text,                       -- bank reference once paid
  provider_ref  text,                       -- RazorpayX payout id
  created_at    timestamptz not null default now(),
  paid_at       timestamptz
);

-- ---------- Orders ----------
create table public.orders (
  id                uuid primary key default gen_random_uuid(),
  order_no          bigserial unique,
  customer_id       uuid not null references public.profiles (id),
  cook_id           uuid not null references public.cooks (id),
  address_id        uuid references public.addresses (id),
  city_id           smallint not null references public.cities (id),
  type              public.order_type not null default 'scheduled',
  scheduled_for     timestamptz,             -- null for instant
  status            public.order_status not null default 'placed',
  items_total       numeric(10,2) not null default 0,
  delivery_fee      numeric(8,2) not null default 0,
  platform_fee      numeric(8,2) not null default 0,
  grand_total       numeric(10,2) generated always as (items_total + delivery_fee + platform_fee) stored,
  payment_ref       text,                    -- Razorpay payment id
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint scheduled_needs_time check (type = 'instant' or scheduled_for is not null)
);

create table public.order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders (id) on delete cascade,
  dish_id     uuid not null references public.dishes (id),
  dish_name   text not null,                 -- snapshot at order time
  unit_price  numeric(8,2) not null,
  qty         smallint not null check (qty > 0)
);

-- ---------- Deliveries ----------
create table public.deliveries (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null unique references public.orders (id) on delete cascade,
  provider         public.delivery_provider not null default 'own_fleet',
  rider_id         uuid references public.riders (id),
  external_ref     text,                     -- partner's task id (Pidge etc.)
  tracking_url     text,
  status           public.delivery_status not null default 'searching',
  pickup_otp       text default lpad((floor(random()*10000))::int::text, 4, '0'),
  drop_otp         text default lpad((floor(random()*10000))::int::text, 4, '0'),
  cost             numeric(8,2),
  assigned_at      timestamptz,
  picked_up_at     timestamptz,
  delivered_at     timestamptz,
  created_at       timestamptz not null default now()
);

-- ---------- Reviews ----------
create table public.reviews (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null unique references public.orders (id) on delete cascade,
  cook_id     uuid not null references public.cooks (id),
  customer_id uuid not null references public.profiles (id),
  stars       smallint not null check (stars between 1 and 5),
  comment     text,
  created_at  timestamptz not null default now()
);

-- ---------- Indexes ----------
create index on public.dishes (cook_id) where is_available and not is_deleted;
create index on public.rider_payouts (rider_id, created_at desc);
create index on public.cooks (city_id) where is_approved and is_open;
create index on public.orders (customer_id, created_at desc);
create index on public.orders (cook_id, status);
create index on public.deliveries (rider_id, status);
create index on public.addresses (user_id);

-- =====================================================================
-- Functions & triggers
-- =====================================================================

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Phone OTP and email OTP both come from Supabase Auth; copy the confirmed state here
  insert into public.profiles (id, full_name, phone, email, phone_verified, email_verified)
  values (new.id, new.raw_user_meta_data ->> 'full_name', new.phone, new.email,
          new.phone_confirmed_at is not null, new.email_confirmed_at is not null);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep updated_at fresh
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

-- When cook marks order READY → create delivery + auto-assign nearest online rider
create or replace function public.dispatch_on_ready()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_cook   public.cooks%rowtype;
  v_rider  uuid;
begin
  if new.status = 'ready' and old.status is distinct from 'ready' then
    select * into v_cook from public.cooks where id = new.cook_id;

    select r.id into v_rider
    from public.riders r
    where r.city_id = new.city_id
      and r.is_online
      and not exists (
        select 1 from public.deliveries d
        where d.rider_id = r.id and d.status in ('assigned','at_pickup','picked_up'))
    order by ((r.current_lat - v_cook.lat)^2 + (r.current_lng - v_cook.lng)^2) nulls last
    limit 1;

    insert into public.deliveries (order_id, rider_id, status, assigned_at)
    values (new.id, v_rider,
            case when v_rider is null then 'searching'::public.delivery_status
                 else 'assigned'::public.delivery_status end,
            case when v_rider is null then null else now() end)
    on conflict (order_id) do nothing;
    -- If v_rider is null, an Edge Function can hand the job to Pidge / Shiprocket Quick.
  end if;
  return new;
end $$;

create trigger orders_dispatch after update of status on public.orders
  for each row execute function public.dispatch_on_ready();

-- Mirror delivery progress onto the order
create or replace function public.sync_order_from_delivery()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'picked_up' then
    update public.orders set status = 'picked_up' where id = new.order_id;
  elsif new.status = 'delivered' then
    update public.orders set status = 'delivered' where id = new.order_id;
  end if;
  return new;
end $$;

create trigger deliveries_sync after update of status on public.deliveries
  for each row execute function public.sync_order_from_delivery();

-- Reserve plates when an order line is added; block overselling
create or replace function public.reserve_stock()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.dishes set stock_left = stock_left - new.qty
  where id = new.dish_id and stock_left >= new.qty and is_available and not is_deleted;
  if not found then
    raise exception 'Not enough plates left for %', new.dish_name using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger order_items_reserve before insert on public.order_items
  for each row execute function public.reserve_stock();

-- Give plates back if the cook declines or the order is cancelled
create or replace function public.release_stock()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('rejected','cancelled') and old.status not in ('rejected','cancelled') then
    update public.dishes d set stock_left = d.stock_left + oi.qty
    from public.order_items oi where oi.order_id = new.id and d.id = oi.dish_id;
  end if;
  return new;
end $$;

create trigger orders_release after update of status on public.orders
  for each row execute function public.release_stock();

-- Credit the rider's wallet when a delivery completes (own fleet only)
create or replace function public.credit_rider()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'delivered' and old.status is distinct from 'delivered'
     and new.provider = 'own_fleet' and new.rider_id is not null then
    update public.riders set wallet_balance = wallet_balance + coalesce(new.cost, 40)
    where id = new.rider_id;
  end if;
  return new;
end $$;

create trigger deliveries_credit after update of status on public.deliveries
  for each row execute function public.credit_rider();

-- Rider requests a payout: checks balance and holds the amount atomically
create or replace function public.request_payout(p_amount numeric, p_upi text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  update public.riders set wallet_balance = wallet_balance - p_amount, upi_id = p_upi
  where id = auth.uid() and wallet_balance >= p_amount and p_amount > 0;
  if not found then raise exception 'Amount is more than your balance'; end if;
  insert into public.rider_payouts (rider_id, amount, upi_id) values (auth.uid(), p_amount, p_upi)
  returning id into v_id;
  return v_id;   -- an Edge Function picks up 'requested' payouts and sends them via RazorpayX
end $$;

-- Recompute cook rating after a review
create or replace function public.refresh_cook_rating()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.cooks c set
    rating = (select round(avg(stars)::numeric, 1) from public.reviews where cook_id = new.cook_id),
    rating_count = (select count(*) from public.reviews where cook_id = new.cook_id)
  where c.id = new.cook_id;
  return new;
end $$;

create trigger reviews_rating after insert on public.reviews
  for each row execute function public.refresh_cook_rating();

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table public.cities      enable row level security;
alter table public.profiles    enable row level security;
alter table public.addresses   enable row level security;
alter table public.cooks       enable row level security;
alter table public.dishes      enable row level security;
alter table public.riders      enable row level security;
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;
alter table public.deliveries  enable row level security;
alter table public.reviews     enable row level security;
alter table public.rider_payouts enable row level security;

-- Public browsing
create policy "cities are public"   on public.cities  for select using (true);
create policy "approved cooks are public" on public.cooks for select using (is_approved or id = auth.uid());
create policy "dishes of approved cooks are public" on public.dishes for select
  using (not is_deleted and exists (select 1 from public.cooks c where c.id = cook_id and (c.is_approved or c.id = auth.uid())));
create policy "reviews are public"  on public.reviews for select using (true);

-- Profiles: own row only
create policy "own profile read"   on public.profiles for select using (id = auth.uid());
create policy "own profile update" on public.profiles for update using (id = auth.uid());

-- Addresses: own only
create policy "own addresses" on public.addresses for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Cooks manage their own kitchen + menu
create policy "cook registers self" on public.cooks for insert with check (id = auth.uid());
create policy "cook updates self"   on public.cooks for update using (id = auth.uid());
create policy "cook manages dishes" on public.dishes for all
  using (cook_id = auth.uid()) with check (cook_id = auth.uid());

-- Riders manage their own row
create policy "rider self" on public.riders for all
  using (id = auth.uid()) with check (id = auth.uid());

-- Orders: customer, the cook, or the assigned rider can see
create policy "order visible to parties" on public.orders for select using (
  customer_id = auth.uid() or cook_id = auth.uid()
  or exists (select 1 from public.deliveries d where d.order_id = orders.id and d.rider_id = auth.uid()));
create policy "customer places order" on public.orders for insert with check (customer_id = auth.uid());
create policy "cook updates own orders" on public.orders for update using (cook_id = auth.uid());

create policy "items visible with order" on public.order_items for select using (
  exists (select 1 from public.orders o where o.id = order_id
          and (o.customer_id = auth.uid() or o.cook_id = auth.uid())));
create policy "customer adds items" on public.order_items for insert with check (
  exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid()));

-- Deliveries: rider sees + updates own; customer & cook can read
create policy "delivery visible to parties" on public.deliveries for select using (
  rider_id = auth.uid()
  or exists (select 1 from public.orders o where o.id = order_id
             and (o.customer_id = auth.uid() or o.cook_id = auth.uid())));
create policy "rider updates own delivery" on public.deliveries for update using (rider_id = auth.uid());

-- Reviews: customer reviews own delivered order
create policy "customer reviews own order" on public.reviews for insert with check (
  customer_id = auth.uid() and exists (
    select 1 from public.orders o where o.id = order_id
    and o.customer_id = auth.uid() and o.status = 'delivered'));

-- Riders see their own payouts; requests go through request_payout()
create policy "rider sees own payouts" on public.rider_payouts for select using (rider_id = auth.uid());
-- Cooks also need to read their own deleted dishes
create policy "cook sees own dishes" on public.dishes for select using (cook_id = auth.uid());

-- Live updates for order tracking screens (rider location comes from riders table)
alter publication supabase_realtime add table public.orders, public.deliveries, public.riders;

-- =====================================================================
-- Column-level protection: users can only change the fields they own.
-- (Wallet balances, verification flags, approvals, ratings and order
--  totals are changed only by the trusted functions above.)
-- =====================================================================
revoke update on public.profiles from authenticated, anon;
grant  update (full_name, city_id) on public.profiles to authenticated;

revoke update on public.riders from authenticated, anon;
grant  update (vehicle, is_online, current_lat, current_lng, last_seen_at, upi_id) on public.riders to authenticated;

revoke update on public.cooks from authenticated, anon;
grant  update (kitchen_name, bio, home_region, area, pickup_address, lat, lng, fssai_number,
               is_open, accepts_instant, available_days) on public.cooks to authenticated;

revoke update on public.orders from authenticated, anon;
grant  update (status) on public.orders to authenticated;

revoke update on public.deliveries from authenticated, anon;
grant  update (status, picked_up_at, delivered_at) on public.deliveries to authenticated;

revoke execute on function public.request_payout(numeric, text) from anon;

commit;
