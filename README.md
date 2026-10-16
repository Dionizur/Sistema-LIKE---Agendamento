# LIKE Pilates — agenda interna

Aplicação estática para Netlify, com Supabase Auth e PostgreSQL. Agenda diária/semanal, busca de aluno, filtro de professor, cadastro/edição/inativação de professores, agendamento e edição/exclusão de aulas. O aluno é informado pelo nome, sem cadastro. Uma aula representa um aluno; alunos podem compartilhar o mesmo professor e horário (aulas em grupo). Observações pertencem ao agendamento.

## Usar localmente

Node.js 20 ou superior. Execute `npm start` e abra http://localhost:3000. O comando gera o script do navegador antes de servir. Também é possível abrir `index.html` diretamente depois de `npm run build`.

O projeto atual contém a URL e a chave pública do Supabase e exige login. O modo demonstração existe apenas quando os dois campos de `config.js` estão vazios. Não use dados reais nesse modo.

## Configurar Supabase

1. Crie um projeto Supabase e execute `supabase/schema.sql` no SQL Editor uma única vez.
2. Em Authentication > Providers, mantenha e-mail/senha habilitado e desative novos cadastros públicos.
3. Crie cada funcionário em Authentication > Users (Add user > Create new user), com e-mail confirmado e senha. O cadastro de professor na interface é independente do acesso de funcionário.
4. Autorize cada funcionário pelo SQL Editor, substituindo o UUID abaixo pelo ID em Authentication > Users:

   ```sql
   insert into public.staff(user_id) values ('UUID-DO-FUNCIONARIO');
   ```

   Para revogar acesso: `delete from public.staff where user_id = 'UUID-DO-FUNCIONARIO';`. As permissões são verificadas no banco em cada operação, mesmo que uma sessão ainda esteja aberta. Não há senha padrão nem formulário público de cadastro.

5. Para desenvolvimento, preencha `config.js` com a URL do projeto e a chave pública anon/publishable. Nunca use uma chave secret ou service_role no navegador.

## Publicar no Netlify

Importe este repositório no Netlify. O arquivo `netlify.toml` já define Node.js 22, verificação de sintaxe, testes, build e a pasta `dist`.

O build usa a configuração pública de `config.js`. Para substituí-la no Netlify, defina `SUPABASE_URL` e `SUPABASE_ANON_KEY` (chave pública publishable). O build gera `dist/config.js`. Execute um novo deploy após qualquer alteração. Configure a URL de produção como Site URL no Supabase Auth.

O Supabase e as tabelas já foram criados, com a primeira funcionária autorizada. O cadastro público está desabilitado. O deploy no Netlify ainda não foi executado. Esta pasta ainda não tem repositório Git ou remoto configurados.

Para deploy manual, envie o conteúdo de `dist` ao Netlify. Para deploy por Git, envie o código ao repositório escolhido e importe-o no Netlify. A chave publishable é destinada ao navegador; a proteção dos dados é feita por autenticação e RLS. Nunca adicione senhas, tokens pessoais, chaves secret/service_role ou arquivos `.env` ao Git. Capturas de tela e scripts locais com dados pessoais estão excluídos pelo `.gitignore`.

## Acesso e dados

Todas as tabelas têm Row Level Security. Somente usuários autenticados que constam em `staff` podem ler e alterar professores, alunos e observações. Não conceda acesso público às tabelas. A sessão fica em sessionStorage e é renovada durante o uso. Os dados são recarregados após alterações e pelo botão Atualizar; não há sincronização em tempo real entre telas.

O SQL impede duplicar o mesmo aluno no mesmo instante. Sobreposição de alunos é permitida para aulas em grupo; a capacidade do estúdio não foi definida. Horários de funcionamento da agenda: 06h às 23h, horário de Brasília.

Os arquivos antigos `Server.js`, `dashboard.html` e `Public/login.html` são legados, não são copiados para `dist` e não participam da aplicação. Não existe migração automática de dados do Firebase/MongoDB.

## Verificação

`npm run check` verifica a sintaxe dos módulos. `npm run build` gera a versão estática. Para verificar o build, execute `node scripts/serve.mjs --dist`. A revisão já verificou o login real da primeira funcionária, a agenda no navegador e as operações no banco em teste transacional com rollback. `node scripts/check-public-access.mjs` verifica o bloqueio de leitura anônima e as opções públicas de autenticação. Veja `VERIFICACAO.md` para o escopo dos testes.
