# Verificação para publicação — 16/10/2026

Resultado: aplicação preparada para envio ao Git e deploy no Netlify. Ainda não publicada.

## Verificado

- Sete testes automatizados: cadastro/edição local, preservação do histórico, edição/exclusão de aula, autenticação e autorização, rejeição de funcionário sem acesso, renovação concorrente de sessão, sessão revogada e paginação (alguns itens compartilham o mesmo teste).
- Sintaxe dos módulos e do script gerado; build estático.
- Login real feito pelo usuário na aplicação, usando Supabase Auth. Agenda carregou com o perfil e cargo cadastrados.
- Agenda diária/semanal e abertura do formulário de professor quando não há professor cadastrado. Nenhum erro no console durante essa navegação.
- Banco real: acesso com as permissões da funcionária, cadastro de professor e aula, leitura, edição e exclusão de aula e inativação de professor. Tudo em transação com rollback, sem persistir os registros de teste.
- RLS habilitado nas três tabelas, com políticas de acesso.
- API real: leitura anônima de staff, teachers e appointments bloqueada com HTTP 401 e erro de permissão 42501.
- Login por e-mail habilitado; cadastros públicos e login anônimo desabilitados.
- Configuração Netlify com Node.js 22, testes antes do build, diretório dist e cabeçalhos de resposta.

## Limites e próximos passos

- Não houve teste de salvar aulas pela interface com registros persistidos; essas operações foram verificadas no banco por transação e na camada de dados com testes automatizados.
- Ainda não há professores reais cadastrados. O estúdio deve cadastrá-los antes do primeiro agendamento.
- Esta pasta não é um repositório Git e não tem remoto. É necessário definir o repositório de destino antes de enviar.
- Ainda não há site Netlify criado. Após o deploy, conferir o login no domínio HTTPS e configurar esse domínio como Site URL no Supabase.
- As telas recarregam ao salvar ou clicar em Atualizar; não há sincronização em tempo real entre funcionários.

## Reproduzir

```text
npm ci
npm run check
npm test
npm run build
node --check src/browser.js
node scripts/check-public-access.mjs
```

O último comando usa a rede e verifica o projeto configurado em config.js. Os testes automatizados usam dados locais ou respostas simuladas e não gravam no Supabase.

## Recorrência — publicação em 19/10/2026

- Migração `003_recurring_appointments.sql` aplicada ao Supabase de produção.
- Teste transacional sob a função `authenticated`, com identidade de funcionário autorizado, confirmou criação de três aulas, deslocamento da sequência em uma semana, preservação de `created_by`, rejeição de duplicidade com atomicidade, edição individual e exclusão por sequência. Todo o teste foi encerrado com rollback.
- `npm run check`, `npm test` (10 testes) e `npm run build` concluídos com sucesso.
