import { Page, expect, Locator } from "@playwright/test";
import { HumanMessage } from "@langchain/core/messages";
import { RawLLMAction, PilotQAAIAction } from "./types";
import { ActionSchema, ActionsSchema } from "./schemas";
import {
  actionNormalizers,
  registerActionNormalizer,
} from "./normalizers";
import {
  actionValidators,
  registerActionValidator,
} from "./validators";
import {
  actionMappers,
  registerActionMapper,
} from "./mappers";
import { cache, clearPilotQA_AI_Cache } from "./cache";
import {
  estimateTokens,
  escapeHtml,
  clamp,
  escapeRegExp,
  extractJsonArray,
} from "./utils";
import { invokeLLMWithFallback } from "./llm";
import {
  detectNavigationChange,
  getOptimizedHTML,
  tryExecuteWaitCommand,
} from "./navigation";
import { validateToken, executionsThisMonth, logExecution } from "./security";
import { requestToken } from "./security/token-client";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Local tokenless usage tracker (allows limited runs without a token)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOKENLESS_STORE = path.resolve(__dirname, "./security/tokenless-usage.json");

// Console banner helper (no external deps, ANSI colors only)
function printBanner(
  lines: string[],
  level: "warn" | "error" = "warn",
): void {
  const maxLen = Math.min(100, Math.max(...lines.map((l) => l.length)));
  const pad = (s: string) => ` ${s}${" ".repeat(Math.max(0, maxLen - s.length))} `;
  const top = "┏" + "━".repeat(maxLen + 2) + "┓";
  const mid = lines.map((l) => `┃${pad(l)}┃`);
  const bot = "┗" + "━".repeat(maxLen + 2) + "┛";
  const reset = "\x1b[0m";
  const bold = "\x1b[1m";
  const color = level === "error" ? "\x1b[31m" : "\x1b[33m"; // red | yellow
  const emitter = level === "error" ? console.error : console.warn;
  emitter("\n" + color + bold + top + reset);
  for (const m of mid) emitter(color + bold + m + reset);
  emitter(color + bold + bot + reset + "\n");
}

function todayLocalKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function readTokenlessCountToday(): number {
  const today = todayLocalKey();
  try {
    if (fs.existsSync(TOKENLESS_STORE)) {
      const raw = fs.readFileSync(TOKENLESS_STORE, "utf-8");
      const data = JSON.parse(raw);
      if (data && data.date === today && Number.isFinite(Number(data.count))) {
        return Number(data.count);
      }
    }
  } catch {}
  return 0;
}

function incrementTokenlessCountToday(): number {
  const today = todayLocalKey();
  const current = readTokenlessCountToday();
  const next = current + 1;
  try {
    fs.writeFileSync(
      TOKENLESS_STORE,
      JSON.stringify({ date: today, count: next }),
    );
  } catch {}
  return next;
}

async function highlightElement(
  page: Page,
  locator: Locator | null | undefined,
  action: string,
) {
  if (!locator || action === "assertNotVisible") return;
  try {
    if (!(await locator.isVisible())) return;
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) return;
    await page.addStyleTag({
      content: `#__pilotQA_overlay { position: fixed; z-index: 2147483647; pointer-events: none; border: 3px solid red; background: rgba(255,0,0,.1); border-radius: 4px; transition: all .15s ease; }`,
    });
    await page.evaluate((b) => {
      let el = document.getElementById(
        "__pilotQA_overlay",
      ) as HTMLDivElement | null;
      if (!el) {
        el = document.createElement("div");
        el.id = "__pilotQA_overlay";
        document.body.appendChild(el);
      }
      el.style.left = `${b.x}px`;
      el.style.top = `${b.y}px`;
      el.style.width = `${b.width}px`;
      el.style.height = `${b.height}px`;
      setTimeout(() => {
        el && el.remove();
      }, 1000);
    }, box);
    await page.waitForTimeout(120);
  } catch {}
}

/** ================= Text normalization ================= */
function normalizeAssertionPhrases(raw: string): string {
  return raw
    .replace(/should\s+be\s+visible/gi, "are visible")
    .replace(/must\s+be\s+visible/gi, "are visible")
    .replace(/\bis\s+visible\b/gi, "is visible")
    .replace(/should\s+not\s+be\s+visible/gi, "are not visible")
    .replace(/must\s+not\s+be\s+visible/gi, "are not visible")
    .replace(/\bis\s+not\s+visible\b/gi, "is not visible")
    .replace(/\bshould\s+be\s+displayed\b/gi, "are visible")
    .replace(/\bshould\s+not\s+be\s+displayed\b/gi, "are not visible")
    .replace(/\b(displayed|appearing)\b/gi, "visible")
    .replace(/\bhidden\b/gi, "not visible");
}

const VAGUE_ENDING_PATTERNS: RegExp[] = [
  /check if (the )?page (is )?(being )?displayed( correctly)?/i,
  /verify (that )?(the )?page (is )?(being )?displayed( correctly)?/i,
  /ensure (the )?page (is )?displayed( correctly)?/i,
  /verify (that )?everything looks (good|correct)/i,
  /check (the )?page( is (ok|correct))?/i,
  /verify page/i,
  /confirm (you|we) are on (the )?(right|correct) page/i,
  /verify product (page|details) (is )?displayed/i,
];

function stripVague(command: string): string {
  if (!command) return "";
  let out = command.trim();
  // remove vague phrases at the end
  for (const rx of VAGUE_ENDING_PATTERNS) {
    out = out.replace(new RegExp(`${rx.source}[\\s"'.!,;:]*$`, "i"), "").trim();
  }
  // normalize stray quotes/punctuation
  out = out.replace(/["']{2,}/g, '"').replace(/^[\s"'.,;:]+$/, "");
  return out;
}

// Verbs and adjectives for visibility/synonyms
const VISIBILITY_VERBS = ["check", "verify", "ensure", "confirm", "assert"];
const VISIBILITY_STATES = [
  "visible",
  "displayed",
  "being displayed",
  "shown",
  "present",
];
// Remove mentions to a selector in phrases like "check/verify ... are visible/displayed"
function removeVisibilityMention(command: string, selector: string): string {
  if (!command || !selector) return command;
  let out = command;

  // 1) Remove direct mention of the item within lists (with/without quotes)
  const sel = selector.trim();
  const qSel = `["']?${escapeRegExp(sel)}["']?`;
  // remove "Sauce Labs Fleece Jacket" from list
  out = out.replace(
    new RegExp(
      `\\s*(?:,\\s*|\\s+and\\s+)?${qSel}(?=\\s*(?:,|and|\\)|\\.|;|$))`,
      "i",
    ),
    "",
  );

  // 2) Remove phrases like "<selector> is/are visible/displayed"
  const stateGroup = VISIBILITY_STATES.map(escapeRegExp).join("|");
  out = out.replace(
    new RegExp(
      `${qSel}\\s+(?:is|are)\\s+(?:${stateGroup})(?=[\\s"'.!,;:)]|$)`,
      "i",
    ),
    "",
  );

  // 3) Remove full phrases like "check/verify ... <selector> ... is/are visible"
  const verbGroup = VISIBILITY_VERBS.map(escapeRegExp).join("|");
  out = out.replace(
    new RegExp(
      `\\b(?:${verbGroup})\\s+(?:that\\s+|if\\s+)?(?:the\\s+)?(?:text\\s+)?${qSel}\\s+(?:is|are)\\s+(?:${stateGroup})\\s*[."')!;,]*`,
      "i",
    ),
    "",
  );

  // 4) If only the tail "check/verify ... are visible" remains without items, remove the end
  const tail = new RegExp(
    `\\b(?:${verbGroup})\\s+(?:that\\s+|if\\s+)?(?:the\\s+)?(?:text\\s+)?([A-Za-z0-9 "'_\\-,]*)\\s+(?:is|are)\\s+(?:${stateGroup})\\s*$`,
    "i",
  );
  const m = out.match(tail);
  if (m) {
    const list = (m[1] || "")
      .replace(/["',.\s]/g, "")
      .replace(/\b(and|or)\b/gi, "")
      .trim();
    if (!list) out = out.replace(tail, "").trim();
  }

  // cleanup leftover connectors and punctuation
  out = out
    .replace(/\s*(,|\band\b)\s*(,|\band\b)\s*/gi, " $2 ")
    .replace(/\s*,\s*,/g, ",")
    .replace(/\s{2,}/g, " ")
    .replace(/^\s*[.,;:]+\s*|\s*[.,;:]+\s*$/g, "")
    .trim();

  return out;
}

// Consume only the first clause, but try to remove assert/visible mentions
function consumeProcessed(command: string, action: PilotQAAIAction): string {
  if (!command) return "";

  // Special case: visibility asserts with textual selector → remove mention
  if (
    (action.action === "assertVisible" ||
      action.action === "assertNotVisible") &&
    action.selectorType === "text" &&
    action.selector
  ) {
    const after = removeVisibilityMention(command, action.selector);
    if (after !== command) return after;
  }

  // fallback: consume until next delimiter (; . , then and \n)
  const m = /(;|\n|\.|,|\bthen\b|\band\b)/i.exec(command);
  if (!m || m.index === undefined) return "";
  let rest = command.slice(m.index + m[0].length).trimStart();

  // light normalization of quotes and stray punctuation
  rest = rest
    .replace(/"{2,}/g, '"')
    .replace(/'{2,}/g, "'")
    .replace(/^[\s"'.,;:]+/, "")
    .trim();
  return rest;
}

/** ================= Input locator helpers ================= */
const buildInputLocator = (page: Page, fieldName: string) => {
  const fn = fieldName.trim();
  const slug = fn.replace(/\s+/g, "").toLowerCase();
  const candidates: Locator[] = [];

  candidates.push(page.getByPlaceholder(fn).first()); // placeholder
  candidates.push(page.getByLabel(fn, { exact: false })); // label
  candidates.push(page.getByRole("textbox", { name: new RegExp(fn, "i") })); // role textbox
  candidates.push(page.locator(`[data-testid*="${slug}"]`)); // data-testid
  candidates.push(page.locator(`[name*="${fn}"], [id*="${fn}"]`)); // name/id
  candidates.push(
    page
      .getByText(fn, { exact: false })
      .locator("xpath=following::input[1] | xpath=following::textarea[1]"),
  ); // near text
  candidates.push(
    page
      .locator(`[contenteditable="true"]`)
      .filter({ hasText: new RegExp(fn, "i") }),
  ); // contenteditable

  return {
    async firstVisible(): Promise<Locator> {
      for (const loc of candidates) {
        try {
          const count = await loc.count();
          for (let i = 0; i < Math.min(count, 5); i++) {
            const cand = loc.nth(i);
            if (await cand.isVisible()) return cand;
          }
        } catch {}
      }
      return candidates[0];
    },
  };
};

async function resolveTextToInputLocator(
  page: Page,
  text: string,
): Promise<Locator> {
  const byPlaceholder = page.getByPlaceholder(text).first();
  if (await byPlaceholder.count().then((c) => c > 0)) return byPlaceholder;
  return await buildInputLocator(page, text).firstVisible();
}

/** ================= Pick-first helper & Locator resolution ================= */
async function pickFirstExisting(cands: Locator[]): Promise<Locator | null> {
  for (const loc of cands) {
    try {
      if (await loc.count().then((c) => c > 0)) return loc.first();
    } catch {}
  }
  return null;
}

async function resolveLocator(
  page: Page,
  action: PilotQAAIAction,
): Promise<Locator | null> {
  if (action.selectorType === "none") return null;

  const s = (action.selector || "").trim();
  const sAttr = s.replace(/"/g, '\\"');
  const nameRe = s ? new RegExp(`\\s*${escapeRegExp(s)}\\s*`, "i") : undefined;

  const makeIn = (p: Page | any): Promise<Locator | null> =>
    (async () => {
      switch (action.selectorType) {
        case "css":
          return p.locator(action.selector!);

        case "xpath":
          return p.locator(`xpath=${action.selector}`);

        case "text": {
          if (!s) return null;
          if (action.action === "type") {
            return resolveTextToInputLocator(p, s);
          }

          const cands: Locator[] = [];

          // 1) Prefer ARIA roles with accessible name
          if (nameRe) {
            cands.push(p.getByRole("button", { name: nameRe }));
            cands.push(p.getByRole("link", { name: nameRe }));
            cands.push(p.getByRole("heading", { name: nameRe }));
            cands.push(p.getByRole("checkbox", { name: nameRe }));
            cands.push(p.getByRole("radio", { name: nameRe }));
            cands.push(p.getByRole("textbox", { name: nameRe }));
          }

          // 2) Label/placeholder/alt/title/aria-label/data-test(id)
          cands.push(p.getByLabel(s, { exact: false }));
          cands.push(p.getByPlaceholder(s).first());
          cands.push(
            p.locator(
              `img[alt*="${sAttr}"], [aria-label*="${sAttr}"], [title*="${sAttr}"]`,
            ),
          );
          cands.push(
            p.locator(`[data-testid*="${sAttr}"], [data-test*="${sAttr}"]`),
          );
          cands.push(p.locator(`[id*="${sAttr}"], [name*="${sAttr}"]`));

          // 3) Visible text containers
          cands.push(p.getByText(s, { exact: false }));
          cands.push(p.locator(`:has-text("${sAttr}")`));

          // 4) If clicking/toggling, prefer nearest clickable ancestor
          if (action.action === "click" || action.action === "toggle") {
            cands.push(
              p
                .getByText(s, { exact: false })
                .locator(
                  `xpath=ancestor::*[self::button or self::a or @role="button" or @onclick][1]`,
                ),
            );
          }

          // 5) Hints for common generic terms
          const lower = s.toLowerCase();
          if (/\b(image|picture|photo|img)\b/i.test(lower)) {
            cands.push(p.locator("img:visible").first());
          }
          if (/\bprice\b/i.test(lower)) {
            // Generic price hints (currency symbol)
            cands.push(p.getByText(/\$\s?\d[\d.,]*/));
            cands.push(p.locator(`:has-text("$")`).first());
          }

          const pick = await pickFirstExisting(cands);
          return pick ?? null;
        }

        default:
          throw new Error("Unknown selector type: " + action.selectorType);
      }
    })();

  // Try main frame first
  try {
    const loc = await makeIn(page);
    if (loc && (await loc.count().then((c) => c > 0))) return loc.first();
  } catch {}

  // Scan iframes
  for (const f of page.frames()) {
    try {
      const loc = await makeIn(f);
      if (loc && (await loc.count().then((c) => c > 0))) return loc.first();
    } catch {}
  }

  // No site-specific fallbacks (keep engine generic)
  return null;
}

/** ================= Per-action retries ================= */
async function withRetries<T>(
  fn: () => Promise<T>,
  attempts = 2,
  baseDelayMs = 500,
): Promise<T> {
  let last: any;
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
  throw last;
}

/** ================= Public API ================= */
interface PilotQA_AI_LLMTranscript {
  order: number;
  model: string;
  prompt: string;
  responseRaw: string;
  durationMs: number;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
}

export async function PilotQA_AI(
  page: Page,
  command: string,
  maxRetries: number = 3,
  containerSelector?: string,
  useCache: boolean = true,
  options?: {
    testInfo?: any;
    waitForVisibleBeforeClick?: boolean;
    safeClearCookies?: boolean;
    softAssertNoLocator?: boolean;
    authToken?: string;
  },
): Promise<void> {
  // Lê o token do .env se não foi fornecido nas opções
  let token = options?.authToken || process.env.PILOTQA_AUTH_TOKEN;
  let tokenValidated = false;
  let runningTokenless = false;

  if (token) {
    const valid = await validateToken(token);
    tokenValidated = !!valid;
  }

  if (!token || !tokenValidated) {
    // Allow up to 5 runs per day without a token
    const dailyLimit = 5;
    const usedToday = readTokenlessCountToday();
    if (usedToday < dailyLimit) {
      const next = incrementTokenlessCountToday();
      runningTokenless = true;
      printBanner(
        [
          "PilotQA AI – Free Plan Notice",
          `Running in Demo mode: ${next}/${dailyLimit} free runs used today`,
          "Subscribe to Pro or Enterprise for higher limits.",
        ],
        "warn",
      );
    } else {
      // As a courtesy, try requesting a token if configured
      try {
        token = await requestToken('user123', 'basic');
        const valid = await validateToken(token);
        tokenValidated = !!valid;
      } catch {}
      if (!tokenValidated) {
        printBanner(
          [
            "PilotQA AI – Free Plan Limit Reached",
            "Daily Demo mode limit reached (5/5).",
            "Subscribe to Pro or Enterprise for more runs.",
          ],
          "error",
        );
        throw new Error(
          "Free plan daily limit reached. Subscribe to Pro or Enterprise.",
        );
      }
    }
  }

  // Default features if running tokenless
  let plan: { executionsPerMonth: number | "unlimited"; features: { history: boolean; reports: boolean } } = {
    executionsPerMonth: "unlimited",
    features: { history: true, reports: true },
  };
  if (!runningTokenless) {
    const res = await executionsThisMonth(token!);
    plan = res.plan;
    const usage = res.usage;
    if (
      plan.executionsPerMonth !== "unlimited" &&
      usage >= plan.executionsPerMonth
    )
      throw new Error("Monthly execution limit reached");
  }
  interface PilotQA_AI_StepLog {
    order: number;
    action: string;
    selector?: string;
    selectorType?: string;
    text?: string;
    status: "passed" | "failed" | "skipped";
    error?: string;
    timestamp: string;
  }
  const stepLogs: PilotQA_AI_StepLog[] = [];
  let stepCounter = 0;
  const logStep = (p: Omit<PilotQA_AI_StepLog, "order" | "timestamp">) =>
    stepLogs.push({
      order: ++stepCounter,
      timestamp: new Date().toISOString(),
      ...p,
    });

  const transcripts: PilotQA_AI_LLMTranscript[] = [];

  console.log(
    "🤖 PilotQA AI is interacting with the browser for multi-page flow...",
  );
  let remainingCommand = normalizeAssertionPhrases(command.trim());
  let retryCount = 0;
  let lastError: Error | null = null;

  const navState = { currentPageUrl: page.url(), navigationCount: 0 };

  // ========== Pre-parse inline TYPEs ==========
  type PreParsedTypeAction = {
    action: "type";
    selector: string;
    selectorType: "text";
    text: string;
    originalSnippet: string;
  };
  const preParsedTypeActions: PreParsedTypeAction[] = [];
  const inlineTypeRegexes: RegExp[] = [
    /(?:type|enter|fill)\s+"([^"]+)"\s+(?:in|into|inside|on|to)\s+(?:the\s+)?(?:field\s+)?["']?([A-Za-z0-9 _\-]+)["']?/gi,
    /set\s+(?:the\s+)?([A-Za-z0-9 _\-]+)\s+(?:field\s+)?to\s+"([^"]+)"/gi,
    /fill\s+(?:the\s+)?([A-Za-z0-9 _\-]+)\s+(?:field\s+)?with\s+"?([^",]+?)"?(\s|,|$)/gi,
  ];
  for (const rgx of inlineTypeRegexes) {
    let m: RegExpExecArray | null;
    while ((m = rgx.exec(remainingCommand)) !== null) {
      let textValue: string, fieldName: string;
      if (
        m.length >= 3 &&
        (rgx === inlineTypeRegexes[0] || rgx === inlineTypeRegexes[2])
      ) {
        textValue = m[1].trim();
        fieldName = m[2].trim();
      } else {
        fieldName = m[1].trim();
        textValue = m[2].trim();
      }
      fieldName = fieldName
        .replace(/\s+input$/i, "")
        .replace(/\s+input\s+and$/i, "")
        .replace(/\s+and$/i, "")
        .trim();
      preParsedTypeActions.push({
        action: "type",
        selector: fieldName,
        selectorType: "text",
        text: textValue,
        originalSnippet: m[0],
      });
    }
  }
  const typedByParser = new Map<string, string>();
  for (const a of preParsedTypeActions)
    typedByParser.set(a.selector.toLowerCase(), a.text);

  // ========== Main loop ==========
  while (remainingCommand.length > 0 && retryCount < maxRetries) {
    // Clean vague phrases before calling the LLM
    remainingCommand = stripVague(remainingCommand);
    if (!remainingCommand) {
      console.log("✅ Remaining command empty or only vague checks. Ending.");
      break;
    }

    try {
      // Natural wait/reload/cache
      if (await tryExecuteWaitCommand(page, remainingCommand, useCache)) {
        remainingCommand = remainingCommand
          .replace(
            /(clear\s+(the\s+)?cache|cache\s+clear|clear\s+browser\s+cache|flush\s+cache)/gi,
            "",
          )
          .replace(/(reload|refresh)\s+(the\s+)?page/gi, "")
          .replace(/(wait|pause|sleep)\s+(for\s+)?\d+\s+seconds?/gi, "")
          .replace(/wait\s+\d+s/gi, "")
          .trim();
      }

      // Execute ALL inline TYPEs before LLM
      while (preParsedTypeActions.length > 0) {
        const a = preParsedTypeActions.shift()!;
        console.log(
          `✍️ Executing pre-parsed inline type: "${a.text}" into "${a.selector}"`,
        );
        const target = await resolveTextToInputLocator(page, a.selector);
        await withRetries(() => target.fill(a.text), 1);
        logStep({
          action: "type",
          selector: a.selector,
          selectorType: a.selectorType,
          text: a.text,
          status: "passed",
        });
        remainingCommand = remainingCommand
          .replace(a.originalSnippet, "")
          .trim();
      }

      // Navigation + HTML
      await detectNavigationChange(page, navState, useCache);
      const htmlContent = await getOptimizedHTML(
        page,
        containerSelector,
        useCache,
      );

      // Prompt (strict JSON, prefer stable selectors)
      const prompt =
        `You are a QA assistant that receives a natural-language user command and the ${containerSelector ? "container" : "page"} HTML.
      Return ONLY a JSON array of actions (no prose). Prefer stable selectors (ids, data-test, CSS) over plain text. Avoid relying solely on visible text when a stable selector exists.
      
      ACTIONS (required fields):
      - Clear cache: { "action":"clearCache", "selectorType":"none" }
      - Reload page: { "action":"reload", "selectorType":"none" }
      - Wait:        { "action":"wait", "duration":2, "selectorType":"none" }
      - Wait visible/hidden:
        { "action":"waitForVisible", "selector":"<text|css|xpath>", "selectorType":"text"|"css"|"xpath", "timeout":10 }
        { "action":"waitForHidden",  "selector":"<text|css|xpath>", "selectorType":"text"|"css"|"xpath", "timeout":10 }
      - Type (fill inputs):
        { "action":"type", "selector":"<label|placeholder|css|xpath>", "selectorType":"text"|"css"|"xpath", "text":"<exact value>" }
        For selectorType:"text", interpret the selector as label/placeholder and target the actual <input>/<textarea>.
      - Click/Toggle:
        { "action":"click", "selector":"<text|css|xpath>", "selectorType":"text"|"css"|"xpath" }
      - Assertions:
        { "action":"assertVisible",    "selector":"<text|css|xpath>", "selectorType":"text"|"css"|"xpath" }
        { "action":"assertNotVisible", "selector":"<text|css|xpath>", "selectorType":"text"|"css"|"xpath" }
      
      Remaining Command:
      "${remainingCommand}"
      
      HTML:
      ${htmlContent}`.trim();

      const { response, modelName, durationMs, inputTokens, outputTokens } =
        await invokeLLMWithFallback([new HumanMessage({ content: prompt })]);
      const jsonResponseRaw = response.content?.toString() ?? "";
      const jsonResponse = extractJsonArray(
        jsonResponseRaw
          .replace(/```(?:json)?/gi, "")
          .replace(/```/g, "")
          .trim(),
      );
      transcripts.push({
        order: transcripts.length + 1,
        model: modelName,
        prompt,
        responseRaw: jsonResponseRaw,
        durationMs,
        timestamp: new Date().toISOString(),
        inputTokens,
        outputTokens,
      });

      // Parse + validate with Zod
      let parsedLLMActions: RawLLMAction[];
      try {
        const arr = JSON.parse(jsonResponse);
        const safe = ActionsSchema.safeParse(arr);
        if (!safe.success) throw new Error(safe.error.message);
        parsedLLMActions = safe.data as RawLLMAction[];
      } catch (e: any) {
        throw new Error(
          "LLM output is not a valid JSON actions array: " + e.message,
        );
      }

      // Inject pre-parser text if missing
      parsedLLMActions = parsedLLMActions.map((a) => {
        if (a.action === "type" && (!a.text || !a.text.trim()) && a.selector) {
          const key = a.selector.toLowerCase();
          if (typedByParser.has(key))
            return { ...a, text: typedByParser.get(key)! };
        }
        return a;
      });

      // Remove duplicates of type already executed by the parser
      parsedLLMActions = parsedLLMActions.filter(
        (a) =>
          !(
            a.action === "type" &&
            a.selector &&
            typedByParser.has(a.selector.toLowerCase())
          ),
      );

      // Discard 'type' without text
      parsedLLMActions = parsedLLMActions.filter(
        (a) => a.action !== "type" || !!a.text,
      );

      // Normalizers → Validators → Mappers
      const finalActions: PilotQAAIAction[] = [];
      for (const raw of parsedLLMActions) {
        let cur: RawLLMAction | null = { ...raw };
        for (const n of actionNormalizers) {
          if (!cur) break;
          cur = n(cur);
        }
        if (!cur) continue;
        for (const v of actionValidators) v(cur);
        let mapped: PilotQAAIAction | null = null;
        for (const m of actionMappers) {
          const c = m(cur);
          if (c) {
            mapped = c;
            break;
          }
        }
        if (mapped) finalActions.push(mapped);
      }
      if (!finalActions.length)
        throw new Error("No actions parsed from LLM response.");

      // Execute
      let navigationTriggered = false;
      for (const action of finalActions) {
        const locator = await resolveLocator(page, action);

        await highlightElement(page, locator, action.action);

        if (
          ["click", "toggle"].includes(action.action) &&
          locator &&
          (options?.waitForVisibleBeforeClick ?? true)
        ) {
          try {
            await locator.waitFor({ state: "visible", timeout: 5000 });
          } catch {}
        }

        switch (action.action) {
          case "clearCache": {
            await page.evaluate(() => {
              localStorage.clear();
              sessionStorage.clear();
            });
            if (!options?.safeClearCookies) {
              await page.context().clearCookies();
            }
            if (useCache) {
              cache.htmlContent = null;
              cache.htmlTimestamp = 0;
              cache.currentUrl = page.url();
              cache.llmResponse = null;
              cache.llmCommand = "";
            }
            await page.waitForTimeout(900);
            break;
          }
          case "reload": {
            await page.reload({ waitUntil: "domcontentloaded" });
            if (useCache) {
              cache.htmlContent = null;
              cache.htmlTimestamp = 0;
              cache.currentUrl = page.url();
              cache.llmResponse = null;
              cache.llmCommand = "";
            }
            await page.waitForTimeout(1500);
            break;
          }
          case "wait": {
            await page.waitForTimeout(clamp(action.duration, 1) * 1000);
            break;
          }
          case "waitForVisible": {
            if (!locator) throw new Error("waitForVisible needs a selector");
            const sel = action.selector || "";
            const isMap = /map|mapbox/i.test(sel);
            const isIframe = /iframe/i.test(sel);
            const timeout =
              Math.max(
                (action.timeout || 10) * 1000,
                isMap || isIframe ? 15000 : 0,
              ) || 10000;
            await withRetries(
              () => locator.waitFor({ state: "visible", timeout }),
              1,
            );
            break;
          }
          case "waitForHidden": {
            if (!locator) throw new Error("waitForHidden needs a selector");
            await withRetries(
              () =>
                locator.waitFor({
                  state: "hidden",
                  timeout: (action.timeout || 10) * 1000,
                }),
              1,
            );
            break;
          }
          case "type": {
            if (!locator)
              throw new Error("Locator is required for type action");
            if (!action.text) throw new Error("Missing text for typing");
            console.log(
              `⌨️ TYPE into "${action.selector}" (${action.selectorType}) => "${action.text}"`,
            );
            await withRetries(() => locator.fill(action.text!), 1);
            logStep({
              action: "type",
              selector: action.selector,
              selectorType: action.selectorType,
              text: action.text,
              status: "passed",
            });
            break;
          }
          case "click":
          case "toggle": {
            if (!locator)
              throw new Error("Locator is required for click/toggle");
            await withRetries(async () => {
              try {
                await locator.click();
              } catch {
                await locator.click({ force: true });
              }
            }, 2);
            logStep({
              action: action.action,
              selector: action.selector,
              selectorType: action.selectorType,
              status: "passed",
            });
            await page.waitForTimeout(700);
            const nav = await detectNavigationChange(page, navState, useCache);
            if (nav) navigationTriggered = true;
            break;
          }
          case "assertVisible": {
            if (!locator) {
              if (options?.softAssertNoLocator) {
                console.warn(
                  "[PilotQA AI] assertVisible without locator — soft fallback to domcontentloaded",
                );
                await page.waitForLoadState("domcontentloaded", {
                  timeout: 5000,
                });
                logStep({
                  action: "assertVisible",
                  selector: action.selector,
                  selectorType: action.selectorType,
                  status: "skipped",
                });
                break;
              }
              throw new Error("Locator is required for assertVisible");
            }
            const sel = action.selector || "";
            const isCanvas = /canvas|#canvas/i.test(sel);
            const isMap = /map|mapbox/i.test(sel);
            const isIframe = /iframe/i.test(sel);
            const timeout = isMap || isIframe ? 15000 : isCanvas ? 10000 : 8000;
            await locator.waitFor({ state: "visible", timeout });
            if (!(await locator.isVisible()))
              throw new Error(`Element not visible: ${action.selector}`);
            if (isMap) await page.waitForTimeout(2500);
            if (isCanvas) await page.waitForTimeout(1500);
            break;
          }
          case "assertNotVisible": {
            if (!locator)
              throw new Error("Locator is required for assertNotVisible");
            const isVisible = await locator.isVisible().catch(() => false);
            if (isVisible)
              throw new Error(
                `Element visible but should NOT be: ${action.selector}`,
              );
            break;
          }
          case "waitForNavigation": {
            await page.waitForNavigation({
              waitUntil: "load",
              timeout: action.timeout ?? 30000,
            });
            break;
          }
          case "waitForURL": {
            if (action.url)
              await page.waitForURL(action.url, {
                timeout: action.timeout ?? 30000,
              });
            else if (action.pattern)
              await page.waitForURL(new RegExp(action.pattern), {
                timeout: action.timeout ?? 30000,
              });
            else
              await page.waitForLoadState("load", {
                timeout: action.timeout ?? 30000,
              });
            break;
          }
          default: {
            throw new Error(
              `Unsupported action returned by LLM: ${action.action}`,
            );
          }
        }

        // best effort: remove parts of the command already fulfilled
        remainingCommand = consumeProcessed(remainingCommand, action);

        if (navigationTriggered) {
          console.log(
            "🔄 Navigation triggered — re-processing with the new page…",
          );
          break;
        }
      }

      // After navigation/step, strip again
      remainingCommand = stripVague(remainingCommand);
      if (!remainingCommand) {
        console.log("✅ Remaining command empty after vague-strip. Ending.");
        break;
      }

      if (remainingCommand.length === 0) {
        console.log("➡️ Multi-page flow completed successfully.");
        break;
      }
      retryCount = 0;
      lastError = null;
    } catch (error: any) {
      console.error(
        `❌ Error (attempt ${retryCount + 1}/${maxRetries}):`,
        error.message,
      );
      lastError = error;
      retryCount++;
      if (retryCount >= maxRetries)
        throw new Error(
          `Failed after ${maxRetries} attempts: ${lastError?.message}`,
        );
      await page.waitForTimeout(900);
    }
  }

  if (!runningTokenless && token) {
    await logExecution(token);
  }

  // Attach (optional)
  const totalIn = transcripts.reduce((a, t) => a + t.inputTokens, 0);
  const totalOut = transcripts.reduce((a, t) => a + t.outputTokens, 0);
  try {
    if (options?.testInfo) {
      if (plan.features.history) {
        await options.testInfo.attach("PilotQA_AI-steps.json", {
          body: Buffer.from(JSON.stringify(stepLogs, null, 2)),
          contentType: "application/json",
        });
        const stepsHtml = `<html><body><h3>PilotQA_AI Steps</h3><ol>${stepLogs.map((s) => `<li><b>${s.action}</b> ${s.selector || ""} - <span style="color:${s.status === "passed" ? "green" : "red"}">${s.status}</span>${s.error ? `<pre>${escapeHtml(s.error)}</pre>` : ""}</li>`).join("")}</ol></body></html>`;
        await options.testInfo.attach("PilotQA_AI-steps.html", {
          body: Buffer.from(stepsHtml),
          contentType: "text/html",
        });
        await options.testInfo.attach("PilotQA_AI-llm-transcript.json", {
          body: Buffer.from(JSON.stringify(transcripts, null, 2)),
          contentType: "application/json",
        });
      } else {
        console.warn("History feature not enabled for this plan");
      }

      if (plan.features.reports) {
        const metrics = {
          totalInputTokens: totalIn,
          totalOutputTokens: totalOut,
          transcripts: transcripts.map((t) => ({
            order: t.order,
            model: t.model,
            inputTokens: t.inputTokens,
            outputTokens: t.outputTokens,
            durationMs: t.durationMs,
          })),
        };
        await options.testInfo.attach("PilotQA_AI-llm-metrics.json", {
          body: Buffer.from(JSON.stringify(metrics, null, 2)),
          contentType: "application/json",
        });
      } else {
        console.warn("Reports feature not enabled for this plan");
      }
    }
  } catch (e: any) {
    console.warn("⚠️ Could not attach PilotQA AI logs:", e.message);
  }

  console.log(
    `✅ PilotQA AI execution finished. Pages navigated: ${navState.navigationCount + 1}.`,
  );
}

export {
  clearPilotQA_AI_Cache,
  registerActionNormalizer,
  registerActionValidator,
  registerActionMapper,
};
