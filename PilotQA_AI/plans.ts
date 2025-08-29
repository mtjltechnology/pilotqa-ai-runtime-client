export enum PlanType {
  FREE = "FREE",
  PRO = "PRO",
  TEAM = "TEAM",
  ENTERPRISE = "ENTERPRISE",
}

export interface PlanFeatures {
  executionsPerMonth: number | "unlimited";
  history: "none" | "local" | "dashboard";
  reports: "none" | "basic" | "advanced" | "custom";
  collaboration: "none" | "single" | "multi" | "enterprise";
}

export const PLAN_CONFIG: Record<PlanType, PlanFeatures> = {
  [PlanType.FREE]: {
    executionsPerMonth: 10,
    history: "none",
    reports: "none",
    collaboration: "none",
  },
  [PlanType.PRO]: {
    executionsPerMonth: 100,
    history: "local",
    reports: "basic",
    collaboration: "single",
  },
  [PlanType.TEAM]: {
    executionsPerMonth: 1000,
    history: "dashboard",
    reports: "advanced",
    collaboration: "multi",
  },
  [PlanType.ENTERPRISE]: {
    executionsPerMonth: "unlimited",
    history: "dashboard",
    reports: "custom",
    collaboration: "enterprise",
  },
};
