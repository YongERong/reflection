import {
  createId,
  createInitialReflection,
  defaultPromptConfig,
  type PromptConfig,
  type ReflectionSession,
  type ReflectionStore,
  type ReflectionSummary,
  type ReflectionTurn,
  type SafetyConcern,
  type StudentMemory,
  type StudentProfile
} from "@reflection/core";

export class InMemoryReflectionStore implements ReflectionStore {
  private students = new Map<string, StudentProfile>();
  private memories = new Map<string, StudentMemory>();
  private reflections = new Map<string, ReflectionSession>();
  private summaries = new Map<string, ReflectionSummary>();
  private safetyConcerns: SafetyConcern[] = [];
  private turns: ReflectionTurn[] = [];
  private config: PromptConfig = defaultPromptConfig;

  async getOrCreateStudent(input: { telegramUserId: string; displayName: string }): Promise<StudentProfile> {
    const existing = this.students.get(input.telegramUserId);
    if (existing) return existing;

    const student: StudentProfile = {
      id: createId("student"),
      telegramUserId: input.telegramUserId,
      displayName: input.displayName
    };
    this.students.set(input.telegramUserId, student);
    this.memories.set(student.id, {
      profileFacts: [],
      recurringThemes: [],
      strengths: [],
      goals: []
    });
    return student;
  }

  async getMemory(studentId: string): Promise<StudentMemory> {
    return (
      this.memories.get(studentId) ?? {
        profileFacts: [],
        recurringThemes: [],
        strengths: [],
        goals: []
      }
    );
  }

  async getActiveConfig(): Promise<PromptConfig> {
    return this.config;
  }

  async createReflection(studentId: string): Promise<ReflectionSession> {
    const session = createInitialReflection(studentId);
    this.reflections.set(session.id, session);
    return session;
  }

  async getLatestOpenReflection(studentId: string): Promise<ReflectionSession | null> {
    const sessions = [...this.reflections.values()]
      .filter((session) => session.studentId === studentId && session.status === "in_progress")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sessions[0] ?? null;
  }

  async saveReflection(session: ReflectionSession): Promise<void> {
    this.reflections.set(session.id, session);
  }

  async abandonReflection(reflectionId: string): Promise<void> {
    const session = this.reflections.get(reflectionId);
    if (!session) return;
    this.reflections.set(reflectionId, {
      ...session,
      status: "abandoned",
      updatedAt: new Date().toISOString()
    });
  }

  async abandonOpenReflections(studentId: string): Promise<void> {
    const now = new Date().toISOString();
    for (const session of this.reflections.values()) {
      if (session.studentId === studentId && session.status === "in_progress") {
        this.reflections.set(session.id, {
          ...session,
          status: "abandoned",
          updatedAt: now
        });
      }
    }
  }

  async addTurn(turn: ReflectionTurn): Promise<void> {
    this.turns.push(turn);
  }

  async getRecentTurns(reflectionId: string, limit: number): Promise<ReflectionTurn[]> {
    return this.turns
      .filter((turn) => turn.reflectionId === reflectionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-limit)
      .map((turn) => ({ ...turn }));
  }

  getTurns(): ReflectionTurn[] {
    return [...this.turns];
  }

  getReflections(): ReflectionSession[] {
    return [...this.reflections.values()].map((session) => ({ ...session, answers: { ...session.answers } }));
  }

  async saveSafetyConcern(concern: SafetyConcern): Promise<void> {
    this.safetyConcerns.push(concern);
    const session = this.reflections.get(concern.reflectionId);
    if (session) {
      this.reflections.set(session.id, { ...session, safetyFlagged: true });
    }
  }

  getSafetyConcerns(): SafetyConcern[] {
    return [...this.safetyConcerns];
  }

  async saveSummary(summary: ReflectionSummary): Promise<void> {
    this.summaries.set(summary.reflectionId, summary);
  }

  async getLatestSummary(studentId: string): Promise<ReflectionSummary | null> {
    const reflectionIds = [...this.reflections.values()]
      .filter((session) => session.studentId === studentId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((session) => session.id);

    for (const reflectionId of reflectionIds) {
      const summary = this.summaries.get(reflectionId);
      if (summary) return summary;
    }
    return null;
  }
}
