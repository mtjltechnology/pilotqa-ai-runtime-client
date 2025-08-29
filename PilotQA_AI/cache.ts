export const cache = {
  htmlContent: null as string | null,
  htmlTimestamp: 0,
  llmResponse: null as any,
  llmCommand: "",
  currentUrl: "" as string,
  CACHE_DURATION: 5000,
};

export function clearPilotQA_AI_Cache() {
  cache.htmlContent = null;
  cache.htmlTimestamp = 0;
  cache.llmResponse = null;
  cache.llmCommand = "";
  cache.currentUrl = "";
  console.log("🧹 PilotQA AI cache cleared");
}
