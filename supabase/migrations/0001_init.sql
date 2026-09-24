-- Projeto Brain — esquema inicial do Supabase
-- Execute no SQL Editor do Supabase (ou via `supabase db push`).

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Conversas e mensagens
-- ---------------------------------------------------------------------------
create table if not exists conversations (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default 'Nova conversa',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,
  role             text not null check (role in ('user', 'assistant')),
  content          text not null,
  attachments      jsonb not null default '[]'::jsonb, -- [{id, name, mime_type}]
  embedding        vector(1024),
  created_at       timestamptz not null default now()
);
create index if not exists messages_conversation_idx on messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Arquivos enviados (binário fica no Storage, texto extraído fica aqui)
-- ---------------------------------------------------------------------------
create table if not exists files (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid references conversations(id) on delete set null,
  name             text not null,
  mime_type        text not null,
  size_bytes       bigint not null,
  storage_path     text not null,
  kind             text not null, -- image | pdf | audio | text | document | other
  extracted_text   text,
  summary          text,
  created_at       timestamptz not null default now()
);

create table if not exists file_chunks (
  id          uuid primary key default gen_random_uuid(),
  file_id     uuid not null references files(id) on delete cascade,
  chunk_index int  not null,
  content     text not null,
  embedding   vector(1024) not null
);
create index if not exists file_chunks_embedding_idx
  on file_chunks using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Memória de longo prazo: fatos, preferências e padrões de raciocínio
-- ---------------------------------------------------------------------------
create table if not exists memories (
  id                     uuid primary key default gen_random_uuid(),
  content                text not null,
  category               text not null default 'fato', -- fato | preferencia | raciocinio | objetivo | projeto | pessoa
  importance             int  not null default 3 check (importance between 1 and 5),
  source_conversation_id uuid references conversations(id) on delete set null,
  embedding              vector(1024) not null,
  created_at             timestamptz not null default now()
);
create index if not exists memories_embedding_idx
  on memories using hnsw (embedding vector_cosine_ops);

-- Perfil consolidado do usuário (linha única, id = 1)
create table if not exists profile (
  id          int primary key default 1 check (id = 1),
  summary     text not null default '',
  updated_at  timestamptz not null default now()
);
insert into profile (id) values (1) on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Busca semântica
-- ---------------------------------------------------------------------------
create or replace function match_memories(
  query_embedding vector(1024),
  match_count int default 8,
  min_similarity float default 0.3
)
returns table (id uuid, content text, category text, importance int, similarity float)
language sql stable as $$
  select m.id, m.content, m.category, m.importance,
         1 - (m.embedding <=> query_embedding) as similarity
  from memories m
  where 1 - (m.embedding <=> query_embedding) >= min_similarity
  order by m.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function match_file_chunks(
  query_embedding vector(1024),
  match_count int default 6,
  min_similarity float default 0.3
)
returns table (id uuid, file_id uuid, file_name text, content text, similarity float)
language sql stable as $$
  select c.id, c.file_id, f.name, c.content,
         1 - (c.embedding <=> query_embedding) as similarity
  from file_chunks c
  join files f on f.id = c.file_id
  where 1 - (c.embedding <=> query_embedding) >= min_similarity
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function match_messages(
  query_embedding vector(1024),
  exclude_conversation uuid,
  match_count int default 5,
  min_similarity float default 0.4
)
returns table (id uuid, conversation_id uuid, role text, content text, created_at timestamptz, similarity float)
language sql stable as $$
  select m.id, m.conversation_id, m.role, m.content, m.created_at,
         1 - (m.embedding <=> query_embedding) as similarity
  from messages m
  where m.embedding is not null
    and (exclude_conversation is null or m.conversation_id <> exclude_conversation)
    and 1 - (m.embedding <=> query_embedding) >= min_similarity
  order by m.embedding <=> query_embedding
  limit match_count;
$$;

-- ---------------------------------------------------------------------------
-- Segurança: o Worker usa a service_role key (ignora RLS). Com RLS ligado e
-- sem políticas, a chave anon pública não consegue ler nada.
-- ---------------------------------------------------------------------------
alter table conversations enable row level security;
alter table messages      enable row level security;
alter table files         enable row level security;
alter table file_chunks   enable row level security;
alter table memories      enable row level security;
alter table profile       enable row level security;

-- Bucket privado para os arquivos enviados
insert into storage.buckets (id, name, public)
values ('brain-files', 'brain-files', false)
on conflict (id) do nothing;
