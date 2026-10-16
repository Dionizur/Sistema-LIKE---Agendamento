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
function local() {return JSON.parse(localStorage.getItem(demoKey)||'{"teachers":[],"appointments":[]}');}
async function readAll(table,order) {
  const rows=[];let offset=0;
  for(;;) {const batch=await request(`/rest/v1/${table}?select=*&order=${order}&limit=500&offset=${offset}`);rows.push(...batch);if(batch.length<500)return rows;offset+=500;}
}
export async function load() {if(!connected) return local();await checkStaff();const [teachers,appointments]=await Promise.all([readAll('teachers','name,id'),readAll('appointments','starts_at,id')]);return {teachers,appointments};}
export async function save(table,record,id) {
  if(connected) return request(`/rest/v1/${table}${id?'?id=eq.'+encodeURIComponent(id):''}`,{method:id?'PATCH':'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(record)});
  const data=local();if(id) data[table]=data[table].map(row=>row.id===id?{...row,...record}:row);else data[table].push({...record,id:crypto.randomUUID()});localStorage.setItem(demoKey,JSON.stringify(data));
}
export async function remove(table,id) {if(connected) return request(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`,{method:'DELETE'});const data=local();data[table]=data[table].filter(row=>row.id!==id);localStorage.setItem(demoKey,JSON.stringify(data));}
