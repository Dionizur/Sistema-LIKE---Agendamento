-- Dias fixos, recorrência sem término e histórico da equipe.
begin;
alter table public.appointments add column if not exists status text not null default 'scheduled'
  check (status in ('scheduled','attended','canceled'));
alter table public.appointments add column if not exists change_reason text not null default '' check (length(change_reason)<=1000);
alter table public.appointments add column if not exists occurrence_date date;
alter table public.appointments add column if not exists rescheduled boolean not null default false;
create table if not exists public.teacher_schedule (
  weekday integer primary key check (weekday between 0 and 6),
  teacher_id uuid not null references public.teachers(id) on delete restrict
);
create table if not exists public.appointment_series (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers(id),
  student text not null check(length(trim(student)) between 1 and 120),
  starts_at timestamptz not null,
  anchor_date date not null,
  duration integer not null check(duration in (30,45,50,60,90,120)),
  notes text not null default '' check(length(notes)<=3000),
  change_reason text not null default '' check(length(change_reason)<=1000),
  stopped_at timestamptz,
  rescheduled boolean not null default false,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check ((starts_at at time zone 'America/Sao_Paulo')::time >= time '06:00'),
  check (((starts_at + duration*interval '1 minute') at time zone 'America/Sao_Paulo')::date=(starts_at at time zone 'America/Sao_Paulo')::date),
  check (((starts_at + duration*interval '1 minute') at time zone 'America/Sao_Paulo')::time<=time '23:00')
);
create table if not exists public.appointment_events (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null,
  kind text not null check(kind in ('teacher_changed','rescheduled','attended','canceled','scheduled')),
  student text not null,
  teacher_id uuid references public.teachers(id),
  from_teacher_id uuid references public.teachers(id),
  starts_at timestamptz not null,
  reason text not null default '' check(length(reason)<=1000),
  actor_name text not null default '',
  actor_id uuid default auth.uid() references auth.users(id) on delete set null,
  event_at timestamptz not null default now()
);
-- As sequências já existentes continuam a partir de sua programação original.
insert into public.appointment_series(id,teacher_id,student,starts_at,anchor_date,duration,notes,created_by,created_at)
select distinct on(series_id) series_id,teacher_id,student,starts_at,(starts_at at time zone 'America/Sao_Paulo')::date,duration,notes,created_by,created_at
from public.appointments where series_id is not null order by series_id,starts_at,id
on conflict(id) do nothing;
update public.appointments set occurrence_date=(starts_at at time zone 'America/Sao_Paulo')::date where series_id is not null and occurrence_date is null;
create unique index if not exists appointments_series_occurrence on public.appointments(series_id,occurrence_date);
drop index if exists public.appointments_student_time;
create unique index appointments_student_time on public.appointments(lower(trim(student)),starts_at) where status<>'canceled';
create index if not exists appointment_events_date on public.appointment_events(event_at desc);
create index if not exists appointment_events_appointment on public.appointment_events(appointment_id,kind);
create index if not exists appointments_status_date on public.appointments(status,starts_at);
alter table public.teacher_schedule enable row level security;
alter table public.appointment_series enable row level security;
alter table public.appointment_events enable row level security;
drop policy if exists "Equipe gerencia dias fixos" on public.teacher_schedule;
create policy "Equipe gerencia dias fixos" on public.teacher_schedule for all to authenticated
using(exists(select 1 from public.staff where user_id=auth.uid())) with check(exists(select 1 from public.staff where user_id=auth.uid()));
drop policy if exists "Equipe gerencia recorrência" on public.appointment_series;
create policy "Equipe gerencia recorrência" on public.appointment_series for all to authenticated
using(exists(select 1 from public.staff where user_id=auth.uid())) with check(exists(select 1 from public.staff where user_id=auth.uid()));
drop policy if exists "Equipe consulta histórico" on public.appointment_events;
create policy "Equipe consulta histórico" on public.appointment_events for select to authenticated
using(exists(select 1 from public.staff where user_id=auth.uid()));
grant select,insert,update,delete on public.teacher_schedule,public.appointment_series to authenticated;
grant select on public.appointment_events to authenticated;
revoke all on public.teacher_schedule,public.appointment_series,public.appointment_events from anon;

create or replace function public.audit_appointment() returns trigger
language plpgsql security definer set search_path=public as $$
declare kinds text[]:='{}'; k text; previous_teacher uuid; expected uuid; actor text;
begin
  if current_setting('like.materializing',true)='on' then return new; end if;
  select name into actor from public.staff where user_id=auth.uid();
  if tg_op='INSERT' then
    kinds:=array_append(kinds,'scheduled');
    select ts.teacher_id into expected from public.teacher_schedule ts join public.teachers t on t.id=ts.teacher_id and t.active
      where ts.weekday=extract(dow from new.starts_at at time zone 'America/Sao_Paulo');
    if expected is not null and expected<>new.teacher_id then kinds:=array_append(kinds,'teacher_changed');previous_teacher:=expected;end if;
  else
    previous_teacher:=old.teacher_id;
    if new.teacher_id<>old.teacher_id then kinds:=array_append(kinds,'teacher_changed');end if;
    if new.starts_at<>old.starts_at then kinds:=array_append(kinds,'rescheduled');end if;
    if new.status<>old.status then kinds:=array_append(kinds,new.status);end if;
  end if;
  foreach k in array kinds loop
    insert into public.appointment_events(appointment_id,kind,student,teacher_id,from_teacher_id,starts_at,reason,actor_name,actor_id)
    values(new.id,k,new.student,new.teacher_id,previous_teacher,new.starts_at,new.change_reason,coalesce(actor,'Equipe LIKE'),auth.uid());
  end loop;
  return new;
end $$;
drop trigger if exists appointments_audit on public.appointments;
create trigger appointments_audit after insert or update on public.appointments for each row execute function public.audit_appointment();
revoke all on function public.audit_appointment() from public,anon,authenticated;

create or replace function public.save_teacher_schedule(record jsonb,weekdays integer[],teacher_id uuid default null)
returns uuid language plpgsql security invoker set search_path=public as $$
declare tid uuid:=coalesce(teacher_id,gen_random_uuid());
begin
  if not exists(select 1 from public.staff where user_id=auth.uid()) then raise exception 'Funcionário não autorizado.';end if;
  perform pg_advisory_xact_lock(hashtext('like-agenda-write'));
  if exists(select 1 from unnest(weekdays) d where d<0 or d>6) then raise exception 'Dia da semana inválido.';end if;
  if exists(select 1 from public.teacher_schedule ts where ts.weekday=any(weekdays) and ts.teacher_id<>tid) then
    raise exception 'Um dos dias já possui professor fixo. Altere os dias desse professor primeiro.';
  end if;
  if teacher_id is null then
    insert into public.teachers(id,name,specialty,active) values(tid,trim(record->>'name'),coalesce(record->>'specialty',''),coalesce((record->>'active')::boolean,true));
  else
    update public.teachers set name=trim(record->>'name'),specialty=coalesce(record->>'specialty',''),active=(record->>'active')::boolean where id=tid;
    if not found then raise exception 'Professor não encontrado. Atualize a página.';end if;
  end if;
  delete from public.teacher_schedule ts where ts.teacher_id=tid;
  insert into public.teacher_schedule(weekday,teacher_id) select distinct d,tid from unnest(weekdays) d;
  return tid;
end $$;

create or replace function public.agenda_range(from_date date,to_date date)
returns jsonb language plpgsql stable security invoker set search_path=public as $$
declare result jsonb;
begin
  if not exists(select 1 from public.staff where user_id=auth.uid()) then raise exception 'Funcionário não autorizado.';end if;
  if from_date is null or to_date is null or to_date<from_date or to_date-from_date>370 then raise exception 'Período inválido (máximo 371 dias).';end if;
  with actual as (
    select to_jsonb(a)||jsonb_build_object('virtual',false) as row from public.appointments a
    where a.starts_at >= from_date::timestamp at time zone 'America/Sao_Paulo'
      and a.starts_at < (to_date+1)::timestamp at time zone 'America/Sao_Paulo'
  ), virtual as (
    select jsonb_build_object('id',md5(s.id::text||o.key_date::text)::uuid,'series_id',s.id,'occurrence_date',o.key_date,
      'teacher_id',s.teacher_id,'student',s.student,'starts_at',o.starts_at,'duration',s.duration,'notes',s.notes,
      'change_reason',s.change_reason,'rescheduled',s.rescheduled,'status','scheduled','created_at',s.created_at,'created_by',s.created_by,'virtual',true) as row
    from public.appointment_series s
    cross join lateral generate_series(
      greatest(0,ceil(extract(epoch from ((from_date::timestamp at time zone 'America/Sao_Paulo')-s.starts_at))/604800)::integer),
      floor(extract(epoch from (((to_date+1)::timestamp at time zone 'America/Sao_Paulo')-s.starts_at-interval '1 microsecond'))/604800)::integer
    ) n
    cross join lateral (select s.starts_at+n*interval '7 days' as starts_at,s.anchor_date+n*7 as key_date) o
    where (s.stopped_at is null or o.starts_at<s.stopped_at)
      and not exists(select 1 from public.appointments a where (a.series_id=s.id and a.occurrence_date=o.key_date)
        or (a.status<>'canceled' and lower(trim(a.student))=lower(trim(s.student)) and a.starts_at=o.starts_at))
  ) select coalesce(jsonb_agg(row order by row->>'starts_at'),'[]'::jsonb) into result from (select * from actual union all select * from virtual) combined;
  return result;
end $$;

create or replace function public.assert_series_available(series_key uuid) returns void
language plpgsql security invoker set search_path=public as $$
declare s public.appointment_series;
begin
  select * into strict s from public.appointment_series where id=series_key;
  if exists(select 1 from public.appointment_series other where other.id<>s.id
    and lower(trim(other.student))=lower(trim(s.student))
    and mod(extract(epoch from (other.starts_at-s.starts_at))::numeric,604800)=0
    and (other.stopped_at is null or other.stopped_at>s.starts_at)
    and (s.stopped_at is null or s.stopped_at>other.starts_at)) then
    raise exception 'Este aluno já possui uma sequência nesse dia e horário.';
  end if;
  if exists(select 1 from public.appointments a where a.series_id is distinct from s.id and a.status<>'canceled'
    and lower(trim(a.student))=lower(trim(s.student)) and a.starts_at>=s.starts_at
    and (s.stopped_at is null or a.starts_at<s.stopped_at)
    and mod(extract(epoch from (a.starts_at-s.starts_at))::numeric,604800)=0) then
    raise exception 'Este aluno já possui aula em uma das datas dessa sequência.';
  end if;
end $$;

create or replace function public.manage_appointment(action text,record jsonb,appointment_id uuid default null,scope text default 'one')
returns uuid language plpgsql security invoker set search_path=public as $$
declare old public.appointments; target public.appointments; template public.appointment_series; candidate public.appointments;
  sid uuid; delta interval; key_date date; n integer; row_id uuid:=coalesce(appointment_id,gen_random_uuid());
  result_id uuid; is_all boolean:=scope='all'; previous_setting text;
begin
  if not exists(select 1 from public.staff where user_id=auth.uid()) then raise exception 'Funcionário não autorizado.';end if;
  if action not in ('save','status') or scope not in ('one','all') then raise exception 'Operação inválida.';end if;
  perform pg_advisory_xact_lock(hashtext('like-agenda-write'));
  if appointment_id is not null then
    select * into old from public.appointments where id=appointment_id for update;
    if not found then
      sid:=(record->>'original_series_id')::uuid;key_date:=(record->>'occurrence_date')::date;
      select * into template from public.appointment_series where id=sid for update;
      if not found or key_date is null or key_date<template.anchor_date or mod(key_date-template.anchor_date,7)<>0
        or appointment_id<>md5(sid::text||key_date::text)::uuid then raise exception 'A agenda mudou. Atualize e tente novamente.';end if;
      n:=(key_date-template.anchor_date)/7;
      if template.stopped_at is not null and template.starts_at+n*interval '7 days'>=template.stopped_at then raise exception 'Esta sequência foi encerrada. Atualize a agenda.';end if;
      previous_setting:=current_setting('like.materializing',true);perform set_config('like.materializing','on',true);
      insert into public.appointments(id,series_id,occurrence_date,student,teacher_id,starts_at,duration,notes,created_by,change_reason,rescheduled)
      values(appointment_id,sid,key_date,template.student,template.teacher_id,template.starts_at+n*interval '7 days',template.duration,template.notes,template.created_by,template.change_reason,template.rescheduled)
      returning * into old;
      perform set_config('like.materializing',coalesce(previous_setting,''),true);
    end if;
  end if;
  if action='status' then
    if appointment_id is null or record->>'status' not in ('scheduled','attended','canceled') then raise exception 'Situação inválida.';end if;
    if record->>'status'='attended' and old.starts_at>now() then raise exception 'A aula ainda não começou. Confirme o atendimento após o início.';end if;
    if is_all and old.series_id is not null and record->>'status'='canceled' then
      update public.appointment_series set stopped_at=least(coalesce(stopped_at,old.starts_at),old.starts_at) where id=old.series_id;
      update public.appointments set status='canceled',change_reason=coalesce(record->>'change_reason','')
        where series_id=old.series_id and status='scheduled' and starts_at>=old.starts_at;
    else
      update public.appointments set status=record->>'status',change_reason=coalesce(record->>'change_reason','') where id=row_id;
    end if;
    return row_id;
  end if;
  if appointment_id is not null and old.status<>'scheduled' then raise exception 'Reabra a aula antes de alterar seus dados.';end if;
  candidate.student:=trim(record->>'student');candidate.teacher_id:=(record->>'teacher_id')::uuid;
  candidate.starts_at:=(record->>'starts_at')::timestamptz;candidate.duration:=(record->>'duration')::integer;
  candidate.notes:=coalesce(record->>'notes','');candidate.change_reason:=coalesce(record->>'change_reason','');
  if not exists(select 1 from public.teachers where id=candidate.teacher_id and (active or id=old.teacher_id)) then raise exception 'Escolha um professor ativo.';end if;
  if exists(select 1 from jsonb_array_elements(public.agenda_range((candidate.starts_at at time zone 'America/Sao_Paulo')::date,(candidate.starts_at at time zone 'America/Sao_Paulo')::date)) v
    where lower(trim(v->>'student'))=lower(trim(candidate.student)) and (v->>'starts_at')::timestamptz=candidate.starts_at
    and v->>'status'<>'canceled' and (v->>'id')::uuid<>row_id
    and not(is_all and old.series_id is not null and (v->>'series_id')::uuid=old.series_id)) then
      raise exception 'Este aluno já está agendado nesse horário.';
  end if;
  if appointment_id is null then
    sid:=case when record->>'repeat'='weekly' then gen_random_uuid() else null end;
    if sid is not null then
      insert into public.appointment_series(id,student,teacher_id,starts_at,anchor_date,duration,notes,change_reason)
      values(sid,candidate.student,candidate.teacher_id,candidate.starts_at,(candidate.starts_at at time zone 'America/Sao_Paulo')::date,candidate.duration,candidate.notes,candidate.change_reason);
      perform public.assert_series_available(sid);
    end if;
    insert into public.appointments(id,series_id,occurrence_date,student,teacher_id,starts_at,duration,notes,change_reason)
    values(row_id,sid,case when sid is not null then (candidate.starts_at at time zone 'America/Sao_Paulo')::date end,candidate.student,candidate.teacher_id,candidate.starts_at,candidate.duration,candidate.notes,candidate.change_reason);
  elsif is_all and old.series_id is not null then
    delta:=candidate.starts_at-old.starts_at;
    update public.appointment_series s set student=candidate.student,teacher_id=candidate.teacher_id,starts_at=s.starts_at+delta,
      duration=candidate.duration,notes=candidate.notes,change_reason=candidate.change_reason,rescheduled=s.rescheduled or delta<>interval '0',stopped_at=s.stopped_at+delta where id=old.series_id;
    perform public.assert_series_available(old.series_id);
    for target in select * from public.appointments where series_id=old.series_id and status='scheduled'
      order by case when delta>=interval '0' then -extract(epoch from starts_at) else extract(epoch from starts_at) end loop
      update public.appointments set student=candidate.student,teacher_id=candidate.teacher_id,starts_at=target.starts_at+delta,
        duration=candidate.duration,notes=candidate.notes,change_reason=candidate.change_reason,rescheduled=target.rescheduled or delta<>interval '0' where id=target.id;
    end loop;
  else
    update public.appointments set student=candidate.student,teacher_id=candidate.teacher_id,starts_at=candidate.starts_at,
      duration=candidate.duration,notes=candidate.notes,change_reason=candidate.change_reason,rescheduled=old.rescheduled or old.starts_at<>candidate.starts_at where id=row_id;
  end if;
  return row_id;
end $$;

create or replace function public.staff_report(from_date date,to_date date,teacher_id_filter uuid default null)
returns jsonb language plpgsql stable security invoker set search_path=public as $$
declare result jsonb;
begin
  if not exists(select 1 from public.staff where user_id=auth.uid()) then raise exception 'Funcionário não autorizado.';end if;
  if from_date is null or to_date is null or to_date<from_date or to_date-from_date>370 then raise exception 'Selecione um período de até 371 dias.';end if;
  with rows as (
    select a.* from jsonb_to_recordset(public.agenda_range(from_date,to_date)) as a(id uuid,teacher_id uuid,status text,rescheduled boolean)
    where teacher_id_filter is null or a.teacher_id=teacher_id_filter
  ), totals as (
    select count(*) filter(where status='attended') as attended,count(*) filter(where status='canceled') as canceled,
      count(*) filter(where rescheduled) as rescheduled from rows
  ), teachers as (
    select t.id,t.name,t.active,(select count(*) from rows a where a.teacher_id=t.id and a.status='attended') as attended
    from public.teachers t where teacher_id_filter is null or t.id=teacher_id_filter
  ), recent as (
    select e.* from public.appointment_events e where e.reason<>'' and (e.event_at at time zone 'America/Sao_Paulo')::date between from_date and to_date
      and (teacher_id_filter is null or e.teacher_id=teacher_id_filter) order by e.event_at desc,e.id desc limit 30
  ) select jsonb_build_object('summary',(select to_jsonb(totals) from totals),'teachers',coalesce((select jsonb_agg(to_jsonb(teachers) order by name) from teachers),'[]'::jsonb),
    'recent',coalesce((select jsonb_agg(to_jsonb(recent) order by event_at desc) from recent),'[]'::jsonb)) into result;
  return result;
end $$;
revoke all on function public.save_teacher_schedule(jsonb,integer[],uuid),public.agenda_range(date,date),public.assert_series_available(uuid),public.manage_appointment(text,jsonb,uuid,text),public.staff_report(date,date,uuid) from public,anon;
grant execute on function public.save_teacher_schedule(jsonb,integer[],uuid),public.agenda_range(date,date),public.assert_series_available(uuid),public.manage_appointment(text,jsonb,uuid,text),public.staff_report(date,date,uuid) to authenticated;

savepoint feature_validation;
select set_config('request.jwt.claim.sub',(select user_id::text from public.staff order by user_id limit 1),true);
set local role authenticated;
do $$
declare t1 uuid;t2 uuid;aid uuid;sid uuid;student_name text:='TESTE '||gen_random_uuid();
  sample jsonb;candidate jsonb;dashboard jsonb;distant jsonb;before_count integer;
begin
  delete from public.teacher_schedule;
  t1:=public.save_teacher_schedule('{"name":"Teste Professora Fixa","active":true}'::jsonb,array[3,5],null);
  t2:=public.save_teacher_schedule('{"name":"Teste Substituta","active":true}'::jsonb,array[]::integer[],null);
  if (select count(*) from public.teacher_schedule where teacher_id=t1)<>2 then raise exception 'Dias fixos não gravados';end if;
  begin
    perform public.save_teacher_schedule('{"name":"Conflito","active":true}'::jsonb,array[3],null);
    raise exception 'Dia fixo duplicado foi aceito';
  exception when raise_exception then if sqlerrm not like 'Um dos dias já possui%' then raise;end if;end;
  candidate:=jsonb_build_object('student',student_name,'teacher_id',t1,'starts_at','2020-01-08T11:00:00Z','duration',60,'notes','','repeat','weekly');
  aid:=public.manage_appointment('save',candidate,null,'one');
  select series_id into sid from public.appointments where id=aid;
  if sid is null then raise exception 'Programação não criada';end if;
  distant:=public.agenda_range('2040-01-01','2040-01-31');
  if (select count(*) from jsonb_array_elements(distant) v where (v->>'series_id')::uuid=sid)<>4 then raise exception 'Recorrência distante não exibida';end if;
  if (select count(*) from public.appointments where series_id=sid)<>1 then raise exception 'Recorrência materializou aulas desnecessárias';end if;
  select v into sample from jsonb_array_elements(public.agenda_range('2020-01-15','2020-01-15')) v where (v->>'series_id')::uuid=sid;
  perform public.manage_appointment('status',jsonb_build_object('status','canceled','original_series_id',sid,'occurrence_date',sample->>'occurrence_date','change_reason','Viagem'),(sample->>'id')::uuid,'one');
  if (select count(*) from jsonb_array_elements(public.agenda_range('2020-01-15','2020-01-15')) v where (v->>'series_id')::uuid=sid and v->>'status'='canceled')<>1 then raise exception 'Desmarcação reapareceu como agendada';end if;
  select v into sample from jsonb_array_elements(public.agenda_range('2020-01-22','2020-01-22')) v where (v->>'series_id')::uuid=sid;
  candidate:=jsonb_build_object('student',student_name,'teacher_id',t2,'starts_at','2020-01-23T12:00:00Z','duration',60,'notes','','original_series_id',sid,'occurrence_date',sample->>'occurrence_date','change_reason','Substituição de teste');
  perform public.manage_appointment('save',candidate,(sample->>'id')::uuid,'one');
  perform public.manage_appointment('status',jsonb_build_object('status','attended'),(sample->>'id')::uuid,'one');
  dashboard:=public.staff_report('2020-01-01','2020-01-31',t2);
  if (dashboard->'summary'->>'attended')::integer<>1 or (dashboard->'summary'->>'rescheduled')::integer<>1 then raise exception 'Indicadores incorretos: %',dashboard;end if;
  if not exists(select 1 from public.appointment_events where appointment_id=(sample->>'id')::uuid and kind='teacher_changed' and reason='Substituição de teste') then raise exception 'Justificativa não registrada';end if;
  select v into sample from jsonb_array_elements(public.agenda_range('2020-01-29','2020-01-29')) v where (v->>'series_id')::uuid=sid;
  candidate:=jsonb_build_object('student',student_name,'teacher_id',t1,'starts_at','2020-01-30T11:00:00Z','duration',60,'notes','','original_series_id',sid,'occurrence_date',sample->>'occurrence_date');
  perform public.manage_appointment('save',candidate,(sample->>'id')::uuid,'all');
  if not exists(select 1 from public.appointments where series_id=sid and status='attended' and starts_at='2020-01-23T12:00:00Z') then raise exception 'Histórico de atendimento alterado';end if;
  if not exists(select 1 from public.appointments where series_id=sid and status='canceled' and starts_at='2020-01-15T11:00:00Z') then raise exception 'Histórico de desmarcação alterado';end if;
  if exists(select 1 from jsonb_array_elements(public.agenda_range('2040-01-01','2040-01-31')) v where (v->>'series_id')::uuid=sid and extract(dow from (v->>'starts_at')::timestamptz at time zone 'America/Sao_Paulo')<>4) then raise exception 'Programação futura não mudou de dia';end if;
  select v into sample from jsonb_array_elements(public.agenda_range('2020-02-06','2020-02-06')) v where (v->>'series_id')::uuid=sid;
  perform public.manage_appointment('status',jsonb_build_object('status','canceled','original_series_id',sid,'occurrence_date',sample->>'occurrence_date'),(sample->>'id')::uuid,'all');
  if exists(select 1 from jsonb_array_elements(public.agenda_range('2040-01-01','2040-01-31')) v where (v->>'series_id')::uuid=sid) then raise exception 'Sequência encerrada continua aparecendo';end if;
end $$;
rollback to savepoint feature_validation;
commit;
select 'OK: dias fixos, recorrência até 2040 sem materialização, desmarcação, substituição, justificativa, reagendamento, atendimento, painel, edição em conjunto e encerramento. Testes revertidos.' as verificacao;
