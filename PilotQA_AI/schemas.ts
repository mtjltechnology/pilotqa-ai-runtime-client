import { z } from "zod";
import { RawLLMAction } from "./types";

const ActionSchemaBase = z
  .object({
    action: z.string().min(1),
    selector: z.string().trim().min(1).optional(),
    selectorType: z.enum(["css", "xpath", "text", "none"]).optional(),
    timeout: z.number().int().positive().optional(),
    duration: z.number().int().positive().optional(),
    text: z.string().optional(),
    expectedContent: z.string().optional(),
    reason: z.string().optional(),
    url: z.string().url().optional(),
    pattern: z.string().optional(),
  })
  .strict();

type ActionBase = z.infer<typeof ActionSchemaBase>;

function coerceSelectorType(a: ActionBase): RawLLMAction {
  const out: RawLLMAction = { action: a.action!, ...a };

  if (!out.selectorType) {
    const s = out.selector || "";
    if (/^(?:xpath=|\/\/)/.test(s)) out.selectorType = "xpath";
    else if (/^(?:\.|#|\[|:)/.test(s)) out.selectorType = "css";
    else if (!s) out.selectorType = "none";
    else out.selectorType = "text";
  }
  return out;
}

export const ActionSchema = ActionSchemaBase.transform(coerceSelectorType);
export const ActionsSchema = z.array(ActionSchema);
