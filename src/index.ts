import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppContext } from "./env";
import { buildSystem, streamChat } from "./lib/claude";
import { buildAttachmentBlocks, ingestFile } from "./lib/files";
import { getProfile, learnFromExchange, processFileInBackground, retrieveContext } from "./lib/memory";
import { getSupabase, type FileRow, type MessageRow } from "./lib/supabase";
import { transcribe } from "./lib/workers-ai";

const HISTORY_LIMIT = 40;

const app = new Hono<AppContext>();

// ---------------------------------------------------------------------------
// Autenticação simples por token (uso pessoal)
// ---------------------------------------------------------------------------
/**
 * Diagnóstico público: mostra apenas QUAIS configurações existem (nunca os valores).
 * Abra /api/health no navegador para conferir o deploy.
 */
app.get("/api/health", async (c) => {
  const env = c.env;
  const secrets = {
    APP_TOKEN: Boolean(env.APP_TOKEN?.trim()),
    ANTHROPIC_API_KEY: Boolean(env.ANTHROPIC_API_KEY?.trim()),
    SUPABASE_URL: Boolean(env.SUPABASE_URL?.trim()),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
  };
  let database = "não testado (faltam SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY)";
  if (secrets.SUPABASE_URL && secrets.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { error } = await getSupabase(env).from("profile").select("id").limit(1);
      database = error ? `erro: ${error.message}` : "ok";
    } catch (err) {
      database = `erro: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // Nomes (nunca valores) de tudo que o Worker recebeu — ajuda a achar nomes digitados errado
  const received = Object.keys(env).sort();
  return c.json({ secrets, database, ai_binding: Boolean(env.AI), model: env.CLAUDE_MODEL, received });
});

app.use("/api/*", async (c, next) => {
  const expected = c.env.APP_TOKEN?.trim();
  if (!expected) {
    return c.json({ error: "APP_TOKEN não configurado no Worker (Settings → Variables and Secrets)" }, 503);
  }
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!(await safeEqual(token, expected))) {
    return c.json({ error: "Senha incorreta" }, 401);
  }
  await next();
});

/** Só confere a senha (não depende do banco). */
app.get("/api/auth", (c) => c.json({ ok: true }));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message || "Erro interno" }, 500);
});

// ---------------------------------------------------------------------------
// Conversas
// ---------------------------------------------------------------------------
app.get("/api/conversations", async (c) => {
  const { data, error } = await getSupabase(c.env)
    .from("conversations")
    .select("id, title, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return c.json(data);
});

app.post("/api/conversations", async (c) => {
  const { data, error } = await getSupabase(c.env).from("conversations").insert({}).select().single();
  if (error) throw error;
  return c.json(data);
});

app.get("/api/conversations/:id/messages", async (c) => {
  const { data, error } = await getSupabase(c.env)
    .from("messages")
    .select("id, role, content, attachments, created_at")
    .eq("conversation_id", c.req.param("id"))
    .order("created_at", { ascending: true });
  if (error) throw error;
  return c.json(data);
});

app.delete("/api/conversations/:id", async (c) => {
  const { error } = await getSupabase(c.env).from("conversations").delete().eq("id", c.req.param("id"));
  if (error) throw error;
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Arquivos (qualquer tipo) e áudio
// ---------------------------------------------------------------------------
app.post("/api/files", async (c) => {
  const form = await c.req.formData();
  const conversationId = (form.get("conversationId") as string | null) || null;
  const uploads = form.getAll("files").filter((f): f is File => f instanceof File);
  if (uploads.length === 0) return c.json({ error: "Nenhum arquivo enviado" }, 400);

  const saved: FileRow[] = [];
  for (const file of uploads) {
    const row = await ingestFile(c.env, file, conversationId);
    saved.push(row);
    c.executionCtx.waitUntil(
      processFileInBackground(c.env, row).catch((err) => console.error("Indexação falhou", row.name, err)),
    );
  }
  return c.json(
    saved.map((f) => ({
      id: f.id,
      name: f.name,
      mime_type: f.mime_type,
      kind: f.kind,
      size_bytes: f.size_bytes,
      preview: f.extracted_text?.slice(0, 300) ?? null,
    })),
  );
});

app.get("/api/files", async (c) => {
  const { data, error } = await getSupabase(c.env)
    .from("files")
    .select("id, name, mime_type, kind, size_bytes, summary, conversation_id, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return c.json(data);
});

app.get("/api/files/:id/url", async (c) => {
  const supabase = getSupabase(c.env);
  const { data: file, error } = await supabase.from("files").select("storage_path, name").eq("id", c.req.param("id")).single();
  if (error || !file) return c.json({ error: "Arquivo não encontrado" }, 404);
  const { data } = await supabase.storage
    .from(c.env.SUPABASE_BUCKET)
    .createSignedUrl(file.storage_path, 600, { download: file.name });
  return c.json({ url: data?.signedUrl });
});

/** Transcreve um áudio gravado no navegador (não salva — o texto vira mensagem). */
app.post("/api/transcribe", async (c) => {
  const form = await c.req.formData();
  const audio = form.get("audio");
  if (!(audio instanceof File)) return c.json({ error: "Envie o campo 'audio'" }, 400);
  const text = await transcribe(c.env, await audio.arrayBuffer());
  return c.json({ text });
});

// ---------------------------------------------------------------------------
// Memória e perfil
// ---------------------------------------------------------------------------
app.get("/api/memories", async (c) => {
  const { data, error } = await getSupabase(c.env)
    .from("memories")
    .select("id, content, category, importance, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  return c.json(data);
});

app.delete("/api/memories/:id", async (c) => {
  const { error } = await getSupabase(c.env).from("memories").delete().eq("id", c.req.param("id"));
  if (error) throw error;
  return c.json({ ok: true });
});

app.get("/api/profile", async (c) => c.json({ summary: await getProfile(c.env) }));

app.put("/api/profile", async (c) => {
  const { summary } = await c.req.json<{ summary: string }>();
  const { error } = await getSupabase(c.env)
    .from("profile")
    .update({ summary: summary ?? "", updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) throw error;
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Chat (streaming via Server-Sent Events)
// ---------------------------------------------------------------------------
app.post("/api/chat", async (c) => {
  const body = await c.req.json<{ conversationId?: string; message?: string; fileIds?: string[] }>();
  const userText = (body.message ?? "").trim();
  const fileIds = body.fileIds ?? [];
  if (!userText && fileIds.length === 0) return c.json({ error: "Mensagem vazia" }, 400);

  const env = c.env;
  const supabase = getSupabase(env);

  // Conversa (cria se não existir)
  let conversationId = body.conversationId;
  if (!conversationId) {
    const { data, error } = await supabase.from("conversations").insert({}).select().single();
    if (error) throw error;
    conversationId = data.id as string;
  }

  // Arquivos anexados nesta mensagem
  let files: FileRow[] = [];
  if (fileIds.length) {
    const { data, error } = await supabase.from("files").select("*").in("id", fileIds);
    if (error) throw error;
    files = (data ?? []) as FileRow[];
    await supabase.from("files").update({ conversation_id: conversationId }).in("id", fileIds).is("conversation_id", null);
  }

  // Histórico recente da conversa
  const { data: historyDesc, error: histError } = await supabase
    .from("messages")
    .select("id, role, content, attachments, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  if (histError) throw histError;
  const history = ((historyDesc ?? []) as MessageRow[]).reverse();
  const needsTitle = history.length === 0;

  // Salva a mensagem do usuário
  const attachments = files.map((f) => ({ id: f.id, name: f.name, mime_type: f.mime_type }));
  const { data: userRow, error: userErr } = await supabase
    .from("messages")
    .insert({ conversation_id: conversationId, role: "user", content: userText, attachments })
    .select("id")
    .single();
  if (userErr) throw userErr;

  // Contexto: perfil + memória semântica + anexos
  const retrievalQuery = [userText, ...files.map((f) => f.name)].join("\n");
  const [profile, retrieved, attachmentBlocks] = await Promise.all([
    getProfile(env),
    retrieveContext(env, retrievalQuery, conversationId),
    buildAttachmentBlocks(env, files),
  ]);

  const messages = toClaudeHistory(history);
  const current: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (retrieved) current.push({ type: "text", text: retrieved });
  current.push(...attachmentBlocks);
  current.push({ type: "text", text: userText || "(O usuário enviou apenas os anexos acima. Analise-os.)" });
  messages.push({ role: "user", content: current });

  const finalConversationId = conversationId;
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: "meta", data: JSON.stringify({ conversationId: finalConversationId }) });
    let assistantText = "";
    try {
      const result = await streamChat(env, buildSystem(profile), messages, {
        onText: (text) => stream.writeSSE({ event: "text", data: JSON.stringify({ text }) }),
        onStatus: (status) => stream.writeSSE({ event: "status", data: JSON.stringify({ status }) }),
      });
      assistantText = result.text;
      if (result.stopReason === "refusal" && !assistantText) {
        assistantText = "Não posso ajudar com esse pedido.";
        await stream.writeSSE({ event: "text", data: JSON.stringify({ text: assistantText }) });
      }
    } catch (err) {
      const message = err instanceof Anthropic.APIError ? `Erro da API (${err.status}): ${err.message}` : String(err);
      console.error(err);
      await stream.writeSSE({ event: "error", data: JSON.stringify({ message }) });
      return;
    }

    const { data: assistantRow } = await supabase
      .from("messages")
      .insert({ conversation_id: finalConversationId, role: "assistant", content: assistantText })
      .select("id")
      .single();
    await supabase.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", finalConversationId);
    await stream.writeSSE({ event: "done", data: JSON.stringify({ messageId: assistantRow?.id }) });

    // Aprendizado contínuo em segundo plano
    if (assistantRow) {
      const userForMemory = [
        userText,
        ...files.map((f) => `[Anexo: ${f.name}]${f.extracted_text ? `\n${f.extracted_text.slice(0, 4000)}` : ""}`),
      ].join("\n");
      c.executionCtx.waitUntil(
        learnFromExchange(env, {
          conversationId: finalConversationId,
          userMessageId: userRow.id,
          assistantMessageId: assistantRow.id,
          userText: userForMemory,
          assistantText,
          needsTitle,
        }).catch((err) => console.error("Aprendizado falhou", err)),
      );
    }
  });
});

/**
 * Converte o histórico salvo no formato da API. Anexos antigos aparecem só pelo
 * nome (seu conteúdo continua acessível via busca semântica). O cache de prompt
 * é marcado no fim do histórico, que se mantém estável no turno seguinte.
 */
function toClaudeHistory(rows: MessageRow[]): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const row of rows) {
    const names = (row.attachments ?? []).map((a) => a.name);
    const text = [row.content, names.length ? `[Anexos: ${names.join(", ")}]` : ""].filter(Boolean).join("\n\n") || "(vazio)";
    out.push({ role: row.role, content: [{ type: "text", text }] });
  }
  while (out.length && out[0].role !== "user") out.shift();
  const last = out[out.length - 1];
  if (last && Array.isArray(last.content)) {
    const block = last.content[last.content.length - 1];
    if (block.type === "text") block.cache_control = { type: "ephemeral" };
  }
  return out;
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export default app;
