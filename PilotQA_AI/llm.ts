import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage } from "@langchain/core/messages";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { estimateTokens } from "./utils";

// Prefer environment files inside PilotQA_AI/env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envDir = path.resolve(__dirname, "./env");

// Selection priority:
// 1) PILOTQA_ENV_FILE (explicit path)
// 2) PILOTQA_ENV (e.g., "basic") -> PilotQA_AI/env/.env_pilotqa_<value>
// 3) PilotQA_AI/env/.env
// 4) Fallback to default (project root .env)
const explicitEnv = process.env.PILOTQA_ENV_FILE;
if (explicitEnv) {
  dotenv.config({ path: path.resolve(explicitEnv) });
} else {
  const candidates: string[] = [];
  if (process.env.PILOTQA_ENV) {
    candidates.push(path.join(envDir, `.env_pilotqa_${process.env.PILOTQA_ENV}`));
  }
  // Preferred common file name used by the team
  candidates.push(path.join(envDir, ".env_pilotqa"));
  // Generic and variant fallbacks
  candidates.push(path.join(envDir, ".env"));
  candidates.push(path.join(envDir, ".env_pilotqa_basic"));

  let loaded = false;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p });
      loaded = true;
      break;
    }
  }
  if (!loaded) {
    dotenv.config();
  }
}

type LLMProvider = "gemini" | "openai" | "anthropic";

interface LLMConfig {
  provider: LLMProvider;
  model: string;
}

const ENV_KEYS: Record<LLMProvider, string> = {
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

const hasKeyFor = (provider: LLMProvider) => !!process.env[ENV_KEYS[provider]];

function availableLLMs(): LLMConfig[] {
  const configs: LLMConfig[] = [];
  if (hasKeyFor("gemini")) {
    configs.push(
      { provider: "gemini", model: "gemini-2.5-flash" },
      { provider: "gemini", model: "gemini-2.0-flash" },
      { provider: "gemini", model: "gemini-1.5-flash" },
    );
  }
  if (hasKeyFor("openai")) {
    configs.push({ provider: "openai", model: "gpt-4o-mini" });
  }
  if (hasKeyFor("anthropic")) {
    configs.push({ provider: "anthropic", model: "claude-3-haiku-20240307" });
  }
  return configs;
}

export async function invokeLLMWithFallback(messages: HumanMessage[]) {
  const content = messages[0]?.content?.toString() || "";
  const models = availableLLMs();
  let lastError: any = null;
  for (const cfg of models) {
    if (!hasKeyFor(cfg.provider)) {
      console.log(`Skipping ${cfg.provider}: missing API key`);
      continue;
    }
    try {
      let instance: any;
      if (cfg.provider === "gemini") {
        instance = new ChatGoogleGenerativeAI({
          model: cfg.model,
          apiKey: process.env.GEMINI_API_KEY!,
          temperature: 0.1,
        });
      } else if (cfg.provider === "openai") {
        const { ChatOpenAI } = await import("@langchain/openai");
        instance = new ChatOpenAI({
          model: cfg.model,
          apiKey: process.env.OPENAI_API_KEY!,
          temperature: 0.1,
        });
      } else if (cfg.provider === "anthropic") {
        const { ChatAnthropic } = await import("@langchain/anthropic");
        instance = new ChatAnthropic({
          model: cfg.model,
          apiKey: process.env.ANTHROPIC_API_KEY!,
          temperature: 0.1,
        });
      }

      console.log(`🤖 Trying to use ${cfg.model}...`);
      const t0 = Date.now();
      const response = await instance.invoke(messages);
      const ms = Date.now() - t0;
      const raw = response.content?.toString() ?? "";
      console.log(
        `📊 ${cfg.model} tokens ~ in:${estimateTokens(content)} out:${estimateTokens(raw)}`,
      );
      console.log(`✅ Successfully used ${cfg.model} (${ms}ms)`);
      return {
        response,
        modelName: cfg.model,
        durationMs: ms,
        inputTokens: estimateTokens(content),
        outputTokens: estimateTokens(raw),
      };
    } catch (e: any) {
      console.error(`❌ Error with ${cfg.model}: ${e.message}`);
      lastError = e;
    }
  }
  throw new Error(`All LLM models failed. Last error: ${lastError?.message}`);
}
