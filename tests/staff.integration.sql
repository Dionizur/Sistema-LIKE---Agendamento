-- Teste em transação: nenhuma aula, professor, dia fixo ou evento é mantido.
begin;
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
rollback;
select 'OK: dias fixos, recorrência até 2040 sem materialização, desmarcação, substituição, justificativa, reagendamento, atendimento, painel, edição em conjunto e encerramento. Testes revertidos.' as verificacao;
