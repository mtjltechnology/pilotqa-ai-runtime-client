export type SelectorType = "css" | "xpath" | "text" | "none";

export type RawLLMAction = {
  action: string;
  selector?: string | null;
  selectorType?: SelectorType;
  timeout?: number;
  duration?: number;
  text?: string;
  expectedContent?: string;
  reason?: string;
  url?: string;
  pattern?: string;
  [k: string]: any;
};

export interface PilotQAAIAction extends RawLLMAction {
  normalizedAction: string;
}

export type ActionNormalizer = (raw: RawLLMAction) => RawLLMAction | null;
export type ActionValidator = (act: RawLLMAction) => void;
export type ActionMapper = (raw: RawLLMAction) => PilotQAAIAction | null;
