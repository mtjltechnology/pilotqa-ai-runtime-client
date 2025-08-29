import { ActionNormalizer } from "./types";

export const actionNormalizers: ActionNormalizer[] = [
  (raw) => {
    const map: Record<string, string> = {
      press: "click",
      tap: "click",
      submit: "click",
      checkvisibility: "assertVisible",
      verifyvisible: "assertVisible",
      verifyinvisible: "assertNotVisible",
      hidecheck: "assertNotVisible",
      reloadpage: "reload",
      refresh: "reload",
      clearcache: "clearCache",
      waitvisible: "waitForVisible",
      waithidden: "waitForHidden",
    };
    const norm = raw.action?.toLowerCase().replace(/\s+/g, "");
    if (norm && map[norm]) raw.action = map[norm];
    return raw;
  },
  (raw) => {
    if (!raw.selectorType) {
      const noSelector = [
        "wait",
        "reload",
        "clearCache",
        "waitForNavigation",
        "waitForURL",
      ];
      raw.selectorType =
        !raw.selector || noSelector.includes(raw.action) ? "none" : "text";
    }
    return raw;
  },
];

export const registerActionNormalizer = (fn: ActionNormalizer) =>
  actionNormalizers.push(fn);
