import {test} from 'node:test';
import assert from 'node:assert/strict';
const storage=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};};
globalThis.window={LIKE_CONFIG:{}};
globalThis.localStorage=storage();
globalThis.sessionStorage=storage();
const db=await import('../src/data.js');
test('Cadastro, edição e inativação de professor preservam o histórico da aula',async()=>{
  await db.save('teachers',{name:'Professora Teste',specialty:'Pilates',active:true});
  let data=await db.load();const teacher=data.teachers[0];
  await db.save('appointments',{teacher_id:teacher.id,student:'Aluno Teste',starts_at:'2026-10-16T11:00:00Z',duration:60,notes:'Adaptação de exercício'});
  await db.save('teachers',{name:'Professora Editada',active:false},teacher.id);
  data=await db.load();assert.equal(data.teachers[0].active,false);assert.equal(data.appointments[0].teacher_id,teacher.id);assert.equal(data.appointments[0].notes,'Adaptação de exercício');
});
test('Edição e exclusão de aula atingem somente o agendamento escolhido',async()=>{
  const {appointments}=await db.load();const id=appointments[0].id;
  await db.save('appointments',{student:'Outro Aluno',duration:45},id);
  assert.equal((await db.load()).appointments[0].duration,45);
  await db.remove('appointments',id);
  assert.equal((await db.load()).appointments.length,0);
  assert.equal((await db.load()).teachers.length,1);
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
test('Agenda carrega além do primeiro lote de registros',async()=>{
  sessionStorage.setItem('like-session',JSON.stringify({access_token:'valid',expires_at:Date.now()/1000+3600,user:{id:'staff-id'}}));
  const remote=await import('../src/data.js?pagination');
  globalThis.fetch=async url=>{
    if(url.includes('/staff?'))return new Response(JSON.stringify([{user_id:'staff-id'}]));
    const rows=url.includes('/appointments?')?(url.includes('offset=0')?Array.from({length:500},(_,id)=>({id})): [{id:500}]):[];
    return new Response(JSON.stringify(rows));
  };
  assert.equal((await remote.load()).appointments.length,501);
});

test('Recorrência semanal inclui a data final e atravessa meses',()=>{
  const rows=db.weeklyRecords({student:'Recorrente',starts_at:'2026-10-26T11:00:00Z'},'2026-11-09');
  assert.equal(rows.length,3);assert.equal(rows[2].starts_at,'2026-11-09T11:00:00.000Z');
  assert.equal(new Set(rows.map(r=>r.series_id)).size,1);
  assert.equal(new Set(rows.map(r=>r.id)).size,3);
  assert.throws(()=>db.weeklyRecords(rows[0],'2026-10-25'),/data final/);
  assert.throws(()=>db.weeklyRecords(rows[0],'2030-01-01'),/104/);
});
test('Alteração da sequência desloca todas as datas e preserva outras aulas',()=>{
  const rows=db.weeklyRecords({student:'Sequência',starts_at:'2026-10-26T11:00:00Z'},'2026-11-09');
  const updated=db.sequenceChanges([...rows,{id:'unrelated'}],rows[1],{student:'Editado',starts_at:'2026-11-03T12:00:00Z'});
  assert.equal(updated.length,3);assert.equal(updated[0].starts_at,'2026-10-27T12:00:00.000Z');
  assert.equal(updated[2].id,rows[2].id);assert.equal(updated[2].student,'Editado');
});
test('Sequência local é atômica em conflitos e pode ser excluída por vínculo',async()=>{
  const rows=db.weeklyRecords({student:'Aluno Recorrente',teacher_id:'teacher',duration:60,starts_at:'2026-12-01T11:00:00Z'},'2026-12-15');
  await db.saveAppointments(rows);
  const before=JSON.stringify(await db.load());
  await assert.rejects(db.saveAppointments(db.weeklyRecords({...rows[0]},'2026-12-15')),/já está agendado/);
  assert.equal(JSON.stringify(await db.load()),before);
  const changed=db.sequenceChanges(rows,rows[0],{...rows[0],starts_at:'2026-12-08T11:00:00Z'});
  await db.saveAppointments(changed,true);
  assert.equal((await db.load()).appointments.filter(a=>a.series_id===rows[0].series_id).length,3);
  await db.removeSequence(rows[0].series_id);
  assert.equal((await db.load()).appointments.filter(a=>a.series_id===rows[0].series_id).length,0);
});
