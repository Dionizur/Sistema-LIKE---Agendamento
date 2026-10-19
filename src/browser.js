(() => {
'use strict';
const config = window.LIKE_CONFIG || {};
const connected = Boolean(config.supabaseUrl && config.supabaseKey);
let session;
try { session = JSON.parse(sessionStorage.getItem('like-session') || 'null'); } catch { sessionStorage.removeItem('like-session'); }
let renewing;
const user = () => session?.user;
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
async function login(email,password) {
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
async function logout() {try {if(connected&&session) await request('/auth/v1/logout',{method:'POST'});} finally {clearSession();}}
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
async function load(from=studioDay(new Date()),to=from) {
  if(!connected) {const data=local();return {...data,appointments:occurrences(data,from,to)};}
  await checkStaff();
  const [teachers,schedule,appointments]=await Promise.all([readAll('teachers','name,id'),readAll('teacher_schedule','weekday'),request('/rest/v1/rpc/agenda_range',{method:'POST',body:JSON.stringify({from_date:from,to_date:to})})]);
  return {teachers,schedule,appointments:appointments||[]};
}
async function save(table,record,id) {
  if(connected) return request(`/rest/v1/${table}${id?'?id=eq.'+encodeURIComponent(id):''}`,{method:id?'PATCH':'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(record)});
  const data=local();if(id) data[table]=data[table].map(row=>row.id===id?{...row,...record}:row);else data[table].push({...record,id:crypto.randomUUID()});localStorage.setItem(demoKey,JSON.stringify(data));
}
async function remove(table,id) {if(connected) return request(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`,{method:'DELETE'});const data=local();data[table]=data[table].filter(row=>row.id!==id);localStorage.setItem(demoKey,JSON.stringify(data));}


const studioDay=value=>new Date(value).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
const weekMs=7*86400000;
function teacherForDate(teachers,schedule,date) {
  const day=new Date(date+'T12:00:00-03:00').getUTCDay();
  const assignment=schedule.find(row=>Number(row.weekday)===day);
  return teachers.find(t=>t.id===assignment?.teacher_id&&t.active);
}
function occurrences(data,from,to) {
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
async function saveTeacher(record,weekdays,id=null) {
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
async function updateAppointment(record,original=null,scope='one') {
  return appointmentAction('save',record,original,scope);
}
async function setAppointmentStatus(original,status,reason='',scope='one') {
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
function reportFromData(data,from,to,teacher='') {
  const rows=occurrences(data,from,to).filter(a=>!teacher||a.teacher_id===teacher);
  const attended=rows.filter(a=>a.status==='attended').length,canceled=rows.filter(a=>a.status==='canceled').length;
  const rescheduled=rows.filter(a=>a.rescheduled||data.events.some(e=>e.appointment_id===a.id&&e.kind==='rescheduled')).length;
  return {summary:{attended,canceled,rescheduled},teachers:data.teachers.filter(t=>!teacher||t.id===teacher).map(t=>({...t,attended:rows.filter(a=>a.teacher_id===t.id&&a.status==='attended').length})),recent:data.events.filter(e=>e.reason&&studioDay(e.event_at)>=from&&studioDay(e.event_at)<=to&&(!teacher||e.teacher_id===teacher)).sort((a,b)=>b.event_at.localeCompare(a.event_at)).slice(0,30)};
}
async function getReport(from,to,teacher='') {
  if(!connected)return reportFromData(local(),from,to,teacher);
  return request('/rest/v1/rpc/staff_report',{method:'POST',body:JSON.stringify({from_date:from,to_date:to,teacher_id_filter:teacher||null})});
}

const $=s=>document.querySelector(s), app=$('#app'), modal=$('#modal');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const studioDate=d=>new Date(new Date(d).toLocaleString('en-US',{timeZone:'America/Sao_Paulo'}));
const dateKey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const time=d=>new Date(d).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',timeZone:'America/Sao_Paulo'});
const format=(d,options)=>d.toLocaleDateString('pt-BR',options);
const weekdays=['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
const statuses={scheduled:'Agendada',attended:'Atendida',canceled:'Desmarcada'};
let refreshVersion=0,reportVersion=0;
let report=null,reportLoading=false,reportError='',reportFrom='',reportTo='',reportTeacher='';
let data={teachers:[],appointments:[],schedule:[]}, selected=dateKey(studioDate(new Date())), view='week', page='agenda', filter='', query='';
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');setTimeout(()=>$('#toast').classList.remove('show'),4500);}
function dialog(html){modal.innerHTML=html;modal.showModal();modal.querySelector('[data-close]')?.addEventListener('click',()=>modal.close());}
modal.addEventListener('click',e=>{if(e.target===modal)modal.close();});
async function refresh(){const version=++refreshVersion;try {const range=days();const loaded=await load(dateKey(range[0]),dateKey(range[range.length-1]));if(version!==refreshVersion)return;data=loaded;if(page==='staff')await loadReport();else render();}catch(e){if(connected&&!user()){data={teachers:[],appointments:[],schedule:[]};loginPage();}toast(e.message);}}
function loginPage(){app.innerHTML=`<main class="login"><div class="login-art"><div class="brand-wordmark" aria-label="LIKE Studio Pilates"><span class="brand-name">LIKE</span><span class="brand-subtitle">Studio Pilates</span></div><div><p class="eyebrow">LIKE STUDIO PILATES</p><h1>Seu corpo é<br><i>seu maior bem!</i></h1></div><p>O espaço da equipe LIKE Pilates.</p></div><section class="login-form"><p class="eyebrow">ÁREA INTERNA</p><h2>Bem-vindo de volta.</h2><p>Acesse a agenda e prepare o próximo encontro.</p><form id="login"><label>E-mail<input type="email" name="email" autocomplete="username" required></label><label>Senha<input type="password" name="password" autocomplete="current-password" required></label><p id="login-error" role="alert"></p><button class="primary">Entrar na agenda →</button></form><small>Acesso exclusivo para funcionários autorizados.</small></section></main>`;$('#login').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{await login(e.target.email.value,e.target.password.value);await refresh();}catch(err){$('#login-error').textContent=err.message.includes('Funcionário não autorizado')?err.message:'Não foi possível entrar. Verifique o e-mail, a senha e sua conexão.';}finally{b.disabled=false;}};}
function days(){const start=new Date(selected+'T12:00:00');if(view==='week')start.setDate(start.getDate()-((start.getDay()+6)%7));return Array.from({length:view==='week'?7:1},(_,i)=>{const d=new Date(start);d.setDate(d.getDate()+i);return d;});}
function filtered(){return data.appointments.filter(a=>(!filter||a.teacher_id===filter)&&a.student.toLocaleLowerCase().includes(query.toLocaleLowerCase()));}
function render(){if(connected&&!user())return loginPage();const title=page==='staff'?'Painel da equipe':page==='agenda'?'Agenda do estúdio':'Nossos professores';const ds=days(), today=dateKey(studioDate(new Date())), dayRows=data.appointments.filter(a=>dateKey(studioDate(a.starts_at))===selected);app.innerHTML=`<aside class="sidebar"><div class="brand-wordmark" aria-label="LIKE Studio Pilates"><span class="brand-name">LIKE</span><span class="brand-subtitle">Studio Pilates</span></div><p class="nav-label">ESTÚDIO · ÁREA INTERNA</p><nav><button data-page="agenda" class="${page==='agenda'?'active':''}"><span>▦</span> Agenda <b>→</b></button><button data-page="teachers" class="${page==='teachers'?'active':''}"><span>♧</span> Professores <b>${data.teachers.length}</b></button><button data-page="staff" class="${page==='staff'?'active':''}"><span>◷</span> Painel da equipe <b>→</b></button></nav><div class="sidebar-note"><span>✳</span><h3>Seu corpo é<br>seu maior bem!</h3><p>Uma boa aula começa<br>com cuidado nos detalhes.</p></div><div class="account"><div class="avatar">LK</div><div><strong>${esc(user()?.staff?.name||'Equipe LIKE')}</strong><small>${connected?esc(user()?.staff?.job_title||'Acesso autorizado'):'Demonstração local'}</small></div><button id="logout" aria-label="Sair">↗</button></div></aside><main class="workspace"><header><span>Estúdio <span class="muted">/</span> ${page==='staff'?'Painel da equipe':page==='agenda'?'Agenda':'Professores'}</span><span class="connection"><i></i>${connected?'Supabase conectado':'Modo demonstração'}</span></header><section class="content">${!connected?'<div class="demo-banner">Prévia local · Os dados ficam apenas neste navegador. Configure o Supabase antes de usar com alunos reais.</div>':''}<div class="page-heading"><div><p class="eyebrow">${page==='staff'?'ACOMPANHAMENTO DO ESTÚDIO':page==='agenda'?'CADA MOVIMENTO, UM NOVO ENCONTRO':'QUEM FAZ O ESTÚDIO ACONTECER'}</p><h1>${title}<span>.</span></h1><p>${page==='staff'?'Acompanhe os atendimentos e as mudanças na agenda.':page==='agenda'?'Organize as aulas. Cuide de cada aluno.':'Defina os dias fixos de cada profissional.'}</p></div><button id="create" class="primary">${page==='staff'?'↻ Atualizar painel':'＋ '+(page==='agenda'?'Agendar aula':'Cadastrar professor')}</button></div>${page==='agenda'?`<div class="stats"><div><span>Aulas no dia selecionado</span><strong>${dayRows.filter(a=>a.status!=='canceled').length.toString().padStart(2,'0')}<small>agendamentos</small></strong></div><div><span>Alunos no dia</span><strong>${new Set(dayRows.filter(a=>a.status!=='canceled').map(a=>a.student.toLowerCase())).size.toString().padStart(2,'0')}<small>para receber</small></strong></div><div><span>Professores cadastrados</span><strong>${data.teachers.filter(t=>t.active).length.toString().padStart(2,'0')}<small>ativos no estúdio</small></strong></div><div class="quote"><span>✳</span><p>Seu corpo é<br><em>seu maior bem!</em></p></div></div><section class="agenda"><div class="toolbar"><div class="date-navigation"><button id="prev" aria-label="Período anterior">‹</button><button id="next" aria-label="Próximo período">›</button><h2>${format(ds[0],{month:'long',year:'numeric'})}</h2><button id="today">Hoje</button><input id="date" type="date" aria-label="Ir para data" value="${selected}"></div><div class="segmented"><button data-view="day" class="${view==='day'?'active':''}">Dia</button><button data-view="week" class="${view==='week'?'active':''}">Semana</button></div></div><div class="filters"><span>⌕ <input id="search" type="search" placeholder="Buscar aluno…" value="${esc(query)}" aria-label="Buscar aluno"></span><select id="teacher-filter" aria-label="Filtrar por professor"><option value="">Todos os professores</option>${data.teachers.map(t=>`<option value="${t.id}" ${filter===t.id?'selected':''}>${esc(t.name)}</option>`).join('')}</select><button id="refresh">↻ Atualizar</button></div><div class="calendar-scroll"><div class="calendar ${view}"><div class="calendar-heading"><div class="time-label">HORÁRIO</div>${ds.map(d=>`<div class="day-heading ${dateKey(d)===today?'today':''}"><span>${format(d,{weekday:'short'}).replace('.','')}</span><strong>${d.getDate()}</strong><small class="day-teacher">${esc(teacherForDate(data.teachers,data.schedule,dateKey(d))?.name||'Sem professor fixo')}</small></div>`).join('')}</div><div class="calendar-body"><div class="hours">${Array.from({length:17},(_,i)=>`<div>${String(i+6).padStart(2,'0')}:00</div>`).join('')}</div>${ds.map(d=>`<div class="day-column" data-date="${dateKey(d)}">${Array.from({length:17},(_,i)=>`<button class="slot" data-day="${dateKey(d)}" data-hour="${i+6}" aria-label="Agendar ${dateKey(d)} às ${i+6} horas"></button>`).join('')}${cards(d)}</div>`).join('')}</div></div></div><footer class="agenda-footer"><span><i></i> Clique em uma aula para ver os detalhes</span><span>Horário de Brasília</span></footer></section>`:page==='staff'?staffPage():teacherPage()}<footer class="page-footer">LIKE PILATES <span>Seu corpo é seu maior bem!</span></footer></section></main>`;
$('#logout').onclick=async()=>{try{await logout();}catch{toast('Sessão local encerrada.');}finally{data={teachers:[],appointments:[],schedule:[]};if(connected)loginPage();else toast('Você está na demonstração local.');}};$('#create').onclick=()=>page==='staff'?refresh():page==='agenda'?appointmentForm():teacherForm();document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>{page=b.dataset.page;if(page==='staff')loadReport();else render();});if(page==='agenda')bindAgenda();else if(page==='staff')bindReport();else document.querySelectorAll('[data-teacher]').forEach(b=>b.onclick=()=>teacherForm(data.teachers.find(t=>t.id===b.dataset.teacher)));}
function cards(d){
  const rows=filtered().filter(a=>dateKey(studioDate(a.starts_at))===dateKey(d)).sort((a,b)=>new Date(a.starts_at)-new Date(b.starts_at));
  const groups=[];let group=[],groupEnd=0;
  for(const a of rows){const begin=new Date(a.starts_at).getTime();if(group.length&&begin>=groupEnd){groups.push(group);group=[];groupEnd=0;}group.push(a);groupEnd=Math.max(groupEnd,begin+a.duration*60000);}if(group.length)groups.push(group);
  const positions=new Map();
  for(const members of groups){const ends=[];for(const a of members){const begin=new Date(a.starts_at).getTime();let lane=ends.findIndex(end=>end<=begin);if(lane<0)lane=ends.length;ends[lane]=begin+a.duration*60000;positions.set(a.id,{lane});}for(const a of members)positions.get(a.id).count=ends.length;}
  return rows.map(a=>{const start=studioDate(a.starts_at),teacher=data.teachers.find(t=>t.id===a.teacher_id),position=positions.get(a.id);
  return '<button class="class-card status-'+(a.status||'scheduled')+' tone-'+Math.max(0,data.teachers.findIndex(t=>t.id===a.teacher_id))%4+'" data-appointment="'+a.id+'" style="top:'+((start.getHours()-6)*88+start.getMinutes()/60*88)+'px;height:'+Math.max(34,a.duration/60*88-4)+'px;left:calc('+position.lane/position.count*100+'% + 5px);width:calc('+100/position.count+'% - 10px)"><span>'+time(a.starts_at)+' · '+a.duration+' min</span><strong>'+esc(a.student)+'</strong><small>'+esc(teacher?.name||'Professor')+(a.series_id?' · ↻':'')+(a.status==='attended'?' · ✓':a.status==='canceled'?' · Desmarcada':'')+(a.notes?' · ≡':'')+'</small></button>';
  }).join('');
}
function bindAgenda(){for(const [id,step] of [['prev',-1],['next',1]])$('#'+id).onclick=()=>{const d=new Date(selected+'T12:00:00');d.setDate(d.getDate()+step*(view==='week'?7:1));selected=dateKey(d);refresh();};$('#today').onclick=()=>{selected=dateKey(studioDate(new Date()));refresh();};$('#date').onchange=e=>{if(e.target.value){selected=e.target.value;refresh();}};document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{view=b.dataset.view;refresh();});$('#teacher-filter').onchange=e=>{filter=e.target.value;render();};$('#search').oninput=e=>{query=e.target.value;const pos=e.target.selectionStart;render();$('#search').focus();try{$('#search').setSelectionRange(pos,pos);}catch{}};$('#refresh').onclick=refresh;document.querySelectorAll('[data-appointment]').forEach(b=>b.onclick=()=>appointmentForm(data.appointments.find(a=>a.id===b.dataset.appointment)));document.querySelectorAll('[data-day]').forEach(b=>b.onclick=()=>appointmentForm(null,b.dataset.day,String(b.dataset.hour).padStart(2,'0')+':00'));}
function teacherPage(){return `<div class="teacher-grid">${data.teachers.length?data.teachers.map((t,i)=>`<button class="teacher-card" data-teacher="${t.id}"><span class="teacher-avatar tone-${i%4}">${esc(t.name.split(' ').map(n=>n[0]).slice(0,2).join(''))}</span><span><strong>${esc(t.name)}</strong><small>${esc(t.specialty||'Pilates')} · ${t.active?'Ativo':'Inativo'}</small><small>${data.schedule.filter(row=>row.teacher_id===t.id).map(row=>weekdays[row.weekday].replace('-feira','')).join(' · ')||'Sem dias fixos'}</small></span><span>↗</span></button>`).join(''):'<div class="empty"><span>♧</span><h2>Vamos conhecer a equipe?</h2><p>Cadastre o primeiro professor para começar a agendar aulas.</p></div>'}</div>`;}
function appointmentForm(a=null,date=selected,hour='08:00') {
  const active=data.teachers.filter(t=>t.active||t.id===a?.teacher_id);
  if(!active.length){toast('Cadastre um professor antes de agendar a primeira aula.');page='teachers';render();teacherForm();return;}
  const dt=a?studioDate(a.starts_at):null, lessonDate=dt?dateKey(dt):date;
  const suggested=teacherForDate(data.teachers,data.schedule,lessonDate);
  const teacherId=a?.teacher_id||suggested?.id||'';
  const readonly=a&&a.status&&a.status!=='scheduled';
  dialog(`<form id="appointment-form"><div class="modal-heading"><div><p class="eyebrow">AGENDA LIKE</p><h2>${a?'Detalhes da aula':'Um novo encontro'}</h2></div><button type="button" data-close aria-label="Fechar">✕</button></div>
    ${a?`<p class="lesson-state state-${a.status||'scheduled'}">${statuses[a.status||'scheduled']}</p>`:''}
    <fieldset class="lesson-fields" ${readonly?'disabled':''}>
    <label>Nome do aluno<input name="student" maxlength="120" required placeholder="Como o aluno se chama?" value="${esc(a?.student||'')}"></label>
    <div class="form-row"><label>Data<input type="date" name="date" required value="${lessonDate}"></label><label>Início<input type="time" name="time" min="06:00" max="22:30" required value="${dt?String(dt.getHours()).padStart(2,'0')+':'+String(dt.getMinutes()).padStart(2,'0'):hour}"></label><label>Duração<select name="duration">${[30,45,50,60,90,120].map(n=>`<option value="${n}" ${(a?.duration||60)===n?'selected':''}>${n} min</option>`).join('')}</select></label></div>
    <label>Professor<select name="teacher_id" required><option value="">Escolha um professor</option>${active.map(t=>`<option value="${t.id}" ${teacherId===t.id?'selected':''}>${esc(t.name)}</option>`).join('')}</select></label><p id="teacher-suggestion" class="field-hint"></p>
    ${!a?`<fieldset class="recurrence"><legend>Programar aluno</legend><label>Repetição<select name="repeat"><option value="none">Aula avulsa</option><option value="weekly">Toda semana, sem data de término</option></select></label><small>O aluno mantém este dia e horário toda semana até a equipe encerrar a sequência.</small></fieldset>`:a.series_id?'<p class="series-info">↻ Aula de uma programação semanal. Ao salvar, escolha se deseja alterar somente esta aula ou todas as aulas ainda agendadas. Atendimentos e desmarcações anteriores são preservados.</p>':''}
    <label>Observações do aluno <span class="muted">· opcional</span><textarea name="notes" maxlength="3000" rows="3" placeholder="Cuidados e adaptações para a aula…">${esc(a?.notes||'')}</textarea></label>
    <label>Justificativa da alteração ou troca de professor <span class="muted">· opcional</span><textarea name="change_reason" maxlength="1000" rows="2" placeholder="Ex.: substituição de professor nesta data"></textarea></label>
    </fieldset><p class="form-error" role="alert"></p>
    ${a?`<div class="lesson-controls">${a.status!=='attended'&&a.status!=='canceled'?'<button type="button" id="attend">✓ Marcar como atendida</button><button type="button" class="danger" id="cancel-lesson">Desmarcar aula</button>':'<button type="button" id="reopen">Reabrir aula</button>'}</div>`:''}
    <div class="modal-actions"><button type="button" id="cancel">Fechar</button>${!readonly?`<button class="primary" type="submit">${a?'Salvar alterações':'Confirmar agendamento'} →</button>`:'<small>Reabra a aula para editar seus dados.</small>'}</div></form>`);
  const form=$('#appointment-form');
  const showSuggestion=()=>{const expected=teacherForDate(data.teachers,data.schedule,form.elements.date.value);$('#teacher-suggestion').textContent=expected?(form.elements.teacher_id.value===expected.id?`${expected.name} é o professor fixo deste dia.`:`Professor fixo: ${expected.name}. Você pode manter a substituição e informar o motivo abaixo.`):'Este dia ainda não tem professor fixo. Selecione quem atenderá a aula.';};
  form.elements.date.onchange=()=>{const expected=teacherForDate(data.teachers,data.schedule,form.elements.date.value);form.elements.teacher_id.value=expected?.id||'';showSuggestion();};
  form.elements.teacher_id.onchange=showSuggestion;showSuggestion();
  $('#cancel').onclick=()=>modal.close();
  $('#attend')?.addEventListener('click',()=>statusDialog(a,'attended',form.elements.change_reason.value));
  $('#cancel-lesson')?.addEventListener('click',()=>statusDialog(a,'canceled',form.elements.change_reason.value));
  $('#reopen')?.addEventListener('click',()=>statusDialog(a,'scheduled'));
  form.onsubmit=async e=>{
    e.preventDefault();if(readonly)return;
    const f=new FormData(form),duration=Number(f.get('duration')),clock=f.get('time');
    if(Number(clock.slice(0,2))*60+Number(clock.slice(3))+duration>23*60){$('.form-error').textContent='A aula deve terminar até 23h.';return;}
    const record={student:f.get('student').trim(),teacher_id:f.get('teacher_id'),starts_at:new Date(f.get('date')+'T'+clock+':00-03:00').toISOString(),duration,notes:f.get('notes').trim(),change_reason:f.get('change_reason').trim(),repeat:f.get('repeat')||'none'};
    if(!record.student){$('.form-error').textContent='Informe o nome do aluno.';return;}
    if(a?.series_id){chooseSequence(a,record);return;}
    await mutate(e.submitter,()=>updateAppointment(record,a),record.repeat==='weekly'?'Aluno programado toda semana, sem data final.':'Aula salva na agenda.');
  };
}
function chooseSequence(a,record) {
  dialog(`<div class="modal-heading"><h2>Alterar quais aulas?</h2><button data-close aria-label="Fechar">✕</button></div><p>As alterações de <strong>${esc(record.student)}</strong> podem valer para esta aula ou para todas as aulas ainda agendadas da programação semanal, inclusive as próximas semanas.</p><p>Ao mudar a data, as aulas agendadas se deslocam pelo mesmo intervalo. Aulas atendidas e desmarcadas mantêm seu histórico.</p><p class="form-error" role="alert"></p><div class="modal-actions"><button id="only-one">Só esta aula</button><button class="primary" id="whole-series">Todas as agendadas</button></div>`);
  $('#only-one').onclick=e=>mutate(e.target,()=>updateAppointment(record,a),'Aula alterada.');
  $('#whole-series').onclick=e=>mutate(e.target,()=>updateAppointment(record,a,'all'),'Programação semanal atualizada.');
}
function statusDialog(a,status,reason='') {
  const title=status==='attended'?'Confirmar atendimento?':status==='canceled'?'Desmarcar aula?':'Reabrir aula?';
  dialog(`<form id="status-form"><div class="modal-heading"><h2>${title}</h2><button type="button" data-close aria-label="Fechar">✕</button></div><p><strong>${esc(a.student)}</strong> · ${format(studioDate(a.starts_at),{day:'2-digit',month:'2-digit',year:'numeric'})} às ${time(a.starts_at)}.</p>${status==='canceled'&&a.series_id?'<label>Alcance<select name="scope"><option value="one">Só esta aula</option><option value="all">Esta aula e encerrar as próximas da sequência</option></select></label><p class="field-hint">Desmarcar somente esta aula mantém a programação semanal. Encerrar interrompe as próximas ocorrências.</p>':''}<label>Justificativa <span class="muted">· opcional</span><textarea name="reason" maxlength="1000" rows="3">${esc(reason)}</textarea></label><p class="form-error" role="alert"></p><div class="modal-actions"><button type="button" id="back">Voltar</button><button class="${status==='canceled'?'danger':'primary'}">Confirmar</button></div></form>`);
  $('#back').onclick=()=>appointmentForm(a);
  $('#status-form').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);mutate(e.submitter,()=>setAppointmentStatus(a,status,f.get('reason').trim(),f.get('scope')||'one'),status==='attended'?'Atendimento registrado no painel.':status==='canceled'?'Desmarcação registrada.':'Aula reaberta.');};
}
async function mutate(button,operation,message) {
  const form=button.closest('form')||modal,buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
  try{await operation();modal.close();await refresh();toast(message);}catch(e){if($('.form-error'))$('.form-error').textContent=e.message;else toast(e.message);}finally{buttons.forEach(b=>b.disabled=false);}
}
function teacherForm(t=null) {
  const ownDays=data.schedule.filter(row=>row.teacher_id===t?.id).map(row=>row.weekday);
  dialog(`<form id="teacher-form"><div class="modal-heading"><div><p class="eyebrow">EQUIPE LIKE</p><h2>${t?'Editar professor':'Novo professor'}</h2></div><button type="button" data-close aria-label="Fechar">✕</button></div><label>Nome completo<input name="name" maxlength="120" required value="${esc(t?.name||'')}" placeholder="Nome do profissional"></label><label>Especialidade<input name="specialty" maxlength="120" value="${esc(t?.specialty||'')}" placeholder="Ex.: Pilates clínico"></label>
    <fieldset class="weekday-picker"><legend>Dias fixos de atendimento</legend><p class="field-hint">O professor será pré-selecionado nas aulas desses dias. A equipe poderá substituí-lo quando necessário.</p>${weekdays.map((day,index)=>{const assigned=data.schedule.find(row=>row.weekday===index&&row.teacher_id!==t?.id);const other=data.teachers.find(teacher=>teacher.id===assigned?.teacher_id);return `<label><input type="checkbox" name="weekdays" value="${index}" ${ownDays.includes(index)?'checked':''} ${assigned?'disabled':''}><span>${day}${other?`<small>Já reservado para ${esc(other.name)}</small>`:''}</span></label>`;}).join('')}</fieldset>
    <label>Status<select name="active"><option value="true">Ativo</option><option value="false" ${t&&!t.active?'selected':''}>Inativo</option></select></label><small>Mudar os dias fixos não altera aulas já programadas. Professores inativos mantêm o histórico.</small><p class="form-error" role="alert"></p><div class="modal-actions"><button type="button" id="cancel">Cancelar</button><button class="primary">Salvar professor →</button></div></form>`);
  $('#cancel').onclick=()=>modal.close();
  $('#teacher-form').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);if(!f.get('name').trim())return;mutate(e.submitter,()=>saveTeacher({name:f.get('name').trim(),specialty:f.get('specialty').trim(),active:f.get('active')==='true'},f.getAll('weekdays').map(Number),t?.id),'Professor e dias fixos salvos.');};
}
async function loadReport() {
  if(!reportFrom){const today=studioDate(new Date());reportFrom=dateKey(new Date(today.getFullYear(),today.getMonth(),1,12));reportTo=dateKey(new Date(today.getFullYear(),today.getMonth()+1,0,12));}
  const version=++reportVersion;reportLoading=true;report=null;reportError='';render();
  try{const result=await getReport(reportFrom,reportTo,reportTeacher);if(version===reportVersion)report=result;}catch(error){if(version===reportVersion)reportError=error.message;}finally{if(version===reportVersion){reportLoading=false;if(page==='staff')render();}}
}
function staffPage() {
  const summary=report?.summary||{attended:0,canceled:0,rescheduled:0};
  return `<section class="staff-panel"><form id="report-filters" class="report-filters"><label>De<input name="from" type="date" value="${reportFrom}" required></label><label>Até<input name="to" type="date" value="${reportTo}" required></label><label>Professor<select name="teacher"><option value="">Todos os professores</option>${data.teachers.map(t=>`<option value="${t.id}" ${reportTeacher===t.id?'selected':''}>${esc(t.name)}</option>`).join('')}</select></label><button class="primary" ${reportLoading?'disabled':''}>${reportLoading?'Carregando…':'Aplicar período'}</button></form>
    ${reportError?`<p class="form-error" role="alert">${esc(reportError)}</p>`:''}
    <div class="stats report-stats" aria-live="polite">${[['attended','Aulas atendidas'],['canceled','Aulas desmarcadas'],['rescheduled','Aulas reagendadas']].map(([key,label])=>`<div><span>${label}</span><strong>${reportLoading?'…':summary[key]}</strong></div>`).join('')}</div><p class="field-hint">Contagem pela data da aula no período selecionado. Reagendadas são aulas cuja data ou horário mudou e podem também estar atendidas ou desmarcadas. Atendimentos são confirmados pela equipe, sem conclusão automática.</p>
    <section class="report-section"><h2>Atendimentos por professor</h2><div class="table-scroll"><table class="report-table"><thead><tr><th>Professor</th><th>Dias fixos</th><th>Aulas atendidas</th></tr></thead><tbody>${(report?.teachers||[]).map(t=>`<tr><td>${esc(t.name)}${!t.active?' <small>Inativo</small>':''}</td><td>${data.schedule.filter(row=>row.teacher_id===t.id).map(row=>weekdays[row.weekday].replace('-feira','')).join(' · ')||'Não definidos'}</td><td><strong>${t.attended}</strong></td></tr>`).join('')||'<tr><td colspan="3">Nenhum professor neste período.</td></tr>'}</tbody></table></div></section>
    <section class="report-section"><h2>Justificativas recentes</h2><p class="field-hint">Até 30 registros feitos no período selecionado. O histórico registra quem fez a alteração.</p><div class="recent-list">${(report?.recent||[]).map(event=>{const teacher=data.teachers.find(t=>t.id===event.teacher_id),previous=data.teachers.find(t=>t.id===event.from_teacher_id);const kind={teacher_changed:'Troca de professor',rescheduled:'Reagendamento',attended:'Atendimento',canceled:'Desmarcação',scheduled:'Agendamento'}[event.kind]||'Alteração';return `<article class="recent-item"><div><strong>${esc(event.student)}</strong><span class="event-kind">${kind}</span><small>${format(studioDate(event.event_at),{day:'2-digit',month:'2-digit',year:'numeric'})} às ${time(event.event_at)} · ${esc(event.actor_name||'Equipe LIKE')}</small></div><p>${esc(event.reason)}</p><small>${previous&&event.kind==='teacher_changed'?esc(previous.name)+' → ':''}${esc(teacher?.name||'Professor')} · Aula em ${format(studioDate(event.starts_at),{day:'2-digit',month:'2-digit',year:'numeric'})} às ${time(event.starts_at)}</small></article>`;}).join('')||'<p class="report-empty">Nenhuma justificativa registrada neste período.</p>'}</div></section></section>`;
}
function bindReport() {
  $('#report-filters').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target),from=f.get('from'),to=f.get('to');if(to<from||new Date(to)-new Date(from)>370*86400000){toast('Selecione um período de até 371 dias, com a data final após a inicial.');return;}reportFrom=from;reportTo=to;reportTeacher=f.get('teacher');loadReport();};
}
render();if(!connected||user())refresh();

})();
