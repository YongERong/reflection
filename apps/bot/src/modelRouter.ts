import type { ModelClient } from "@reflection/core";

export const comparisonModelNames = ["gpt-4o-mini", "gpt-5-mini"] as const;

export type ComparisonModelName = (typeof comparisonModelNames)[number];

export type ModelAssignment = {
  modelName: ComparisonModelName;
  source: "manual" | "default";
};

export type ModelRouter = {
  getPreference(telegramUserId: string): ModelAssignment;
  setPreference(telegramUserId: string, modelName: ComparisonModelName): ModelAssignment;
  assignReflection(reflectionId: string, telegramUserId: string): ModelAssignment;
  getReflectionAssignment(reflectionId: string): ModelAssignment | undefined;
  getClient(assignment: ModelAssignment): ModelClient | undefined;
};

export const defaultComparisonModel: ComparisonModelName = "gpt-4o-mini";

export function isComparisonModelName(value: string): value is ComparisonModelName {
  return comparisonModelNames.includes(value as ComparisonModelName);
}

export function createModelRouter(clients: Partial<Record<ComparisonModelName, ModelClient | undefined>>): ModelRouter {
  const preferences = new Map<string, ModelAssignment>();
  const reflectionAssignments = new Map<string, ModelAssignment>();

  const defaultAssignment = (): ModelAssignment => ({
    modelName: defaultComparisonModel,
    source: "default"
  });

  return {
    getPreference(telegramUserId) {
      return preferences.get(telegramUserId) ?? defaultAssignment();
    },
    setPreference(telegramUserId, modelName) {
      const assignment: ModelAssignment = { modelName, source: "manual" };
      preferences.set(telegramUserId, assignment);
      return assignment;
    },
    assignReflection(reflectionId, telegramUserId) {
      const existing = reflectionAssignments.get(reflectionId);
      if (existing) return existing;

      const assignment = this.getPreference(telegramUserId);
      reflectionAssignments.set(reflectionId, assignment);
      return assignment;
    },
    getReflectionAssignment(reflectionId) {
      return reflectionAssignments.get(reflectionId);
    },
    getClient(assignment) {
      return clients[assignment.modelName];
    }
  };
}
