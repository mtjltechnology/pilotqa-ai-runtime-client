export interface Plan {
  executionsPerMonth: number | "unlimited";
  features: {
    history: boolean;
    reports: boolean;
  };
}

export async function executionsThisMonth(
  token: string,
): Promise<{ plan: Plan; usage: number }> {
  return {
    plan: {
      executionsPerMonth: "unlimited",
      features: { history: true, reports: true },
    },
    usage: 0,
  };
}

export async function logExecution(_token: string): Promise<void> {
  // Placeholder for logging execution to usage metrics
}
