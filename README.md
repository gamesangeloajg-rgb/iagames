# IA Games — Game & App Studio

## Motor de criação (MVP)

Servidor Node.js sem dependências externas, planejamento por IA, geração de projetos web e persistência local em pastas de projeto.

### Executar

- Node.js 20 ou superior.
- Copie `.env.example` para `.env`.
- Configure `AI_API_KEY` e `AI_MODEL`; ajuste `AI_BASE_URL` se necessário.
- Execute `npm start` e abra http://127.0.0.1:3000.

### Endpoints

- `GET /api/health`: estado do servidor e configuração da IA.
- `POST /api/projects/plan`: cria plano técnico a partir de `{"prompt":"..." }`.
- `POST /api/projects/create`: gera um projeto frontend real, salva seus arquivos e retorna o conteúdo para preview.
- `GET /api/projects`: lista os projetos salvos.
- `GET /api/projects/:id`: recupera um projeto salvo para reabertura.\n- `POST /api/projects/:id/modify`: altera um projeto existente preservando os arquivos permitidos.\n- `GET /api/projects/:id/versions`: lista snapshots anteriores.\n- `POST /api/projects/:id/rollback`: restaura um snapshot com `{"versionId":"..."}`.

### Geração e isolamento

A geração e as alterações aceitam somente `index.html`, `style.css` e `script.js`, com até 60 KB no total. Os projetos ficam em `.iagames-data/projects`, fora do Git. O servidor não executa os arquivos gerados. O preview usa iframe com sandbox restrito, sem permissão de mesma origem, e uma política CSP que bloqueia rede, frames e formulários.

As alterações salvam um snapshot dos arquivos anteriores antes de gravar a nova versão. O rollback também preserva o estado atual como snapshot. O código gerado nunca é executado no servidor.\n\n### Testes

Execute `npm test` para validar inicialização, endpoints, validação do briefing e bloqueio de arquivos privados. O GitHub Actions executa também `node --check server.mjs` em cada push para `main` e pull request.

### Limitações e próximos passos

Esta é uma base de MVP para uso local. Não exponha o servidor diretamente à internet: ainda faltam autenticação, autorização, rate limiting, quotas, isolamento multiusuário e execução em container/VM efêmera. O preview em iframe restrito não substitui isolamento de execução no backend.
