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

O Supabase e as tabelas já foram criados, com a primeira funcionária autorizada. O cadastro público está desabilitado. O site de produção é https://likeagenda.netlify.app e o Netlify acompanha o repositório Dionizur/Sistema-LIKE---Agendamento.

Para deploy manual, envie o conteúdo de `dist` ao Netlify. Para deploy por Git, envie o código ao repositório escolhido e importe-o no Netlify. A chave publishable é destinada ao navegador; a proteção dos dados é feita por autenticação e RLS. Nunca adicione senhas, tokens pessoais, chaves secret/service_role ou arquivos `.env` ao Git. Capturas de tela e scripts locais com dados pessoais estão excluídos pelo `.gitignore`.

## Acesso e dados

Todas as tabelas têm Row Level Security. Somente usuários autenticados que constam em `staff` podem ler e alterar professores, alunos e observações. Não conceda acesso público às tabelas. A sessão fica em sessionStorage e é renovada durante o uso. Os dados são recarregados após alterações e pelo botão Atualizar; não há sincronização em tempo real entre telas.

O SQL impede duplicar o mesmo aluno no mesmo instante. Sobreposição de alunos é permitida para aulas em grupo; a capacidade do estúdio não foi definida. Horários de funcionamento da agenda: 06h às 23h, horário de Brasília.

Os arquivos antigos `Server.js`, `dashboard.html` e `Public/login.html` são legados, não são copiados para `dist` e não participam da aplicação. Não existe migração automática de dados do Firebase/MongoDB.

## Verificação

`npm run check` verifica a sintaxe dos módulos. `npm run build` gera a versão estática. Para verificar o build, execute `node scripts/serve.mjs --dist`. A revisão já verificou o login real da primeira funcionária, a agenda no navegador e as operações no banco em teste transacional com rollback. `node scripts/check-public-access.mjs` verifica o bloqueio de leitura anônima e as opções públicas de autenticação. Veja `VERIFICACAO.md` para o escopo dos testes.

## Dias fixos e programação semanal

No cadastro ou edição de professor, marque seus dias fixos. Cada dia possui um responsável padrão. A tela indica os dias reservados por outros professores. Nenhum dia foi atribuído aos professores existentes sem definição da equipe. Professores inativos não são sugeridos.

Ao agendar, a data seleciona o professor fixo do dia. É possível escolher outro professor e informar uma justificativa opcional. Alterar os dias fixos não modifica aulas já programadas.

Em Repetição, escolha “Toda semana, sem data de término”. A programação é guardada uma única vez; a agenda calcula as ocorrências do período aberto, inclusive em anos futuros. Uma aula só precisa de registro individual ao ser alterada, desmarcada ou atendida. As sequências antigas também continuam sem término.

Ao editar uma sequência, escolha “Só esta aula” ou “Todas as agendadas”. A alteração em conjunto atualiza a programação e as aulas ainda agendadas; atendimentos e desmarcações mantêm os dados históricos. Mudar a data desloca as aulas pelo mesmo intervalo. Uma desmarcação individual não reaparece na próxima atualização. Encerrar a sequência interrompe as próximas ocorrências.

## Painel da equipe

Todo funcionário autorizado tem acesso ao Painel da equipe. O período padrão é o mês atual; há filtros de datas e professor. O painel apresenta aulas atendidas, desmarcadas e reagendadas, os atendimentos por professor e as últimas 30 justificativas registradas no período, com autor, horário e detalhes da troca.

A equipe registra “Marcar como atendida” nos detalhes da aula após seu início. Aulas passadas não são automaticamente consideradas atendidas. Desmarcações preservam o histórico e podem ser reabertas. Aulas reagendadas contam uma vez pela data atual da aula no período, mesmo quando também atendidas ou desmarcadas. Justificativas usam a data em que a alteração foi registrada. Os novos indicadores acompanham as ações registradas a partir desta versão; dados antigos não permitem inferir atendimentos ou cancelamentos anteriores.

## Migrações e validação do banco

Em banco novo, execute `schema.sql`, `003_recurring_appointments.sql` e `004_staff_schedule.sql`, nessa ordem. Em banco existente que já possui a recorrência, execute somente `004_staff_schedule.sql`. A migração 004 preserva as aulas e converte as sequências existentes em programações sem término.

Alternativamente, `004_apply_and_verify.sql` aplica a migração 004 e executa os testes de integração antes do commit. Os dados dos testes são revertidos com savepoint. `tests/staff.integration.sql` repete a verificação com rollback em um banco já migrado. O script valida dias fixos, conflitos, recorrência até 2040, substituições, justificativas, indicadores, histórico e encerramento. Todas as tabelas e funções exigem autorização de funcionário; eventos são produzidos pelo banco e não podem ser inseridos ou alterados diretamente pela interface.
