import type Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import { getSupabase, type FileKind, type FileRow } from "./supabase";
import { arrayBufferToBase64, documentToMarkdown, embed, transcribe } from "./workers-ai";

const CLAUDE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024; // limite da API para imagens
const MAX_INLINE_PDF_BYTES = 30 * 1024 * 1024; // limite de requisição é 32 MB
const MAX_TEXT_CHARS_PER_FILE = 400_000;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "log",
  "html", "htm", "css", "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp",
  "hpp", "cs", "php", "sh", "bash", "sql", "swift", "r", "scala", "lua", "dart", "vue", "svelte", "env",
]);
const DOCUMENT_EXTENSIONS = new Set(["docx", "xlsx", "xls", "xlsm", "xlsb", "ods", "odt", "pptx", "numbers", "et"]);

export function classifyFile(name: string, mime: string): FileKind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.startsWith("audio/") || ["mp3", "wav", "m4a", "ogg", "webm", "flac", "aac", "opus"].includes(ext)) {
    return "audio";
  }
  if (mime.startsWith("text/") || TEXT_EXTENSIONS.has(ext) || mime === "application/json") return "text";
  if (DOCUMENT_EXTENSIONS.has(ext) || mime.includes("officedocument") || mime.includes("opendocument")) {
    return "document";
  }
  return "other";
}

function safeName(name: string): string {
  return name.normalize("NFKD").replace(/[^\w.\-]+/g, "_").slice(-120) || "arquivo";
}

/** Extrai texto de qualquer tipo de arquivo suportado. */
async function extractText(env: Env, kind: FileKind, name: string, mime: string, data: ArrayBuffer) {
  switch (kind) {
    case "text":
      return new TextDecoder("utf-8").decode(data);
    case "audio":
      return transcribe(env, data);
    case "pdf":
    case "document":
      return documentToMarkdown(env, name, new Blob([data], { type: mime }));
    case "image":
      return null; // descrita pelo Claude em segundo plano (ver describeImage em claude.ts)
    default: {
      // Tenta como texto; se tiver muitos bytes nulos é binário
      const sample = new Uint8Array(data.slice(0, 4096));
      if (sample.some((b) => b === 0)) return null;
      return new TextDecoder("utf-8").decode(data);
    }
  }
}

/** Salva o arquivo no Storage e registra no banco com o texto extraído. */
export async function ingestFile(env: Env, file: File, conversationId: string | null): Promise<FileRow> {
  const supabase = getSupabase(env);
  const data = await file.arrayBuffer();
  const mime = file.type || "application/octet-stream";
  const kind = classifyFile(file.name, mime);
  const now = new Date();
  const storagePath = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}-${safeName(file.name)}`;

  const { error: uploadError } = await supabase.storage
    .from(env.SUPABASE_BUCKET)
    .upload(storagePath, data, { contentType: mime, upsert: false });
  if (uploadError) throw new Error(`Erro ao salvar no Storage: ${uploadError.message}`);

  let extracted: string | null = null;
  try {
    extracted = await extractText(env, kind, file.name, mime, data);
  } catch (err) {
    console.error("Falha na extração de texto", file.name, err);
  }

  const { data: row, error } = await supabase
    .from("files")
    .insert({
      conversation_id: conversationId,
      name: file.name,
      mime_type: mime,
      size_bytes: data.byteLength,
      storage_path: storagePath,
      kind,
      extracted_text: extracted?.trim() || null,
    })
    .select()
    .single();
  if (error) throw new Error(`Erro ao registrar arquivo: ${error.message}`);
  return row as FileRow;
}

/** Quebra o texto em pedaços sobrepostos para busca semântica. */
export function chunkText(text: string, size = 1500, overlap = 200): string[] {
  const clean = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const breakAt = clean.lastIndexOf("\n", end);
      if (breakAt > start + size / 2) end = breakAt;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = end - overlap;
  }
  return chunks.filter(Boolean);
}

/** Indexa o conteúdo do arquivo (texto + resumo) na memória semântica. */
export async function indexFile(env: Env, fileId: string, text: string): Promise<void> {
  const supabase = getSupabase(env);
  const chunks = chunkText(text);
  if (chunks.length === 0) return;
  const vectors = await embed(env, chunks);
  const rows = chunks.map((content, i) => ({
    file_id: fileId,
    chunk_index: i,
    content,
    embedding: JSON.stringify(vectors[i]),
  }));
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await supabase.from("file_chunks").insert(rows.slice(i, i + 100));
    if (error) throw new Error(`Erro ao indexar arquivo: ${error.message}`);
  }
}

export async function downloadFile(env: Env, file: FileRow): Promise<ArrayBuffer> {
  const { data, error } = await getSupabase(env).storage.from(env.SUPABASE_BUCKET).download(file.storage_path);
  if (error || !data) throw new Error(`Erro ao baixar ${file.name}: ${error?.message}`);
  return data.arrayBuffer();
}

function textBlock(file: FileRow, text: string): Anthropic.Beta.BetaContentBlockParam {
  const truncated = text.length > MAX_TEXT_CHARS_PER_FILE;
  const body = truncated ? text.slice(0, MAX_TEXT_CHARS_PER_FILE) : text;
  const note = truncated
    ? `\n[AVISO: arquivo muito grande; apenas os primeiros ${MAX_TEXT_CHARS_PER_FILE} caracteres foram incluídos. O restante está indexado na memória.]`
    : "";
  return {
    type: "text",
    text: `<arquivo nome="${file.name}" tipo="${file.mime_type}">\n${body}${note}\n</arquivo>`,
  };
}

/** Monta os blocos de conteúdo que o Claude recebe para cada anexo da mensagem atual. */
export async function buildAttachmentBlocks(env: Env, files: FileRow[]): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const file of files) {
    if (file.kind === "image" && CLAUDE_IMAGE_TYPES.has(file.mime_type) && file.size_bytes <= MAX_INLINE_IMAGE_BYTES) {
      const data = await downloadFile(env, file);
      blocks.push({ type: "text", text: `Imagem anexada: ${file.name}` });
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: file.mime_type as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: arrayBufferToBase64(data),
        },
      });
    } else if (file.kind === "pdf" && file.size_bytes <= MAX_INLINE_PDF_BYTES) {
      const data = await downloadFile(env, file);
      blocks.push({
        type: "document",
        title: file.name,
        source: { type: "base64", media_type: "application/pdf", data: arrayBufferToBase64(data) },
      });
    } else if (file.extracted_text) {
      const label = file.kind === "audio" ? `${file.extracted_text}\n(transcrição do áudio)` : file.extracted_text;
      blocks.push(textBlock(file, label));
    } else if (file.summary) {
      blocks.push(textBlock(file, `Descrição: ${file.summary}`));
    } else {
      blocks.push({
        type: "text",
        text: `[Arquivo "${file.name}" (${file.mime_type}, ${file.size_bytes} bytes) foi salvo, mas não foi possível extrair seu conteúdo.]`,
      });
    }
  }
  return blocks;
}
