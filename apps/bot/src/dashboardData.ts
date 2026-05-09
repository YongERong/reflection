import { createClient } from "@supabase/supabase-js";
import { defaultPromptConfig, gibbsStages, stageLabels } from "@reflection/core";
import { env } from "./env.js";

type RelationValue<T> = T | T[] | null;

type ReflectionRow = {
  id: string;
  current_stage: string;
  status: string;
  answers: Record<string, string> | null;
  teacher_visible: boolean | null;
  safety_flagged: boolean | null;
  created_at: string;
  updated_at: string;
  student_profiles: RelationValue<{
    display_name: string | null;
    classes: RelationValue<{ name: string | null }>;
  }>;
};

type SummaryRow = {
  reflection_id: string;
  brief_summary: string;
  actionables: string[] | null;
  key_learnings: string[] | null;
  created_at: string;
};

type SafetyConcernRow = {
  id: string;
  stage: string;
  status: string;
  reason: string;
  message_snippet: string;
  created_at: string;
  student_profiles: RelationValue<{ display_name: string | null }>;
};

type PromptConfigRow = {
  version: number;
  mood: string;
  starting_message_template: string;
  school_context: Record<string, unknown> | null;
};

function firstRelation<T>(value: RelationValue<T>): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function summarizeAnswers(answers: Record<string, string> | null, currentStage: string, status: string): string {
  if (!answers || Object.keys(answers).length === 0) {
    return `${status.replaceAll("_", " ")} reflection at ${stageLabels[currentStage as keyof typeof stageLabels] ?? currentStage}.`;
  }

  const latestAnswer = [...gibbsStages]
    .reverse()
    .map((stage) => answers[stage])
    .find((answer) => answer?.trim());

  return latestAnswer ?? `${status.replaceAll("_", " ")} reflection with saved answers.`;
}

function formatProgramContext(context: Record<string, unknown> | null): string {
  if (!context || Object.keys(context).length === 0) {
    return "";
  }

  return Object.entries(context)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
}

export async function loadDashboardData() {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for dashboard data.");
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false
    }
  });

  const [reflectionResult, summaryResult, safetyResult, configResult] = await Promise.all([
    supabase
      .from("reflections")
      .select(
        `
          id,
          current_stage,
          status,
          answers,
          teacher_visible,
          safety_flagged,
          created_at,
          updated_at,
          student_profiles!inner(
            display_name,
            classes(name)
          )
        `
      )
      .order("updated_at", { ascending: false })
      .limit(20),
    supabase
      .from("reflection_summaries")
      .select("reflection_id,brief_summary,actionables,key_learnings,created_at")
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("safety_concerns")
      .select(
        `
          id,
          stage,
          status,
          reason,
          message_snippet,
          created_at,
          student_profiles!inner(display_name)
        `
      )
      .order("created_at", { ascending: false })
      .limit(12),
    supabase
      .from("prompt_configs")
      .select("version,mood,starting_message_template,school_context")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  ]);

  const firstError = reflectionResult.error ?? summaryResult.error ?? safetyResult.error ?? configResult.error;
  if (firstError) {
    throw firstError;
  }

  const summariesByReflectionId = new Map(
    ((summaryResult.data ?? []) as unknown as SummaryRow[]).map((summary) => [summary.reflection_id, summary])
  );

  const students = ((reflectionResult.data ?? []) as unknown as ReflectionRow[]).map((row) => {
    const summary = summariesByReflectionId.get(row.id);
    const profile = firstRelation(row.student_profiles);
    const classRow = firstRelation(profile?.classes ?? null);
    const visibleStatus = row.teacher_visible ? "Teacher visible" : row.status.replaceAll("_", " ");

    return {
      id: row.id,
      name: profile?.display_name ?? "Unknown student",
      className: classRow?.name ?? null,
      currentStage: row.current_stage,
      status: row.status,
      teacherVisible: Boolean(row.teacher_visible),
      latestSummary: summary?.brief_summary ?? summarizeAnswers(row.answers, row.current_stage, row.status),
      actionables: summary?.actionables ?? [],
      themes: summary?.key_learnings ?? [
        stageLabels[row.current_stage as keyof typeof stageLabels] ?? row.current_stage,
        visibleStatus
      ],
      safetyFlagged: Boolean(row.safety_flagged),
      createdAt: row.updated_at
    };
  });

  const safetyConcerns = ((safetyResult.data ?? []) as unknown as SafetyConcernRow[]).map((row) => ({
    id: row.id,
    studentName: firstRelation(row.student_profiles)?.display_name ?? "Unknown student",
    stage: stageLabels[row.stage as keyof typeof stageLabels] ?? row.stage,
    status: row.status,
    reason: row.reason,
    messageSnippet: row.message_snippet,
    createdAt: row.created_at
  }));

  const promptRow = configResult.data as PromptConfigRow | null;

  return {
    students,
    safetyConcerns,
    promptConfig: promptRow
      ? {
          version: promptRow.version,
          mood: promptRow.mood,
          startingMessageTemplate: promptRow.starting_message_template,
          programContext: formatProgramContext(promptRow.school_context)
        }
      : {
          version: defaultPromptConfig.version,
          mood: defaultPromptConfig.mood,
          startingMessageTemplate: defaultPromptConfig.startingMessageTemplate,
          programContext: formatProgramContext(defaultPromptConfig.schoolContext)
        }
  };
}
