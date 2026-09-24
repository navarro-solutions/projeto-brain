import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env";

export function getSupabase(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface Attachment {
  id: string;
  name: string;
  mime_type: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  attachments: Attachment[];
  created_at: string;
}

export interface FileRow {
  id: string;
  conversation_id: string | null;
  name: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  kind: FileKind;
  extracted_text: string | null;
  summary: string | null;
  created_at: string;
}

export type FileKind = "image" | "pdf" | "audio" | "text" | "document" | "other";
