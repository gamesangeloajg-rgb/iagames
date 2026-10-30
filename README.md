# IA Games — Game & App Studio

## Primeira camada do motor de IA

Servidor HTTP em Node.js sem dependências externas, endpoint de saúde e planejamento de projetos por um provedor compatível com OpenAI Chat Completions.

### Requisitos e execução

- Node.js 20 ou superior.
- Copie `.env.example` para `.env`.
- Configure `AI_API_KEY` e `AI_MODEL`. Ajuste `AI_BASE_URL` se usar outro provedor compatível.
- Execute `npm start` e abra http://127.0.0.1:3000.
- Desenvolvimento: `npm run dev`.

### API

- `GET /api/health`: informa se o servidor está ativo e se as credenciais/configuração do modelo existem, sem revelar a chave.
- `POST /api/projects/plan`: recebe `{"prompt":"Crie um jogo 2D de plataforma."}` e retorna `plan` com título, tipo, resumo, funcionalidades, tecnologias e etapas.

### Segurança e limites atuais

- Escuta em `127.0.0.1` por padrão; não exponha diretamente à internet.
- Chaves são lidas no servidor a partir de `.env` ou variáveis de ambiente; `.env` está ignorado pelo Git.
- Briefings limitados a 5.000 caracteres; corpo HTTP limitado a 64 KB; chamada ao modelo tem timeout.
- Não persiste briefings, não gera arquivos e não executa código retornado pelo modelo.
- Antes de uso multiusuário: autenticação, autorização, rate limiting, gestão de segredos e isolamento por projeto.

### Próxima etapa

Persistência de projetos/histórico e geração de arquivos em workspace isolado, com testes automatizados antes de habilitar execução e preview real.
