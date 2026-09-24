# 🧠 Projeto Brain

Um "segundo cérebro" pessoal com IA, rodando na **Cloudflare Workers**, com memória permanente no **Supabase** e respostas geradas pelo **Claude** (Anthropic).

Você envia textos, áudios e **qualquer tipo de arquivo**. O Brain guarda tudo, entende o conteúdo, aprende como você pensa e usa esse conhecimento para te ajudar com os problemas do dia a dia.

## O que ele faz

| Recurso | Como funciona |
|---|---|
| 💬 Chat com streaming | O Claude responde em tempo real (SSE), com raciocínio adaptativo e **busca na web** quando precisa |
| 🎙️ Áudio | Grava pelo navegador → transcrição com Whisper (Workers AI) → vira mensagem |
| 📎 Qualquer arquivo | Imagens e PDFs vão direto para o Claude (visão/documento). Word, Excel, PowerPoint, ODT, HTML, CSV etc. são convertidos em Markdown (Workers AI `toMarkdown`). Código e texto são lidos direto. Áudios enviados como arquivo são transcritos |
| 🗄️ Armazenamento | Arquivos originais no **Supabase Storage**; conversas, mensagens e textos extraídos no **Postgres** |
| 🔎 Memória semântica | Tudo recebe embeddings (`bge-m3`, multilíngue) em **pgvector**. A cada mensagem, o Brain busca memórias, trechos de arquivos e conversas antigas relevantes |
| 🧩 Aprendizado contínuo | Depois de cada resposta, em segundo plano, o Claude extrai **fatos, preferências, projetos, pessoas e padrões de raciocínio** seus e atualiza um **perfil consolidado** que vai em todas as conversas |
| ✏️ Controle total | Painel para ver/editar seu perfil, apagar memórias e baixar arquivos guardados |

## Arquitetura

```
Navegador (public/)  ──►  Cloudflare Worker (src/, Hono)
                             │
                             ├─► Claude API ............ chat, visão, PDFs, extração de memórias
                             ├─► Workers AI ............ Whisper (áudio), bge-m3 (embeddings), toMarkdown (docs)
                             └─► Supabase
                                   ├─ Postgres + pgvector ... conversas, mensagens, arquivos, memórias, perfil
                                   └─ Storage (brain-files)  arquivos originais
```

Fluxo de uma mensagem:
1. Salva a mensagem do usuário.
2. Busca contexto: perfil + memórias + trechos de arquivos + conversas passadas (similaridade vetorial).
3. Monta a requisição (histórico recente + contexto + anexos) e faz streaming da resposta do Claude.
4. Salva a resposta e, em segundo plano (`waitUntil`), gera embeddings, extrai novas memórias, atualiza o perfil e dá título à conversa.

## Estrutura

```
src/
  index.ts          rotas da API (Hono)
  env.ts            tipos dos bindings/segredos
  lib/claude.ts     cliente Claude, prompt do sistema, streaming, extração de memórias
  lib/memory.ts     busca de contexto (RAG) e aprendizado contínuo
  lib/files.ts      ingestão/extração/indexação de arquivos
  lib/workers-ai.ts Whisper, embeddings, toMarkdown
  lib/supabase.ts   cliente e tipos do banco
public/             interface web (HTML/CSS/JS puro, responsiva, modo escuro)
supabase/migrations/0001_init.sql   esquema do banco
```

## Como publicar

### 1. Supabase
1. Crie um projeto em [supabase.com](https://supabase.com).
2. Em **SQL Editor**, cole e execute `supabase/migrations/0001_init.sql` (cria tabelas, pgvector, funções de busca e o bucket privado `brain-files`).
3. Em **Project Settings → API**, copie a **Project URL** e a chave **service_role** (secreta — só vai no Worker).

### 2. Anthropic
Crie uma chave de API em [console.anthropic.com](https://console.anthropic.com).

### 3. Cloudflare
```bash
npm install
npx wrangler login

npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put APP_TOKEN          # sua senha de acesso ao Brain

npm run deploy
```
Acesse a URL `https://projeto-brain.<sua-conta>.workers.dev` e entre com o `APP_TOKEN`.

### Desenvolvimento local
```bash
cp .dev.vars.example .dev.vars   # preencha os valores
npm run dev                      # Workers AI roda remoto (precisa de `wrangler login`)
npm run typecheck
```

## Configuração

| Variável | Onde | Padrão |
|---|---|---|
| `CLAUDE_MODEL` | `wrangler.jsonc` → `vars` | `claude-opus-5` |
| `SUPABASE_BUCKET` | `wrangler.jsonc` → `vars` | `brain-files` |
| `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_TOKEN` | segredos (`wrangler secret put`) | — |

O chat usa o fallback automático do lado do servidor (`fallbacks: "default"`): se o modelo principal recusar um pedido, a API tenta de novo com o modelo de fallback recomendado.

## Segurança
- Uso pessoal: acesso protegido por um token (`APP_TOKEN`) enviado como `Authorization: Bearer`.
- A chave `service_role` do Supabase fica só no Worker; RLS está ativado sem políticas, então a chave pública (anon) não lê nada.
- O bucket de arquivos é privado; downloads usam URLs assinadas que expiram em 10 minutos.

## Próximos passos sugeridos
- Login com Supabase Auth (vários usuários) no lugar do token único.
- Integração com Telegram/WhatsApp para mandar áudios e arquivos direto do celular.
- Ferramentas (tool use) para o Claude criar lembretes, tarefas e consultar a agenda.
- Resumos semanais automáticos com Cron Triggers da Cloudflare.
