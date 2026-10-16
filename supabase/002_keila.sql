-- Cadastro descritivo; o cargo não concede poderes administrativos no Supabase.
begin;
alter table public.staff add column if not exists name text not null default '';
alter table public.staff add column if not exists job_title text not null default '';
insert into public.staff(user_id,name,job_title)
select id, 'Keila de Oliveira', 'CEO'
from auth.users where id = '8bd3ec43-9988-4c33-afbf-637efa618d28'
and lower(email) = 'keila.oliveiramendes@yahoo.com.br'
on conflict(user_id) do update set name=excluded.name, job_title=excluded.job_title;
commit;
select s.name, s.job_title, u.email from public.staff s
join auth.users u on u.id=s.user_id
where s.user_id='8bd3ec43-9988-4c33-afbf-637efa618d28';
