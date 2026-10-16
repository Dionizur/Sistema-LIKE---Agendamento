import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve(process.argv.includes('--dist') ? 'dist' : '.');
createServer(async (req,res) => { try { const url = new URL(req.url,'http://localhost'); let name = decodeURIComponent(url.pathname); if (['/','/dashboard.html','/Public/login.html'].includes(name)) name='/index.html'; const file=resolve(root,'.'+name); if(!file.startsWith(root+sep)) throw Error(); const body=await readFile(file); res.writeHead(200,{'Content-Type': ({'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript'})[extname(file)]||'application/octet-stream'}); res.end(body); } catch {res.writeHead(404);res.end('Não encontrado');} }).listen(3000,'127.0.0.1',()=>console.log('Local: http://localhost:3000'));
