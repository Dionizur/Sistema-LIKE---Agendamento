-- Execute no SQL Editor do Supabase antes de usar a recorrência.
begin;
alter table public.appointments add column if not exists series_id uuid;
create index if not exists appointments_series on public.appointments(series_id);
create or replace function public.save_appointment_sequence(records jsonb, editing boolean default false)
returns void language plpgsql security invoker set search_path = public as $$
declare item jsonb; old_rows jsonb; affected integer;
begin
  if not exists(select 1 from public.staff where user_id=auth.uid()) then
    raise exception 'Funcionário não autorizado.';
  end if;
  if jsonb_typeof(records) <> 'array' or jsonb_array_length(records) not between 1 and 104 then
    raise exception 'Informe entre 1 e 104 aulas.';
  end if;
  if editing then
    -- Lock existing rows, preserve audit fields and validate stale/deleted IDs.
    perform 1 from public.appointments where id in
      (select (value->>'id')::uuid from jsonb_array_elements(records)) for update;
    select jsonb_agg(to_jsonb(a)) into old_rows from public.appointments a
      where id in (select (value->>'id')::uuid from jsonb_array_elements(records));
    delete from public.appointments where id in
      (select (value->>'id')::uuid from jsonb_array_elements(records));
    get diagnostics affected = row_count;
    if affected <> jsonb_array_length(records) then
      raise exception 'A agenda mudou. Atualize e tente novamente.';
    end if;
  end if;
  for item in select value from jsonb_array_elements(records) loop
    insert into public.appointments(id,teacher_id,student,starts_at,duration,notes,series_id,created_by,created_at)
    values ((item->>'id')::uuid,(item->>'teacher_id')::uuid,item->>'student',
      (item->>'starts_at')::timestamptz,(item->>'duration')::integer,coalesce(item->>'notes',''),
      (item->>'series_id')::uuid,
      case when editing then (select (value->>'created_by')::uuid from jsonb_array_elements(old_rows) where value->>'id'=item->>'id') else auth.uid() end,
      case when editing then (select (value->>'created_at')::timestamptz from jsonb_array_elements(old_rows) where value->>'id'=item->>'id') else now() end);
  end loop;
end;
$$;
revoke all on function public.save_appointment_sequence(jsonb,boolean) from public, anon;
grant execute on function public.save_appointment_sequence(jsonb,boolean) to authenticated;
commit;
