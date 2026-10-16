import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const context={window:{}};
runInNewContext(await readFile('config.js','utf8'),context);
const config=context.window.LIKE_CONFIG;
for(const table of ['staff','teachers','appointments']) {
  const response=await fetch(`${config.supabaseUrl}/rest/v1/${table}?select=*&limit=1`,{headers:{apikey:config.supabaseKey}});
  const body=await response.json();
  if(![401,403].includes(response.status)||body.code!=='42501') throw Error(`Acesso público inesperado em ${table}: HTTP ${response.status}`);
  console.log(`${table}: acesso anônimo bloqueado (HTTP ${response.status})`);
}
const settingsResponse=await fetch(`${config.supabaseUrl}/auth/v1/settings`,{headers:{apikey:config.supabaseKey}});
if(!settingsResponse.ok)throw Error(`Auth indisponível: HTTP ${settingsResponse.status}`);
const settings=await settingsResponse.json();
console.log(`Auth e-mail habilitado: ${settings.external?.email===true}`);
console.log(`Cadastro público desabilitado: ${settings.disable_signup===true}`);
