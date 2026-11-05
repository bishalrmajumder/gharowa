-- GHAROWA 004: the orders and deliveries policies referenced each other (infinite recursion).
-- Break the loop with two small trusted helper functions.
begin;

create or replace function public.is_order_party(p_order uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.orders o where o.id = p_order and (o.customer_id = auth.uid() or o.cook_id = auth.uid()));
$$;
create or replace function public.is_order_rider(p_order uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.deliveries d where d.order_id = p_order and d.rider_id = auth.uid());
$$;
revoke execute on function public.is_order_party(uuid) from public, anon;
revoke execute on function public.is_order_rider(uuid) from public, anon;
grant execute on function public.is_order_party(uuid) to authenticated;
grant execute on function public.is_order_rider(uuid) to authenticated;

drop policy if exists "order visible to parties" on public.orders;
create policy "order visible to parties" on public.orders for select
  using (customer_id = auth.uid() or cook_id = auth.uid() or public.is_order_rider(id));

drop policy if exists "delivery visible to parties" on public.deliveries;
create policy "delivery visible to parties" on public.deliveries for select
  using (rider_id = auth.uid() or public.is_order_party(order_id));

drop policy if exists "items visible with order" on public.order_items;
create policy "items visible with order" on public.order_items for select
  using (public.is_order_party(order_id) or public.is_order_rider(order_id));

commit;
