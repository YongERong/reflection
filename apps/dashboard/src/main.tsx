import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { defaultPromptConfig, gibbsStages, moodPresetSchema, skillRegistry, stageLabels } from "@reflection/core";
import { fetchDashboardData } from "./api.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Empty,
  Field,
  FieldLabel,
  Skeleton
} from "./components/ui.js";
import "./styles.css";

type StudentReflection = {
  id: string;
  name: string;
  className: string | null;
  currentStage: string;
  status: string;
  teacherVisible: boolean;
  latestSummary: string;
  actionables: string[];
  themes: string[];
  safetyFlagged: boolean;
  createdAt: string;
};

type SafetyConcernView = {
  id: string;
  studentName: string;
  stage: string;
  status: string;
  reason: string;
  messageSnippet: string;
  createdAt: string;
};

type PromptConfigView = {
  version: number;
  mood: string;
  startingMessageTemplate: string;
  programContext: string;
};

type DashboardData = {
  students: StudentReflection[];
  safetyConcerns: SafetyConcernView[];
  promptConfig: PromptConfigView | null;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: DashboardData }
  | { status: "error"; message: string };

type NavItem = {
  label: string;
  path: string;
  icon: string;
};

type RoutePlan = {
  description: string;
  sections: string[];
};

const defaultRoute = "#/overview";

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: "",
    items: [{ label: "Overview", path: "#/overview", icon: "O" }]
  },
  {
    label: "Core",
    items: [
      { label: "Reflections", path: "#/reflections", icon: "R" },
      { label: "Students", path: "#/students", icon: "S" },
      { label: "Classes / Programs", path: "#/classes-programs", icon: "C" },
      { label: "Safety Concerns", path: "#/safety-concerns", icon: "!" },
      { label: "Student Memory", path: "#/student-memory", icon: "M" }
    ]
  },
  {
    label: "Configuration",
    items: [
      { label: "Bot Configuration", path: "#/bot-configuration", icon: "B" },
      { label: "Prompt Versions", path: "#/prompt-versions", icon: "P" },
      { label: "Skills", path: "#/skills", icon: "K" },
      { label: "Telegram Bot", path: "#/telegram-bot", icon: "T" }
    ]
  },
  {
    label: "Operations",
    items: [
      { label: "Logs", path: "#/logs", icon: "L" },
      { label: "Exports", path: "#/exports", icon: "E" },
      { label: "Storage", path: "#/storage", icon: "D" }
    ]
  },
  {
    label: "Improve",
    items: [
      { label: "Evaluation", path: "#/evaluation", icon: "V" },
      { label: "Experiments", path: "#/experiments", icon: "X" }
    ]
  }
];

const routePlans: Record<string, RoutePlan> = {
  "#/reflections": {
    description: "Reflection records, status filters, visibility, and detail previews.",
    sections: ["Reflection list", "Status filters: in progress, completed, flagged", "Student, stage, date, visibility columns", "Reflection detail preview"]
  },
  "#/students": {
    description: "Roster-level view of reflection progress, safety state, memory, and actionables.",
    sections: ["Student roster", "Latest reflection summary", "Safety status", "Class or program assignment", "Student detail: reflections, memory, actionables"]
  },
  "#/classes-programs": {
    description: "Program and class context that shapes prompts, assignments, and reporting.",
    sections: ["Program list", "Class list", "Teacher assignments", "Student counts", "Program-level prompt and config context"]
  },
  "#/safety-concerns": {
    description: "Open and resolved safety review workflow for teacher/admin attention.",
    sections: ["Open review queue", "Reviewed and resolved queue", "Reason, stage, snippet, student, date", "Review actions placeholder"]
  },
  "#/student-memory": {
    description: "Student memory entries and their source reflections.",
    sections: ["Memory entries by student", "Profile facts, themes, strengths, goals, style", "Active and inactive status", "Source reflection link"]
  },
  "#/bot-configuration": {
    description: "Active bot behavior, message templates, school context, and enabled skills.",
    sections: ["Active mood preset", "Starting message template", "School or program context", "Summary format", "Enabled skills"]
  },
  "#/prompt-versions": {
    description: "Prompt configuration history and active version tracking.",
    sections: ["Prompt config history", "Version number", "Created by and created at", "Active version marker"]
  },
  "#/skills": {
    description: "Registered bot capabilities, permissions, persistence behavior, and purpose.",
    sections: ["Skill registry", "Permission level", "Persistence behavior", "Purpose text"]
  },
  "#/telegram-bot": {
    description: "Telegram integration status, webhook health, and public URL checks.",
    sections: ["Bot connection status", "Webhook or polling status", "Public base URL", "Health check result"]
  },
  "#/logs": {
    description: "Operational events and recent failures from the bot and dashboard API.",
    sections: ["Bot and server events", "Recent API errors", "Safety and config fetch failures"]
  },
  "#/exports": {
    description: "Downloadable data extracts for reflections, safety concerns, and actionables.",
    sections: ["Reflection export", "Safety concern export", "Student and actionable export"]
  },
  "#/storage": {
    description: "Supabase status, table counts, and data freshness checks.",
    sections: ["Supabase connection status", "Table counts", "Data freshness"]
  },
  "#/evaluation": {
    description: "Quality checks for reflections, safety detection, summaries, and actionables.",
    sections: ["Reflection quality checks", "Safety detection checks", "Summary and actionable quality checks"]
  },
  "#/experiments": {
    description: "Controlled prompt, mood preset, and skill behavior experiments.",
    sections: ["Prompt experiments", "Mood preset experiments", "Skill behavior experiments"]
  }
};

const allNavItems = navGroups.flatMap((group) => group.items);

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function normalizeHash(hash: string): string {
  if (!hash || hash === "#") return defaultRoute;
  return allNavItems.some((item) => item.path === hash) ? hash : defaultRoute;
}

function buildActivityBars(students: StudentReflection[], concerns: SafetyConcernView[]) {
  const today = new Date();
  const days = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (13 - index));
    return {
      key: dayKey(date),
      label: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date),
      reflections: 0,
      safety: 0
    };
  });
  const byKey = new Map(days.map((day) => [day.key, day]));

  for (const student of students) {
    const bucket = byKey.get(dayKey(new Date(student.createdAt)));
    if (bucket) bucket.reflections += 1;
  }

  for (const concern of concerns) {
    const bucket = byKey.get(dayKey(new Date(concern.createdAt)));
    if (bucket) bucket.safety += 1;
  }

  const max = Math.max(1, ...days.map((day) => day.reflections + day.safety));
  return days.map((day) => ({
    ...day,
    total: day.reflections + day.safety,
    height: Math.max(4, ((day.reflections + day.safety) / max) * 100)
  }));
}

function buildStageDropoff(students: StudentReflection[]) {
  const stageCounts = new Map<string, number>(gibbsStages.map((stage) => [stage, 0]));

  for (const student of students) {
    if (stageCounts.has(student.currentStage)) {
      stageCounts.set(student.currentStage, (stageCounts.get(student.currentStage) ?? 0) + 1);
    }
  }

  const max = Math.max(1, ...stageCounts.values());
  return gibbsStages.map((stage) => ({
    stage,
    label: stageLabels[stage],
    count: stageCounts.get(stage) ?? 0,
    width: Math.max(4, ((stageCounts.get(stage) ?? 0) / max) * 100)
  }));
}

function csvCell(value: unknown): string {
  return `"${String(value ?? "").replaceAll("\"", "\"\"")}"`;
}

function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(",");
}

function buildDashboardCsv(data: DashboardData): string {
  const reflectionRows = [
    csvRow(["Recent reflections"]),
    csvRow(["Student", "Class", "Current stage", "Status", "Teacher visible", "Safety flagged", "Updated", "Summary"]),
    ...data.students.map((student) =>
      csvRow([
        student.name,
        student.className ?? "",
        stageLabels[student.currentStage as keyof typeof stageLabels] ?? student.currentStage,
        student.status,
        student.teacherVisible ? "yes" : "no",
        student.safetyFlagged ? "yes" : "no",
        student.createdAt,
        student.latestSummary
      ])
    )
  ];

  const safetyRows = [
    csvRow(["Safety concerns"]),
    csvRow(["Student", "Stage", "Status", "Reason", "Snippet", "Created"]),
    ...data.safetyConcerns.map((concern) =>
      csvRow([concern.studentName, concern.stage, concern.status, concern.reason, concern.messageSnippet, concern.createdAt])
    )
  ];

  return [...reflectionRows, "", ...safetyRows].join("\n");
}

function downloadDashboardCsv(data: DashboardData): void {
  const csv = buildDashboardCsv(data);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `reflection-dashboard-export-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function NavGroup({ label, items, activeRoute }: { label: string; items: NavItem[]; activeRoute: string }) {
  return (
    <div className="navGroup">
      <span>{label}</span>
      {items.map((item) => (
        <a className={item.path === activeRoute ? "navItem active" : "navItem"} href={item.path} key={item.path}>
          <span className="navIcon" aria-hidden="true">
            {item.icon}
          </span>
          {item.label}
        </a>
      ))}
    </div>
  );
}

function PlaceholderPage({ item }: { item: NavItem }) {
  const plan = routePlans[item.path];

  return (
    <div className="consolePlaceholder">
      <Card className="placeholderPanel">
        <CardHeader>
          <div>
            <CardTitle>{item.label}</CardTitle>
            <CardDescription>{plan?.description ?? "This workspace section is ready for its dedicated view."}</CardDescription>
          </div>
          <Badge variant="outline">Planned</Badge>
        </CardHeader>
        <CardContent>
          <div className="placeholderSections">
            {(plan?.sections ?? ["Dedicated list view", "Filters and detail preview", "Operational actions"]).map((section) => (
              <article key={section}>
                <span aria-hidden="true">{item.icon}</span>
                <p>{section}</p>
              </article>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function App() {
  const moods = moodPresetSchema.options;
  const skills = Object.values(skillRegistry);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [activeRoute, setActiveRoute] = useState(() => normalizeHash(window.location.hash));

  useEffect(() => {
    let cancelled = false;

    fetchDashboardData<DashboardData>()
      .then((data) => {
        if (!cancelled) {
          setLoadState({ status: "ready", data });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadState({
            status: "error",
            message: error instanceof Error ? error.message : "Unable to load dashboard data."
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!window.location.hash || window.location.hash === "#") {
      window.history.replaceState(null, "", defaultRoute);
    }

    const handleHashChange = () => {
      setActiveRoute(normalizeHash(window.location.hash));
    };

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const data = loadState.status === "ready" ? loadState.data : null;
  const activeNavItem = allNavItems.find((item) => item.path === activeRoute) ?? allNavItems[0];
  const isOverview = activeNavItem.path === defaultRoute;
  const promptConfig = data?.promptConfig;
  const reflectionCount = data?.students.length ?? 0;
  const flaggedCount = data?.students.filter((student) => student.safetyFlagged).length ?? 0;
  const activityBars = useMemo(
    () => buildActivityBars(data?.students ?? [], data?.safetyConcerns ?? []),
    [data?.students, data?.safetyConcerns]
  );
  const stageDropoff = useMemo(() => buildStageDropoff(data?.students ?? []), [data?.students]);
  const exportDisabled = loadState.status !== "ready";

  return (
    <main className="consoleShell">
      <aside className="sidebar">
        <div className="workspaceSwitcher">
          <span className="avatar">R</span>
          <div>
            <strong>Reflection</strong>
            <small>Default project</small>
          </div>
        </div>

        <nav>
          {navGroups.map((group) => (
            <NavGroup activeRoute={activeNavItem.path} items={group.items} key={group.label || "overview"} label={group.label} />
          ))}
        </nav>

        <div className="sidebarFooter">
          <span className="sidebarToggle" />
        </div>
      </aside>

      <section className="consoleApp">
        <header className="consoleTopbar">
          <div className="crumbs">
            <strong>Reflection Dashboard</strong>
            <span>/</span>
            <button type="button">{activeNavItem.label}</button>
          </div>
          <div className="topActions">
            <a href="#/overview" aria-current={isOverview ? "page" : undefined}>
              Dashboard
            </a>
            <a href="#/docs">Docs</a>
            <Button variant="outline" size="sm" type="button">
              Settings
            </Button>
            <span className="profileDot">A</span>
          </div>
        </header>

        <div className="consoleCanvas">
          {!isOverview && <PlaceholderPage item={activeNavItem} />}
          {isOverview && (
            <>
          <section className="consoleMain">
            <Card className="usagePanel">
              <CardHeader>
                <div>
                  <CardTitle>Overview</CardTitle>
                  <CardDescription>Program activity, reflection volume, and safety review load for the current project.</CardDescription>
                </div>
                <div className="filterRow">
                  <Badge variant="secondary">Default project</Badge>
                  <Badge variant="outline">Last 14 days</Badge>
                  <Button
                    disabled={exportDisabled}
                    onClick={() => {
                      if (data) downloadDashboardCsv(data);
                    }}
                    variant="outline"
                    size="sm"
                    type="button"
                  >
                    Export
                  </Button>
                </div>
              </CardHeader>

              <CardContent>
                <div className="usageSummary">
                  <span>Total reflections</span>
                  <strong>{reflectionCount}</strong>
                  <small>{flaggedCount} flagged for review</small>
                </div>

                <div className="barChart" aria-label="Reflection activity over the last 14 days">
                  <div className="thresholdLine" />
                  {activityBars.map((bar) => (
                    <div className="barSlot" key={bar.key}>
                      <span
                        className={bar.safety > 0 ? "bar danger" : "bar"}
                        style={{ "--bar-height": `${bar.height}%` } as React.CSSProperties}
                        title={`${bar.label}: ${bar.total} activity items`}
                      />
                    </div>
                  ))}
                  <span className="axisLabel start">{activityBars[0]?.label}</span>
                  <span className="axisLabel end">{activityBars.at(-1)?.label}</span>
                </div>
              </CardContent>
            </Card>

            <div className="capabilityTabs">
              <button className="active" type="button">
                Capabilities snapshot
              </button>
              <button type="button">Safety categories</button>
            </div>

            <section className="capabilityGrid">
              {skills.slice(0, 4).map((skill, index) => (
                <Card as="article" className="capabilityCard" key={skill.name}>
                  <CardHeader>
                    <div>
                      <CardTitle>{skill.name.replaceAll("_", " ")}</CardTitle>
                      <CardDescription>{skill.permission}</CardDescription>
                    </div>
                    <span>{index + 1}</span>
                  </CardHeader>
                  <CardContent>
                    <p>{skill.purpose}</p>
                    <div className="miniBars" aria-hidden="true">
                      {activityBars.slice(-8).map((bar) => (
                        <i
                          key={`${skill.name}-${bar.key}`}
                          style={{ "--bar-height": `${Math.max(6, bar.height * (index === 0 ? 0.8 : 0.45))}%` } as React.CSSProperties}
                        />
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </section>

            <Card className="reflectionTable">
              <CardHeader>
                <div>
                  <CardTitle>Recent reflections</CardTitle>
                  <CardDescription>Live rows from Supabase, ordered by the backend response.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                {loadState.status === "loading" && (
                  <>
                    <Skeleton />
                    <Skeleton />
                  </>
                )}
                {loadState.status === "error" && <Empty>{loadState.message}</Empty>}
                {data?.students.length === 0 && <Empty>No reflections found.</Empty>}
                {data?.students.map((student) => (
                  <article className="reflectionRow" key={student.id}>
                    <div>
                      <strong>{student.name}</strong>
                      <small>
                        {stageLabels[student.currentStage as keyof typeof stageLabels] ?? student.currentStage} · {formatDate(student.createdAt)}
                      </small>
                    </div>
                    <p>{student.latestSummary}</p>
                    <Badge variant={student.safetyFlagged ? "destructive" : "secondary"}>
                      {student.safetyFlagged ? "Safety review" : student.teacherVisible ? "Teacher visible" : (student.className ?? "No class")}
                    </Badge>
                  </article>
                ))}
              </CardContent>
            </Card>
          </section>

          <aside className="insightRail">
            <Card className="stageDropoff">
              <CardHeader>
                <CardTitle>Stage drop-off</CardTitle>
                <CardDescription>{reflectionCount} current reflections</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="stageRows" aria-label="Current reflections by Gibbs stage">
                  {stageDropoff.map((stage) => (
                    <div className="stageRow" key={stage.stage}>
                      <span>{stage.label}</span>
                      <div className="stageTrack">
                        <i style={{ "--stage-width": `${stage.width}%` } as React.CSSProperties} />
                      </div>
                      <strong>{stage.count}</strong>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="configPanel">
              <CardHeader>
                <CardTitle>Bot config</CardTitle>
                <CardDescription>Config v{promptConfig?.version ?? defaultPromptConfig.version}</CardDescription>
              </CardHeader>
              <CardContent>
                <Field>
                  <FieldLabel>Mood preset</FieldLabel>
                  <select value={promptConfig?.mood ?? defaultPromptConfig.mood} disabled>
                    {moods.map((mood) => (
                      <option key={mood} value={mood}>
                        {mood}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field>
                  <FieldLabel>Starting message</FieldLabel>
                  <textarea value={promptConfig?.startingMessageTemplate ?? defaultPromptConfig.startingMessageTemplate} readOnly />
                </Field>
              </CardContent>
            </Card>

            <Card className="reviewList">
              <CardHeader>
                <CardTitle>Users</CardTitle>
                <CardDescription>Latest safety queue</CardDescription>
              </CardHeader>
              <CardContent>
                {loadState.status === "loading" && <Skeleton />}
                {data?.safetyConcerns.length === 0 && <Empty>No safety concerns found.</Empty>}
                {data?.safetyConcerns.slice(0, 5).map((concern) => (
                  <article className="reviewItem" key={concern.id}>
                    <span>{concern.studentName.slice(0, 1).toLowerCase()}</span>
                    <strong>{concern.studentName}</strong>
                    <small>{concern.status}</small>
                  </article>
                ))}
              </CardContent>
            </Card>
          </aside>
            </>
          )}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
