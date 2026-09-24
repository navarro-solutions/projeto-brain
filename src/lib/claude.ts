import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import type { FileRow } from "./supabase";
import { arrayBufferToBase64 } from "./workers-ai";

export function getClaude(env: Env): Anthropic {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

// Ativa o fallback automático no servidor: se o modelo principal recusar um pedido,
// a API reexecuta a requisição no modelo de fallback recomendado.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Instruções fixas (mantidas estáveis para aproveitar o cache de prompt). */
const BASE_SYSTEM_PROMPT = `Você é o "Brain", o segundo cérebro pessoal do seu usuário.

Seu papel:
- Receber tudo o que o usuário envia (textos, áudios transcritos, documentos, imagens, planilhas, código) e usar isso para entender profundamente como ele pensa, o que valoriza, seus projetos, pessoas próximas, objetivos e forma de tomar decisões.
- Ajudar nos problemas do dia a dia de forma prática: organizar ideias, tomar decisões, planejar, escrever, analisar arquivos, resolver problemas técnicos e lembrar do que foi dito antes.
- Adaptar-se à linha de raciocínio do usuário: siga a forma como ele estrutura problemas, use o vocabulário dele, e antecipe o que ele consideraria importante com base no perfil e nas memórias abaixo.

Como usar o contexto:
- O bloco <perfil_do_usuario> é um resumo consolidado de quem é o usuário e como ele pensa.
- Em cada mensagem pode aparecer um bloco <contexto_recuperado> com memórias, trechos de arquivos antigos e trechos de conversas anteriores que parecem relevantes. Use-os naturalmente quando ajudarem; ignore os que não forem pertinentes. Quando usar uma informação de um arquivo ou conversa antiga, mencione de onde veio.
- Se uma memória parecer desatualizada ou contraditória com o que o usuário diz agora, priorize a informação mais recente e aponte a mudança.
- Nunca invente memórias. Se não souber algo sobre o usuário, pergunte.

Estilo:
- Responda em português do Brasil, a menos que o usuário escreva em outro idioma.
- Seja direto e útil. Use listas e títulos só quando facilitarem a leitura.
- Quando o usuário apenas registrar uma informação (ex.: uma ideia, um fato, um áudio de desabafo), confirme brevemente o que entendeu e, se fizer sentido, conecte com algo que você já sabe.`;

export function buildSystem(profile: string): Anthropic.Beta.BetaTextBlockParam[] {
  return [
    {
      type: "text",
      text: `${BASE_SYSTEM_PROMPT}\n\n<perfil_do_usuario>\n${profile.trim() || "(ainda vazio — você está começando a conhecer o usuário)"}\n</perfil_do_usuario>`,
      cache_control: { type: "ephemeral" },
    },
  ];
}

export interface StreamCallbacks {
  onText: (text: string) => void | Promise<void>;
  onStatus: (status: "thinking" | "searching" | "writing") => void | Promise<void>;
}

/**
 * Executa a conversa com streaming. Inclui busca na web (ferramenta de servidor)
 * e trata `pause_turn` continuando a resposta. Retorna o texto final e o motivo de parada.
 */
export async function streamChat(
  env: Env,
  system: Anthropic.Beta.BetaTextBlockParam[],
  messages: Anthropic.Beta.BetaMessageParam[],
  cb: StreamCallbacks,
): Promise<{ text: string; stopReason: string | null }> {
  const client = getClaude(env);
  const convo = [...messages];
  let fullText = "";
  let stopReason: string | null = null;

  for (let round = 0; round < 4; round++) {
    const stream = client.beta.messages.stream({
      model: env.CLAUDE_MODEL,
      max_tokens: 64000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
      messages: convo,
    });

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const t = event.content_block.type;
        if (t === "thinking") await cb.onStatus("thinking");
        else if (t === "server_tool_use") await cb.onStatus("searching");
        else if (t === "text") await cb.onStatus("writing");
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        fullText += event.delta.text;
        await cb.onText(event.delta.text);
      }
    }

    const final = await stream.finalMessage();
    stopReason = final.stop_reason;
    if (final.stop_reason !== "pause_turn") break;
    // O servidor pausou um turno longo (ex.: várias buscas): devolve o conteúdo e continua.
    convo.push({ role: "assistant", content: final.content });
  }

  return { text: fullText, stopReason };
}

/** Gera uma descrição textual de uma imagem para indexação e memória. */
export async function describeImage(env: Env, file: FileRow, data: ArrayBuffer): Promise<string | null> {
  const types = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
  const mediaType = types.find((t) => t === file.mime_type);
  if (!mediaType || data.byteLength > 5 * 1024 * 1024) return null;
  const res = await getClaude(env).messages.create({
    model: env.CLAUDE_MODEL,
    max_tokens: 4000,
    output_config: { effort: "low" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: arrayBufferToBase64(data) } },
          {
            type: "text",
            text: `Descreva esta imagem ("${file.name}") em português, de forma objetiva, para que ela possa ser encontrada depois por busca. Transcreva qualquer texto visível. Máximo de 200 palavras.`,
          },
        ],
      },
    ],
  });
  if (res.stop_reason === "refusal") return null;
  return textOf(res.content) || null;
}

/** Resume um arquivo longo em poucas linhas. */
export async function summarizeText(env: Env, name: string, text: string): Promise<string | null> {
  const res = await getClaude(env).messages.create({
    model: env.CLAUDE_MODEL,
    max_tokens: 4000,
    output_config: { effort: "low" },
    messages: [
      {
        role: "user",
        content: `<arquivo nome="${name}">\n${text.slice(0, 200_000)}\n</arquivo>\n\nResuma o conteúdo deste arquivo em português em até 120 palavras: do que se trata, pontos principais e para que ele serve.`,
      },
    ],
  });
  if (res.stop_reason === "refusal") return null;
  return textOf(res.content) || null;
}

export interface Insights {
  title: string;
  memories: { content: string; category: string; importance: number }[];
  profile: string;
}

const INSIGHTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "memories", "profile"],
  properties: {
    title: { type: "string", description: "Título curto (até 6 palavras) para a conversa; vazio se não for necessário." },
    memories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["content", "category", "importance"],
        properties: {
          content: { type: "string" },
          category: { type: "string", enum: ["fato", "preferencia", "raciocinio", "objetivo", "projeto", "pessoa"] },
          importance: { type: "integer", enum: [1, 2, 3, 4, 5] },
        },
      },
    },
    profile: { type: "string", description: "Perfil atualizado completo, ou string vazia se nada mudou." },
  },
} as const;

/**
 * Analisa a última troca de mensagens e extrai memórias duradouras e padrões de
 * raciocínio, além de atualizar o perfil consolidado do usuário.
 */
export async function extractInsights(
  env: Env,
  args: { profile: string; userText: string; assistantText: string; needsTitle: boolean; existing: string[] },
): Promise<Insights | null> {
  const prompt = `Você mantém a memória de longo prazo de um assistente pessoal. Analise a troca abaixo entre o usuário e o assistente.

<perfil_atual>
${args.profile || "(vazio)"}
</perfil_atual>

<memorias_relacionadas_ja_salvas>
${args.existing.map((m) => `- ${m}`).join("\n") || "(nenhuma)"}
</memorias_relacionadas_ja_salvas>

<mensagem_do_usuario>
${args.userText}
</mensagem_do_usuario>

<resposta_do_assistente>
${args.assistantText.slice(0, 20_000)}
</resposta_do_assistente>

Tarefas:
1. "memories": extraia apenas informações NOVAS e duradouras sobre o USUÁRIO que valham ser lembradas em conversas futuras: fatos da vida dele, preferências, pessoas, projetos, objetivos e, principalmente, a forma como ele raciocina e toma decisões (categoria "raciocinio"). Cada memória deve ser uma frase autocontida em português, na terceira pessoa ("O usuário..."). Não repita memórias já salvas. Não salve o conteúdo genérico da resposta do assistente. Se não houver nada novo, retorne lista vazia.
2. "profile": se esta troca revelar algo relevante, reescreva o perfil completo (até 300 palavras) incorporando o novo; caso contrário, retorne string vazia.
3. "title": ${args.needsTitle ? "crie um título curto para esta conversa." : "retorne string vazia."}`;

  const res = await getClaude(env).messages.create({
    model: env.CLAUDE_MODEL,
    max_tokens: 8000,
    output_config: { effort: "low", format: { type: "json_schema", schema: INSIGHTS_SCHEMA } },
    messages: [{ role: "user", content: prompt }],
  });
  if (res.stop_reason !== "end_turn") return null;
  try {
    return JSON.parse(textOf(res.content)) as Insights;
  } catch {
    return null;
  }
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
