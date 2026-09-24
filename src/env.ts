export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_BUCKET: string;
  APP_TOKEN: string;
  CLAUDE_MODEL: string;
}

export type AppContext = { Bindings: Env };
