-- Teste transacional: nenhum registro de teste fica salvo.
begin;
select set_config('request.jwt.claims', '{"sub":"8bd3ec43-9988-4c33-afbf-637efa618d28","role":"authenticated"}', true);
set local role authenticated;
do $$
declare professor uuid; aula uuid; quantidade integer;
begin
  if not exists(select 1 from public.staff where user_id=auth.uid()) then
    raise exception 'Funcionária não autorizada';
  end if;
  insert into public.teachers(name,specialty) values ('QA transacional LIKE','Teste sem persistência') returning id into professor;
  insert into public.appointments(teacher_id,student,starts_at,duration,notes)
  values(professor,'QA transacional LIKE', '2030-01-10 08:00:00-03',60,'Observação de teste') returning id into aula;
  update public.appointments set duration=45,notes='Observação editada' where id=aula;
  select count(*) into quantidade from public.appointments where id=aula and duration=45 and notes='Observação editada' and created_by=auth.uid();
  if quantidade<>1 then raise exception 'Falha na leitura/edição da aula'; end if;
  delete from public.appointments where id=aula;
  if exists(select 1 from public.appointments where id=aula) then raise exception 'Falha na exclusão'; end if;
  update public.teachers set active=false where id=professor;
  if not exists(select 1 from public.teachers where id=professor and active=false) then raise exception 'Falha na inativação'; end if;
end $$;
rollback;
select 'OK: acesso da Keila, cadastro, leitura, edição, exclusão de aula e inativação de professor. Testes revertidos.' as verificacao;
