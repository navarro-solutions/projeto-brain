import type { Env } from "../env";
import { describeImage, extractInsights, summarizeText } from "./claude";
import { downloadFile, indexFile } from "./files";
import { getSupabase, type FileRow } from "./supabase";
import { embed, embedOne } from "./workers-ai";

interface MemoryMatch { id: string; content: string; category: string; importance: number; similarity: number }
interface ChunkMatch { id: string; file_id: string; file_name: string; content: string; similarity: number }
interface PastMessageMatch { id: string; conversation_id: string; role: string; content: string; created_at: string; similarity: number }

export async function getProfile(env: Env): Promise<string> {
  const { data } = await getSupabase(env).from("profile").select("summary").eq("id", 1).maybeSingle();
  return data?.summary ?? "";
}

/**
 * Busca, por similaridade semântica, as memórias, trechos de arquivos e trechos de
 * conversas antigas mais relevantes para a mensagem atual.
 */
export async function retrieveContext(env: Env, query: string, conversationId: string): Promise<string> {
  if (!query.trim()) return "";
  const supabase = getSupabase(env);
  const vector = JSON.stringify(await embedOne(env, query.slice(0, 8000)));

  const [memories, chunks, past] = await Promise.all([
    supabase.rpc("match_memories", { query_embedding: vector, match_count: 10, min_similarity: 0.35 }),
    supabase.rpc("match_file_chunks", { query_embedding: vector, match_count: 6, min_similarity: 0.4 }),
    supabase.rpc("match_messages", {
      query_embedding: vector,
      exclude_conversation: conversationId,
      match_count: 5,
      min_similarity: 0.45,
    }),
  ]);

  const parts: string[] = [];
  const mem = (memories.data ?? []) as MemoryMatch[];
  if (mem.length) {
    parts.push(`<memorias>\n${mem.map((m) => `- [${m.category}] ${m.content}`).join("\n")}\n</memorias>`);
  }
  const ch = (chunks.data ?? []) as ChunkMatch[];
  if (ch.length) {
    parts.push(
      `<trechos_de_arquivos>\n${ch.map((c) => `<trecho arquivo="${c.file_name}">\n${c.content}\n</trecho>`).join("\n")}\n</trechos_de_arquivos>`,
    );
  }
  const pm = (past.data ?? []) as PastMessageMatch[];
  if (pm.length) {
    parts.push(
      `<conversas_anteriores>\n${pm
        .map((m) => `<trecho data="${m.created_at.slice(0, 10)}" autor="${m.role === "user" ? "usuário" : "assistente"}">\n${m.content.slice(0, 1500)}\n</trecho>`)
        .join("\n")}\n</conversas_anteriores>`,
    );
  }
  return parts.length ? `<contexto_recuperado>\n${parts.join("\n")}\n</contexto_recuperado>` : "";
}

/**
 * Tarefa de segundo plano executada após cada resposta: indexa as mensagens para
 * busca futura, extrai memórias/padrões de raciocínio e atualiza o perfil.
 */
export async function learnFromExchange(
  env: Env,
  args: {
    conversationId: string;
    userMessageId: string;
    assistantMessageId: string;
    userText: string;
    assistantText: string;
    needsTitle: boolean;
  },
): Promise<void> {
  const supabase = getSupabase(env);

  // 1. Embeddings das mensagens (permite lembrar de conversas antigas)
  const [userVec, assistantVec] = await embed(env, [
    args.userText.slice(0, 8000) || "(anexo)",
    args.assistantText.slice(0, 8000) || "(vazio)",
  ]);
  await Promise.all([
    supabase.from("messages").update({ embedding: JSON.stringify(userVec) }).eq("id", args.userMessageId),
    supabase.from("messages").update({ embedding: JSON.stringify(assistantVec) }).eq("id", args.assistantMessageId),
  ]);

  // 2. Memórias já existentes parecidas (para evitar duplicatas)
  const { data: related } = await supabase.rpc("match_memories", {
    query_embedding: JSON.stringify(userVec),
    match_count: 15,
    min_similarity: 0.4,
  });
  const existing = ((related ?? []) as MemoryMatch[]).map((m) => m.content);

  const profile = await getProfile(env);
  const insights = await extractInsights(env, {
    profile,
    userText: args.userText,
    assistantText: args.assistantText,
    needsTitle: args.needsTitle,
    existing,
  });
  if (!insights) return;

  // 3. Salva memórias novas (com checagem semântica de duplicidade)
  const fresh = insights.memories.filter((m) => m.content.trim());
  if (fresh.length) {
    const vectors = await embed(env, fresh.map((m) => m.content));
    for (let i = 0; i < fresh.length; i++) {
      const vec = JSON.stringify(vectors[i]);
      const { data: dup } = await supabase.rpc("match_memories", {
        query_embedding: vec,
        match_count: 1,
        min_similarity: 0.9,
      });
      if (dup && dup.length) continue;
      await supabase.from("memories").insert({
        content: fresh[i].content,
        category: fresh[i].category,
        importance: fresh[i].importance,
        source_conversation_id: args.conversationId,
        embedding: vec,
      });
    }
  }

  // 4. Perfil consolidado
  if (insights.profile.trim()) {
    await supabase.from("profile").update({ summary: insights.profile.trim(), updated_at: new Date().toISOString() }).eq("id", 1);
  }

  // 5. Título da conversa
  if (args.needsTitle && insights.title.trim()) {
    await supabase.from("conversations").update({ title: insights.title.trim().slice(0, 80) }).eq("id", args.conversationId);
  }
}

/** Processamento de arquivo em segundo plano: descrição/resumo + indexação semântica. */
export async function processFileInBackground(env: Env, file: FileRow): Promise<void> {
  const supabase = getSupabase(env);
  let summary: string | null = null;
  let text = file.extracted_text ?? "";

  if (file.kind === "image") {
    summary = await describeImage(env, file, await downloadFile(env, file));
    text = summary ?? "";
  } else if (text.length > 1500) {
    summary = await summarizeText(env, file.name, text);
  } else if (text) {
    summary = text;
  }

  if (summary) await supabase.from("files").update({ summary }).eq("id", file.id);
  const indexable = [`Arquivo: ${file.name}`, summary && summary !== text ? `Resumo: ${summary}` : "", text]
    .filter(Boolean)
    .join("\n\n");
  if (text || summary) await indexFile(env, file.id, indexable);
}
