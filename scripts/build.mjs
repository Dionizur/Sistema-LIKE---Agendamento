import { mkdir, copyFile, cp, writeFile, readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const configContext = { window: {} };
runInNewContext(await readFile('config.js', 'utf8'), configContext);
const defaults = configContext.window.LIKE_CONFIG || {};
// Um único script clássico também permite visualizar index.html por duplo clique.
const dataSource = (await readFile('src/data.js', 'utf8')).replace(/^export /gm, '');
const appSource = (await readFile('src/app.js', 'utf8')).replace(/^import .*from '\.\/data\.js';\r?\n/, '');
await writeFile('src/browser.js', `(() => {\n'use strict';\n${dataSource}\n${appSource}\n})();\n`);
await mkdir('dist', { recursive: true });
await copyFile('index.html', 'dist/index.html');
await cp('src', 'dist/src', { recursive: true });
await writeFile('dist/config.js', `window.LIKE_CONFIG = ${JSON.stringify({supabaseUrl: process.env.SUPABASE_URL || defaults.supabaseUrl || '', supabaseKey: process.env.SUPABASE_ANON_KEY || defaults.supabaseKey || ''})};\n`);
await writeFile('dist/_redirects', '/* /index.html 200\n');
await writeFile('dist/_headers', '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n');
console.log('Build pronto em dist/');
