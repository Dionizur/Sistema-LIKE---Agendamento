const config = window.LIKE_CONFIG || {};
export const connected = Boolean(config.supabaseUrl && config.supabaseKey);
let session;
try { session = JSON.parse(sessionStorage.getItem('like-session') || 'null'); } catch { sessionStorage.removeItem('like-session'); }
let renewing;
export const user = () => session?.user;
function clearSession() {session=null;sessionStorage.removeItem('like-session');}
async function request(path, options = {}, auth = true) {
  if(auth && session && session.expires_at < Date.now()/1000+60) {
    if(!renewing) renewing=request('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:session.refresh_token})},false).then(saveSession).catch(error=>{clearSession();throw error;}).finally(()=>{renewing=null;});
    await renewing;
  }
  const response = await fetch(config.supabaseUrl.replace(/\/$/,'')+path,{...options,headers:{apikey:config.supabaseKey,'Content-Type':'application/json',...(auth ? {Authorization:`Bearer ${session?.access_token || config.supabaseKey}`} : {}),...options.headers}});
  const text = await response.text(); let body; try {body=text ? JSON.parse(text) : null;} catch {throw Error('Resposta inválida do servidor.');}
  if(!response.ok) {
    if(auth && response.status===401) {clearSession();throw Error('Sua sessão expirou. Entre novamente.');}
    throw Error(body?.code==='23505' ? 'Este aluno já está agendado nesse horário.' : body?.message || body?.error_description || 'Não foi possível concluir. Tente novamente.');
  }
  return body;
}
function saveSession(value) {session={...value,expires_at:Date.now()/1000+value.expires_in};sessionStorage.setItem('like-session',JSON.stringify(session));}
export async function login(email,password) {
  saveSession(await request('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email,password})},false));
  try {
    await checkStaff();
  } catch(error) {clearSession();throw error;}
}
async function checkStaff() {
  if(!session?.user?.id) throw Error('Entre novamente para acessar a agenda.');
  const staff=await request('/rest/v1/staff?select=*&user_id=eq.'+encodeURIComponent(session.user.id));
  if(!staff.length) {clearSession();throw Error('Funcionário não autorizado. Solicite acesso ao responsável pelo estúdio.');}
  session.user.staff=staff[0];sessionStorage.setItem('like-session',JSON.stringify(session));
}
export async function logout() {try {if(connected&&session) await request('/auth/v1/logout',{method:'POST'});} finally {clearSession();}}
const demoKey='like-demo-v1';
function local() {
  const data={teachers:[],appointments:[],schedule:[],series:[],events:[],...JSON.parse(localStorage.getItem(demoKey)||'{}')};
  for(const row of data.appointments){row.status||='scheduled';row.rescheduled||=false;if(row.series_id){row.occurrence_date||=studioDay(row.starts_at);if(!data.series.some(s=>s.id===row.series_id)){const first=data.appointments.filter(a=>a.series_id===row.series_id).sort((a,b)=>new Date(a.starts_at)-new Date(b.starts_at))[0];data.series.push({...first,id:row.series_id,anchor_date:studioDay(first.starts_at)});}}}
  return data;
}
async function readAll(table,order) {
  const rows=[];let offset=0;
  for(;;) {const batch=await request(`/rest/v1/${table}?select=*&order=${order}&limit=500&offset=${offset}`);rows.push(...batch);if(batch.length<500)return rows;offset+=500;}
}
export async function load(from=studioDay(new Date()),to=from) {
  if(!connected) {const data=local();return {...data,appointments:occurrences(data,from,to)};}
  await checkStaff();
  const [teachers,schedule,appointments]=await Promise.all([readAll('teachers','name,id'),readAll('teacher_schedule','weekday'),request('/rest/v1/rpc/agenda_range',{method:'POST',body:JSON.stringify({from_date:from,to_date:to})})]);
  return {teachers,schedule,appointments:appointments||[]};
}
export async function save(table,record,id) {
  if(connected) return request(`/rest/v1/${table}${id?'?id=eq.'+encodeURIComponent(id):''}`,{method:id?'PATCH':'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(record)});
  const data=local();if(id) data[table]=data[table].map(row=>row.id===id?{...row,...record}:row);else data[table].push({...record,id:crypto.randomUUID()});localStorage.setItem(demoKey,JSON.stringify(data));
}
export async function remove(table,id) {if(connected) return request(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`,{method:'DELETE'});const data=local();data[table]=data[table].filter(row=>row.id!==id);localStorage.setItem(demoKey,JSON.stringify(data));}


export const studioDay=value=>new Date(value).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
const weekMs=7*86400000;
export function teacherForDate(teachers,schedule,date) {
  const day=new Date(date+'T12:00:00-03:00').getUTCDay();
  const assignment=schedule.find(row=>Number(row.weekday)===day);
  return teachers.find(t=>t.id===assignment?.teacher_id&&t.active);
}
export function occurrences(data,from,to) {
  const rows=data.appointments.filter(a=>studioDay(a.starts_at)>=from&&studioDay(a.starts_at)<=to);
  for(const series of data.series||[]) {
    const start=new Date(series.starts_at).getTime(), lower=new Date(from+'T00:00:00-03:00').getTime(), upper=new Date(to+'T23:59:59-03:00').getTime();
    const first=Math.max(0,Math.ceil((lower-start)/weekMs));
    for(let n=first;start+n*weekMs<=upper;n++) {
      const starts_at=new Date(start+n*weekMs).toISOString();
      if(series.stopped_at&&starts_at>=series.stopped_at)continue;
      const occurrence_date=studioDay(new Date(new Date(series.anchor_date+'T12:00:00-03:00').getTime()+n*weekMs));
      if(data.appointments.some(a=>(a.series_id===series.id&&a.occurrence_date===occurrence_date)||(a.status!=='canceled'&&a.student.trim().toLowerCase()===series.student.trim().toLowerCase()&&new Date(a.starts_at).getTime()===new Date(starts_at).getTime())))continue;
      rows.push({...series,id:`virtual:${series.id}:${occurrence_date}`,series_id:series.id,occurrence_date,starts_at,status:'scheduled',virtual:true});
    }
  }
  return rows.sort((a,b)=>new Date(a.starts_at)-new Date(b.starts_at));
}
export async function saveTeacher(record,weekdays,id=null) {
  if(connected)return request('/rest/v1/rpc/save_teacher_schedule',{method:'POST',body:JSON.stringify({record,weekdays,teacher_id:id})});
  const data=local(),teacherId=id||crypto.randomUUID();
  if(weekdays.some(day=>data.schedule.some(row=>row.weekday===day&&row.teacher_id!==teacherId)))throw Error('Um dos dias já possui professor fixo. Altere os dias desse professor primeiro.');
  data.teachers=id?data.teachers.map(t=>t.id===id?{...t,...record}:t):[...data.teachers,{...record,id:teacherId}];
  data.schedule=[...data.schedule.filter(row=>row.teacher_id!==teacherId),...weekdays.map(weekday=>({weekday,teacher_id:teacherId}))];
  localStorage.setItem(demoKey,JSON.stringify(data));
}
function localEvent(data,kind,row,before,reason='') {
  data.events.push({id:crypto.randomUUID(),kind,appointment_id:row.id,teacher_id:row.teacher_id,from_teacher_id:before?.teacher_id||null,student:row.student,starts_at:row.starts_at,reason,actor_name:'Equipe LIKE',event_at:new Date().toISOString()});
}
export async function updateAppointment(record,original=null,scope='one') {
  return appointmentAction('save',record,original,scope);
}
export async function setAppointmentStatus(original,status,reason='',scope='one') {
  return appointmentAction('status',{status,change_reason:reason},original,scope);
}
async function appointmentAction(action,record,original,scope) {
  if(connected)return request('/rest/v1/rpc/manage_appointment',{method:'POST',body:JSON.stringify({action,record:{...record,original_series_id:original?.series_id||null,occurrence_date:original?.occurrence_date||null},appointment_id:original?.id||null,scope})});
  const data=local();
  if(action==='save') {
    const candidateDay=studioDay(record.starts_at);
    if(occurrences(data,candidateDay,candidateDay).some(row=>row.status!=='canceled'&&row.id!==original?.id&&!(scope==='all'&&original?.series_id&&row.series_id===original.series_id)&&row.student.trim().toLowerCase()===record.student.trim().toLowerCase()&&new Date(row.starts_at).getTime()===new Date(record.starts_at).getTime()))throw Error('Este aluno já está agendado nesse horário.');
  }
  let previous=original?data.appointments.find(a=>a.id===original.id):null;
  if(original&&!previous){if(!original.virtual)throw Error('A agenda mudou. Atualize e tente novamente.');previous={...original,virtual:false};data.appointments.push(previous);}
  if(action==='status') {
    if(record.status==='attended'&&new Date(previous.starts_at)>new Date())throw Error('A aula ainda não começou. Confirme o atendimento após o início.');
    const targets=scope==='all'&&previous.series_id&&record.status==='canceled'?data.appointments.filter(a=>a.series_id===previous.series_id&&a.status==='scheduled'&&a.starts_at>=previous.starts_at):[previous];
    for(const row of targets){if(row.status!==record.status)localEvent(data,record.status,row,row,record.change_reason);row.status=record.status;}
    if(scope==='all'&&previous.series_id&&record.status==='canceled'){const series=data.series.find(s=>s.id===previous.series_id);series.stopped_at=previous.starts_at;}
  } else {
    const targets=scope==='all'&&previous?.series_id?data.appointments.filter(a=>a.series_id===previous.series_id&&(a.status||'scheduled')==='scheduled'):[previous];
    const delta=previous?new Date(record.starts_at)-new Date(previous.starts_at):0;
    if(scope==='all'&&previous?.series_id){const series=data.series.find(s=>s.id===previous.series_id);if(series){series.rescheduled=series.rescheduled||delta!==0;series.starts_at=new Date(new Date(series.starts_at).getTime()+delta).toISOString();for(const field of ['student','teacher_id','duration','notes','change_reason'])series[field]=record[field];if(series.stopped_at)series.stopped_at=new Date(new Date(series.stopped_at).getTime()+delta).toISOString();}}
    if(previous){for(const row of targets){const before={...row};const starts_at=scope==='all'?new Date(new Date(row.starts_at).getTime()+delta).toISOString():record.starts_at;Object.assign(row,record,{starts_at,rescheduled:row.rescheduled||new Date(before.starts_at).getTime()!==new Date(starts_at).getTime()});if(before.starts_at!==row.starts_at)localEvent(data,'rescheduled',row,before,record.change_reason);if(before.teacher_id!==row.teacher_id)localEvent(data,'teacher_changed',row,before,record.change_reason);}}
    else {const id=crypto.randomUUID(),seriesId=record.repeat==='weekly'?crypto.randomUUID():null;const row={...record,id,series_id:seriesId,occurrence_date:seriesId?studioDay(record.starts_at):null,status:'scheduled'};data.appointments.push(row);if(seriesId)data.series.push({...record,id:seriesId,anchor_date:studioDay(record.starts_at)});const expected=teacherForDate(data.teachers,data.schedule,studioDay(record.starts_at));if(expected&&expected.id!==row.teacher_id)localEvent(data,'teacher_changed',row,{teacher_id:expected.id},record.change_reason);}
    const keys=new Set();for(const row of data.appointments.filter(a=>a.status!=='canceled')){const key=row.student.trim().toLowerCase()+'|'+new Date(row.starts_at).toISOString();if(keys.has(key))throw Error('Este aluno já está agendado nesse horário. Nenhuma alteração foi salva.');keys.add(key);}
    for(const series of data.series){if(data.series.some(other=>other.id!==series.id&&other.student.trim().toLowerCase()===series.student.trim().toLowerCase()&&((new Date(other.starts_at)-new Date(series.starts_at))%weekMs===0)&&(!other.stopped_at||other.stopped_at>series.starts_at)&&(!series.stopped_at||series.stopped_at>other.starts_at)))throw Error('Este aluno já possui uma sequência nesse dia e horário.');}
  }
  localStorage.setItem(demoKey,JSON.stringify(data));
}
export function reportFromData(data,from,to,teacher='') {
  const rows=occurrences(data,from,to).filter(a=>!teacher||a.teacher_id===teacher);
  const attended=rows.filter(a=>a.status==='attended').length,canceled=rows.filter(a=>a.status==='canceled').length;
  const rescheduled=rows.filter(a=>a.rescheduled||data.events.some(e=>e.appointment_id===a.id&&e.kind==='rescheduled')).length;
  return {summary:{attended,canceled,rescheduled},teachers:data.teachers.filter(t=>!teacher||t.id===teacher).map(t=>({...t,attended:rows.filter(a=>a.teacher_id===t.id&&a.status==='attended').length})),recent:data.events.filter(e=>e.reason&&studioDay(e.event_at)>=from&&studioDay(e.event_at)<=to&&(!teacher||e.teacher_id===teacher)).sort((a,b)=>b.event_at.localeCompare(a.event_at)).slice(0,30)};
}
export async function getReport(from,to,teacher='') {
  if(!connected)return reportFromData(local(),from,to,teacher);
  return request('/rest/v1/rpc/staff_report',{method:'POST',body:JSON.stringify({from_date:from,to_date:to,teacher_id_filter:teacher||null})});
}
