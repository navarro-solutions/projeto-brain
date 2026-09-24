import type { Env } from "../env";

const EMBEDDING_MODEL = "@cf/baai/bge-m3"; // multilíngue (ótimo para português), 1024 dimensões
const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

/** Gera embeddings (vetores de 1024 dimensões) para uma lista de textos. */
export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  // Lotes pequenos para não estourar os limites do Workers AI
  for (let i = 0; i < texts.length; i += 20) {
    const batch = texts.slice(i, i + 20);
    const res = (await env.AI.run(EMBEDDING_MODEL, {
      text: batch,
      truncate_inputs: true,
    })) as { data?: number[][] };
    if (!res.data || res.data.length !== batch.length) {
      throw new Error("Falha ao gerar embeddings");
    }
    out.push(...res.data);
  }
  return out;
}

export async function embedOne(env: Env, text: string): Promise<number[]> {
  const [vector] = await embed(env, [text]);
  return vector;
}

/** Transcreve áudio (qualquer formato comum: webm, mp3, m4a, wav, ogg...). */
export async function transcribe(env: Env, audio: ArrayBuffer): Promise<string> {
  const res = (await env.AI.run(WHISPER_MODEL, {
    audio: arrayBufferToBase64(audio),
    task: "transcribe",
    vad_filter: true,
  })) as { text?: string };
  return (res.text ?? "").trim();
}

/**
 * Converte documentos (docx, xlsx, pptx, odt, html, csv, xml...) em Markdown
 * usando o conversor nativo do Workers AI.
 */
export async function documentToMarkdown(env: Env, name: string, blob: Blob): Promise<string | null> {
  try {
    const res = await env.AI.toMarkdown({ name, blob });
    if (res.format === "error") return null;
    return res.data;
  } catch {
    return null;
  }
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
