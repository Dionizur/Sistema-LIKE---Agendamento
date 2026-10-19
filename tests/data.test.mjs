import {test} from 'node:test';
import assert from 'node:assert/strict';
const storage=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};};
globalThis.window={LIKE_CONFIG:{}};
globalThis.localStorage=storage();
globalThis.sessionStorage=storage();
const db=await import('../src/data.js');
test('Cadastro, edição e inativação de professor preservam o histórico da aula',async()=>{
  await db.save('teachers',{name:'Professora Teste',specialty:'Pilates',active:true});
  let data=await db.load('2026-10-01','2026-10-31');const teacher=data.teachers[0];
  await db.save('appointments',{teacher_id:teacher.id,student:'Aluno Teste',starts_at:'2026-10-16T11:00:00Z',duration:60,notes:'Adaptação de exercício'});
  await db.save('teachers',{name:'Professora Editada',active:false},teacher.id);
  data=await db.load('2026-10-01','2026-10-31');assert.equal(data.teachers[0].active,false);assert.equal(data.appointments[0].teacher_id,teacher.id);assert.equal(data.appointments[0].notes,'Adaptação de exercício');
});
test('Edição e exclusão de aula atingem somente o agendamento escolhido',async()=>{
  const {appointments}=await db.load('2026-10-01','2026-10-31');const id=appointments[0].id;
  await db.save('appointments',{student:'Outro Aluno',duration:45},id);
  assert.equal((await db.load('2026-10-01','2026-10-31')).appointments[0].duration,45);
  await db.remove('appointments',id);
  assert.equal((await db.load('2026-10-01','2026-10-31')).appointments.length,0);
  assert.equal((await db.load('2026-10-01','2026-10-31')).teachers.length,1);
});
test('Login usa autenticação real e verifica autorização de funcionário',async()=>{
  window.LIKE_CONFIG={supabaseUrl:'https://example.supabase.co',supabaseKey:'public-test'};
  const remote=await import('../src/data.js?remote');const calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.includes('/token')?{access_token:'test-token',refresh_token:'test-refresh',expires_in:3600,user:{id:'staff-id'}}:[{user_id:'staff-id'}]),{status:200});};
  await remote.login('test@example.com','test-password');
  assert.equal(remote.user().id,'staff-id');assert.match(calls[0].url,/grant_type=password/);assert.equal(JSON.parse(calls[0].options.body).email,'test@example.com');
  assert.match(calls[1].url,/staff/);
});
test('Usuário autenticado sem autorização não mantém sessão',async()=>{
  const remote=await import('../src/data.js?denied');
  globalThis.fetch=async url=>new Response(JSON.stringify(url.includes('/token')?{access_token:'token',refresh_token:'refresh',expires_in:3600,user:{id:'outsider'}}:[]),{status:200});
  await assert.rejects(remote.login('outsider@example.com','password'),/Funcionário não autorizado/);
  assert.equal(remote.user(),undefined);
  assert.equal(sessionStorage.getItem('like-session'),null);
});
test('Duas leituras simultâneas renovam o token apenas uma vez',async()=>{
  sessionStorage.setItem('like-session',JSON.stringify({access_token:'expired',refresh_token:'refresh',expires_at:0,user:{id:'staff-id'}}));
  const remote=await import('../src/data.js?renew');let renewals=0;
  globalThis.fetch=async(url,options)=>{
    if(url.includes('grant_type=refresh_token')){renewals++;await new Promise(resolve=>setTimeout(resolve,5));return new Response(JSON.stringify({access_token:'renewed',refresh_token:'next',expires_in:3600,user:{id:'staff-id'}}));}
    assert.equal(options.headers.Authorization,'Bearer renewed');
    return new Response(JSON.stringify(url.includes('/staff?')?[{user_id:'staff-id',name:'Keila de Oliveira',job_title:'CEO'}]:[]));
  };
  await Promise.all([remote.load(),remote.load()]);
  assert.equal(renewals,1);assert.equal(remote.user().staff.name,'Keila de Oliveira');
});
test('Sessão revogada é removida quando o servidor responde 401',async()=>{
  sessionStorage.setItem('like-session',JSON.stringify({access_token:'invalid',expires_at:Date.now()/1000+3600,user:{id:'staff-id'}}));
  const remote=await import('../src/data.js?revoked');
  globalThis.fetch=async()=>new Response(JSON.stringify({message:'JWT invalid'}),{status:401});
  await assert.rejects(remote.load(),/sessão expirou/);assert.equal(remote.user(),undefined);
});
test('Professores carregam além do primeiro lote de registros',async()=>{
  sessionStorage.setItem('like-session',JSON.stringify({access_token:'valid',expires_at:Date.now()/1000+3600,user:{id:'staff-id'}}));
  const remote=await import('../src/data.js?pagination');
  globalThis.fetch=async url=>{
    if(url.includes('/staff?'))return new Response(JSON.stringify([{user_id:'staff-id'}]));
    const rows=url.includes('/teachers?')?(url.includes('offset=0')?Array.from({length:500},(_,id)=>({id})): [{id:500}]):[];
    return new Response(JSON.stringify(rows));
  };
  assert.equal((await remote.load()).teachers.length,501);
});


const raw=()=>JSON.parse(localStorage.getItem('like-demo-v1'));
const reset=()=>localStorage.setItem('like-demo-v1',JSON.stringify({teachers:[],appointments:[],schedule:[],series:[],events:[]}));
const lesson=(teacher,starts='2020-01-06T11:00:00Z',extra={})=>({student:'Aluno Fixo',teacher_id:teacher,starts_at:starts,duration:60,notes:'',change_reason:'',...extra});
test('Dias fixos sugerem somente professores ativos e não permitem duplicar o dia',async()=>{
  reset();await db.saveTeacher({name:'Keila',active:true},[3,5]);
  const data=await db.load(),teacher=data.teachers[0];
  assert.equal(db.teacherForDate(data.teachers,data.schedule,'2026-10-21').id,teacher.id);
  assert.equal(db.teacherForDate(data.teachers,data.schedule,'2026-10-20'),undefined);
  await assert.rejects(db.saveTeacher({name:'Outra',active:true},[3]),/já possui/);
  assert.equal(raw().teachers.length,1);
  await db.saveTeacher({name:'Keila',active:false},[3,5],teacher.id);
  const inactive=await db.load();assert.equal(db.teacherForDate(inactive.teachers,inactive.schedule,'2026-10-21'),undefined);
});
test('Recorrência não possui data final e não grava milhares de aulas',async()=>{
  reset();await db.saveTeacher({name:'Professora',active:true},[]);const teacher=raw().teachers[0];
  await db.updateAppointment(lesson(teacher.id,undefined,{repeat:'weekly'}));
  assert.equal(raw().appointments.length,1);assert.equal(raw().series.length,1);
  const future=await db.load('2040-01-01','2040-01-31');
  assert.equal(future.appointments.length,5);assert.ok(future.appointments.every(a=>a.virtual));
  assert.equal(raw().appointments.length,1);
});
test('Desmarcar ocorrência virtual não a recria e não interrompe a sequência',async()=>{
  const week=await db.load('2020-01-13','2020-01-19'),a=week.appointments[0];
  await db.setAppointmentStatus(a,'canceled','Viagem');
  const same=await db.load('2020-01-13','2020-01-19');
  assert.equal(same.appointments.length,1);assert.equal(same.appointments[0].status,'canceled');
  assert.equal((await db.load('2020-01-20','2020-01-26')).appointments.length,1);
});
test('Troca com justificativa e reagendamento aparecem no painel do professor que atendeu',async()=>{
  await db.saveTeacher({name:'Substituta',active:true},[]);const teacher=raw().teachers[1];
  const a=(await db.load('2020-01-20','2020-01-26')).appointments[0];
  await db.updateAppointment(lesson(teacher.id,'2020-01-21T12:00:00Z',{change_reason:'Cobertura de férias'}),a);
  const edited=(await db.load('2020-01-20','2020-01-26')).appointments[0];
  await db.setAppointmentStatus(edited,'attended');
  const report=await db.getReport('2020-01-01','2020-01-31');
  assert.equal(report.summary.attended,1);assert.equal(report.summary.canceled,1);assert.equal(report.summary.rescheduled,1);
  assert.equal(report.teachers.find(t=>t.id===teacher.id).attended,1);
  const currentReport=await db.getReport(db.studioDay(new Date()),db.studioDay(new Date()));
  assert.ok(currentReport.recent.some(e=>e.reason==='Cobertura de férias'&&e.kind==='teacher_changed'));
  assert.ok(currentReport.recent.some(e=>e.reason==='Cobertura de férias'&&e.kind==='rescheduled'));
});
test('Editar todas preserva atendimentos, cancelamentos e muda semanas distantes',async()=>{
  const a=(await db.load('2020-01-27','2020-02-02')).appointments[0];
  await db.updateAppointment(lesson(a.teacher_id,'2020-01-28T11:00:00Z'),a,'all');
  const jan=await db.load('2020-01-01','2020-01-31');
  assert.equal(jan.appointments.find(row=>row.status==='attended').starts_at,'2020-01-21T12:00:00Z');
  assert.equal(jan.appointments.find(row=>row.status==='canceled').starts_at,'2020-01-13T11:00:00.000Z');
  const distant=await db.load('2040-01-01','2040-01-31');
  assert.ok(distant.appointments.every(row=>new Date(row.starts_at).getUTCDay()===2));
  assert.ok(distant.appointments.every(row=>row.rescheduled));
});
test('Encerrar sequência impede aulas futuras e preserva o histórico anterior',async()=>{
  const a=(await db.load('2020-02-01','2020-02-07')).appointments[0];
  await db.setAppointmentStatus(a,'canceled','Encerramento do plano','all');
  assert.equal((await db.load('2040-01-01','2040-01-31')).appointments.length,0);
  assert.equal((await db.getReport('2020-01-01','2020-01-31')).summary.attended,1);
});
test('Conflito entre programações é rejeitado sem alteração parcial',async()=>{
  reset();await db.saveTeacher({name:'Professora',active:true},[]);const teacher=raw().teachers[0];
  await db.updateAppointment(lesson(teacher.id,undefined,{repeat:'weekly'}));const before=JSON.stringify(raw());
  await assert.rejects(db.updateAppointment(lesson(teacher.id,'2021-01-04T11:00:00Z',{repeat:'weekly'})),/agendado|sequência/);
  assert.equal(JSON.stringify(raw()),before);
});
