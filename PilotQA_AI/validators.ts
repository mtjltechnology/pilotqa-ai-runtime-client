import { ActionValidator } from "./types";

export const actionValidators: ActionValidator[] = [
  (act) => {
    const noSelector = [
      "wait",
      "reload",
      "clearCache",
      "waitForNavigation",
      "waitForURL",
    ];
    if (!noSelector.includes(act.action) && !act.selector) {
      throw new Error(`Action "${act.action}" missing selector`);
    }
  },
  (act) => {
    if (
      act.action === "wait" &&
      (act.duration === undefined || act.duration <= 0)
    ) {
      act.duration = 1;
    }
  },
  (act) => {
    if (act.action === "type" && (!act.text || act.text.trim() === "")) {
      throw new Error(
        `Action "type" missing text for selector "${act.selector || ""}"`,
      );
    }
  },
];

export const registerActionValidator = (fn: ActionValidator) =>
  actionValidators.push(fn);
