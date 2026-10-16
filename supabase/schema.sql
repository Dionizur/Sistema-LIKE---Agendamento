-- Execute uma vez no SQL Editor do seu projeto Supabase.
begin;
create table public.staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  job_title text not null default '',
  created_at timestamptz not null default now()
);
alter table public.staff enable row level security;
create policy "Funcionário consulta sua autorização" on public.staff for select to authenticated using (user_id = auth.uid());
create table public.teachers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  specialty text not null default '' check (length(specialty) <= 120),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers(id) on delete restrict,
  student text not null check (length(trim(student)) between 1 and 120),
  starts_at timestamptz not null,
  duration integer not null check (duration in (30,45,50,60,90,120)),
  notes text not null default '' check (length(notes) <= 3000),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check ((starts_at at time zone 'America/Sao_Paulo')::time >= time '06:00'),
  check ((starts_at at time zone 'America/Sao_Paulo')::date = ((starts_at + duration * interval '1 minute') at time zone 'America/Sao_Paulo')::date),
  check (((starts_at + duration * interval '1 minute') at time zone 'America/Sao_Paulo')::time <= time '23:00')
);
create unique index appointments_student_time on public.appointments (lower(trim(student)), starts_at);
create index appointments_starts_at on public.appointments(starts_at);
create index appointments_teacher on public.appointments(teacher_id);
alter table public.teachers enable row level security;
alter table public.appointments enable row level security;
create policy "Equipe gerencia professores" on public.teachers for all to authenticated
  using (exists(select 1 from public.staff where user_id=auth.uid()))
  with check (exists(select 1 from public.staff where user_id=auth.uid()));
create policy "Equipe gerencia aulas" on public.appointments for all to authenticated
  using (exists(select 1 from public.staff where user_id=auth.uid()))
  with check (exists(select 1 from public.staff where user_id=auth.uid()));
grant select on public.staff to authenticated;
grant select,insert,update,delete on public.teachers,public.appointments to authenticated;
revoke all on public.staff,public.teachers,public.appointments from anon;
commit;
