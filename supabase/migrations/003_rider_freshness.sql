-- GHAROWA 003: only hand jobs to riders whose app checked in during the last 3 minutes
begin;
create or replace function public.dispatch_on_ready()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_cook public.cooks%rowtype; v_rider uuid;
begin
  if new.status = 'ready' and old.status is distinct from 'ready' then
    select * into v_cook from public.cooks where id = new.cook_id;
    select r.id into v_rider from public.riders r
    where r.city_id = new.city_id and r.is_online and r.is_approved
      and r.last_seen_at > now() - interval '3 minutes'
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
commit;
