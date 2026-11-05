-- Simulates the website's calls as real signed-in users (customer, cook, rider, admin).
-- Ends with a deliberate error so everything is rolled back. Look for "TEST_DONE" in the error text.
do $t$
declare
  out text := ''; v text; ok boolean;
  cu uuid := '00000000-0000-0000-0000-00000000a001'; ck uuid := '00000000-0000-0000-0000-00000000a002';
  rd uuid := '00000000-0000-0000-0000-00000000a003'; ad uuid := '00000000-0000-0000-0000-00000000a004';
  dish uuid; addr uuid; ord uuid; pcode text; dcode text; pay uuid; j jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
    (cu, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't-cust@gharowa.test', now()),
    (ck, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't-cook@gharowa.test', now()),
    (rd, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't-rider@gharowa.test', now()),
    (ad, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't-admin@gharowa.test', now());
  insert into public.app_admins values ('t-admin@gharowa.test');
  execute 'set local role authenticated';

  -- COOK signs up
  perform set_config('request.jwt.claims', json_build_object('sub', ck, 'role', 'authenticated')::text, true);
  perform public.set_my_profile('Sumana Dey', '9000000002');
  perform public.register_cook('Mashi''s Rannaghor', 'Ghoti home food', 'Ghoti home style', 'Bangalore', 'HSR Layout',
                               '12, 5th Cross, HSR Sector 2', 12.9116, 77.6474, null);
  insert into public.dishes (cook_id, name, category, price, stock_left, order_mode) values (ck, 'Kosha Mangsho', 'meat', 380, 5, 'both') returning id into dish;
  begin insert into public.cooks (id, kitchen_name, city_id, is_approved) values (ck, 'x', 1, true); out := concat(out, coalesce((' | FAIL cook self-insert allowed')::text, '<null>'));
  exception when others then out := concat(out, coalesce((' | 1 cook cannot self-approve')::text, '<null>')); end;
  update public.cooks set is_open = true, accepts_instant = true where id = ck;

  -- RIDER signs up
  perform set_config('request.jwt.claims', json_build_object('sub', rd, 'role', 'authenticated')::text, true);
  perform public.set_my_profile('Ravi Kumar', '9000000003');
  perform public.register_rider('Bangalore', 'bike', '9000000003', 'ravi@okaxis');
  begin update public.riders set wallet_balance = 9999 where id = rd; out := concat(out, coalesce((' | FAIL rider edited wallet')::text, '<null>'));
  exception when others then out := concat(out, coalesce((' | 2 rider cannot edit wallet')::text, '<null>')); end;

  -- CUSTOMER cannot use admin, cannot see cook address
  perform set_config('request.jwt.claims', json_build_object('sub', cu, 'role', 'authenticated')::text, true);
  begin perform public.admin_overview(); out := concat(out, coalesce((' | FAIL non-admin saw admin')::text, '<null>'));
  exception when others then out := concat(out, coalesce((' | 3 admin blocked for customer')::text, '<null>')); end;
  begin perform pickup_address from public.cooks limit 1; out := concat(out, coalesce((' | FAIL cook address visible')::text, '<null>'));
  exception when others then out := concat(out, coalesce((' | 4 cook address hidden')::text, '<null>')); end;
  select count(*)::text into v from public.cooks where id = ck; out := concat(out, coalesce((' | 5 unapproved kitchen visible to customer: ')::text, '<null>'), coalesce((v)::text, '<null>'));

  -- ADMIN approves
  perform set_config('request.jwt.claims', json_build_object('sub', ad, 'role', 'authenticated')::text, true);
  perform public.admin_set_approval('cook', ck, true);
  perform public.admin_set_approval('rider', rd, true);
  j := public.admin_overview(); out := concat(out, coalesce((' | 6 admin sees ')::text, '<null>'), coalesce((jsonb_array_length(j->'cooks'))::text, '<null>'), coalesce((' kitchen(s)')::text, '<null>'));

  -- RIDER goes online near the kitchen
  perform set_config('request.jwt.claims', json_build_object('sub', rd, 'role', 'authenticated')::text, true);
  perform public.rider_ping(12.9150, 77.6400, true);

  -- CUSTOMER adds address and orders
  perform set_config('request.jwt.claims', json_build_object('sub', cu, 'role', 'authenticated')::text, true);
  perform public.set_my_profile('Bishal', '9000000001');
  insert into public.addresses (user_id, label, contact_name, contact_phone, line1, area, city_id, pincode, lat, lng)
  values (cu, 'Home', 'Bishal', '9000000001', 'Flat 402, Prestige Ferns', 'Koramangala', 1, '560034', 12.9352, 77.6245) returning id into addr;
  begin insert into public.orders (customer_id, cook_id, city_id, items_total) values (cu, ck, 1, 1); out := concat(out, coalesce((' | FAIL direct order insert')::text, '<null>'));
  exception when others then out := concat(out, coalesce((' | 7 fake orders blocked')::text, '<null>')); end;
  begin perform public.place_order(ck, jsonb_build_array(jsonb_build_object('dish_id', dish, 'qty', 9)), 'instant', null, 'Now', addr, null);
        out := concat(out, coalesce((' | FAIL oversold')::text, '<null>'));
  exception when others then out := concat(out, coalesce((' | 8 oversell blocked')::text, '<null>')); end;
  j := public.place_order(ck, jsonb_build_array(jsonb_build_object('dish_id', dish, 'qty', 2)), 'instant', null, 'Now', addr, 'less spicy');
  ord := (j->>'id')::uuid;
  select grand_total::text into v from public.orders where id = ord; out := concat(out, coalesce((' | 9 order total ')::text, '<null>'), coalesce((v)::text, '<null>'));

  -- COOK moves it along
  perform set_config('request.jwt.claims', json_build_object('sub', ck, 'role', 'authenticated')::text, true);
  begin perform public.cook_set_status(ord, 'ready'); out := concat(out, coalesce((' | FAIL skipped steps')::text, '<null>'));
  exception when others then out := concat(out, coalesce((' | 10 cannot skip steps')::text, '<null>')); end;
  perform public.cook_set_status(ord, 'accepted'); perform public.cook_set_status(ord, 'preparing'); perform public.cook_set_status(ord, 'ready');
  j := public.my_orders('cook'); out := concat(out, coalesce((' | 11 cook sees customer as ')::text, '<null>'), coalesce(((j->0->'drop'->>'name'))::text, '<null>'), coalesce((' in ')::text, '<null>'), coalesce(((j->0->'drop'->>'area'))::text, '<null>'), coalesce((', phone hidden: ')::text, '<null>'), coalesce((((j->0->'drop'->>'phone') is null)::text)::text, '<null>'));

  -- RIDER got it automatically
  perform set_config('request.jwt.claims', json_build_object('sub', rd, 'role', 'authenticated')::text, true);
  j := public.my_orders('rider'); out := concat(out, coalesce((' | 12 rider auto-assigned: ')::text, '<null>'), coalesce((coalesce(j->0->'delivery'->>'status', 'none'))::text, '<null>'), coalesce((', sees pickup address: ')::text, '<null>'), coalesce((((j->0->'kitchen'->>'address') is not null)::text)::text, '<null>'));
  pcode := public.my_code(ord);
  perform public.rider_arrived(ord);

  -- COOK hands over with the code
  perform set_config('request.jwt.claims', json_build_object('sub', ck, 'role', 'authenticated')::text, true);
  begin perform public.cook_handover(ord, case when pcode = '0000' then '1111' else '0000' end); out := concat(out, coalesce((' | FAIL wrong pickup code accepted')::text, '<null>'));
  exception when others then out := concat(out, coalesce((' | 13 wrong pickup code refused')::text, '<null>')); end;
  perform public.cook_handover(ord, pcode);

  -- CUSTOMER sees rider and drop code
  perform set_config('request.jwt.claims', json_build_object('sub', cu, 'role', 'authenticated')::text, true);
  dcode := public.my_code(ord);
  j := public.my_orders('customer'); out := concat(out, coalesce((' | 14 customer sees ')::text, '<null>'), coalesce(((j->0->>'status'))::text, '<null>'), coalesce((' with ')::text, '<null>'), coalesce(((j->0->'delivery'->>'rider_name'))::text, '<null>'), coalesce((', code ')::text, '<null>'), coalesce(((case when dcode ~ '^[0-9]{4}$' then 'ok' else 'missing' end))::text, '<null>'));
  begin perform public.cancel_my_order(ord); out := concat(out, coalesce((' | FAIL late cancel')::text, '<null>'));
  exception when others then out := concat(out, coalesce((' | 15 late cancel refused')::text, '<null>')); end;

  -- RIDER delivers
  perform set_config('request.jwt.claims', json_build_object('sub', rd, 'role', 'authenticated')::text, true);
  begin perform public.rider_deliver(ord, case when dcode = '0000' then '1111' else '0000' end); out := concat(out, coalesce((' | FAIL wrong drop code accepted')::text, '<null>'));
  exception when others then out := concat(out, coalesce((' | 16 wrong drop code refused')::text, '<null>')); end;
  perform public.rider_deliver(ord, dcode);
  select wallet_balance::text into v from public.riders where id = rd; out := concat(out, coalesce((' | 17 rider wallet ')::text, '<null>'), coalesce((v)::text, '<null>'));
  pay := public.request_payout(40, 'ravi@okaxis');
  select wallet_balance::text into v from public.riders where id = rd; out := concat(out, coalesce((' | 18 after payout request ')::text, '<null>'), coalesce((v)::text, '<null>'));

  -- ADMIN pays out
  perform set_config('request.jwt.claims', json_build_object('sub', ad, 'role', 'authenticated')::text, true);
  perform public.admin_mark_payout(pay, 'UTR123456', true);
  out := concat(out, ' | 19 payout marked paid');

  -- CUSTOMER rates
  perform set_config('request.jwt.claims', json_build_object('sub', cu, 'role', 'authenticated')::text, true);
  insert into public.reviews (order_id, cook_id, customer_id, stars) values (ord, ck, cu, 5);
  select status::text into v from public.orders where id = ord; out := concat(out, coalesce((' | 20 final order ')::text, '<null>'), coalesce((v)::text, '<null>'));
  select stock_left::text into v from public.dishes where id = dish; out := concat(out, coalesce((', stock left ')::text, '<null>'), coalesce((v)::text, '<null>'));

  raise exception 'TEST_DONE%', out;
end $t$;
