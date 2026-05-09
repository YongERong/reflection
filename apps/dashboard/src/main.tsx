import React from "react";
import { createRoot } from "react-dom/client";
import { defaultPromptConfig, gibbsStages, moodPresetSchema, skillRegistry, stageLabels } from "@reflection/core";
import "./styles.css";

const mockStudents = [
  {
    id: "student_1",
    name: "Asha Tan",
    className: "2A",
    latestSummary: "Asha reflected on volunteering at the library and learning to prepare clearer examples.",
    actionables: ["Prepare three examples before mentoring younger students."],
    themes: ["communication", "service learning"],
    safetyFlagged: false
  },
  {
    id: "student_2",
    name: "Daniel Lim",
    className: "2B",
    latestSummary: "Daniel reflected on a robotics event and noticed that asking teammates for help improved the outcome.",
    actionables: ["Ask for help earlier when the team is blocked."],
    themes: ["teamwork", "confidence"],
    safetyFlagged: true
  }
];

const safetyConcerns = [
  {
    id: "safety_1",
    studentName: "Daniel Lim",
    stage: "Feelings",
    reason: "Safety phrase detected",
    messageSnippet: "Student shared a short concern that should be reviewed.",
    createdAt: "Today"
  }
];

function App() {
  const moods = moodPresetSchema.options;
  const skills = Object.values(skillRegistry);

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>Reflection Dashboard</h1>
          <p>Teacher/admin view for Gibbs-cycle summaries, actionables, memory themes, and bounded bot configuration.</p>
        </div>
        <span className="status">Config v{defaultPromptConfig.version}</span>
      </header>

      <section className="grid">
        <section className="panel wide">
          <div className="panelHeader">
            <h2>Student Reflections</h2>
            <button type="button">Review visibility</button>
          </div>
          <div className="studentList">
            {mockStudents.map((student) => (
              <article className="studentRow" key={student.id}>
                <div>
                  <strong>{student.name}</strong>
                  <span>{student.safetyFlagged ? "Safety review" : student.className}</span>
                </div>
                <p>{student.latestSummary}</p>
                <ul>
                  {student.actionables.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <div className="tags">
                  {student.themes.map((theme) => (
                    <span key={theme}>{theme}</span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>Bot Configuration</h2>
          <label>
            Mood preset
            <select defaultValue={defaultPromptConfig.mood}>
              {moods.map((mood) => (
                <option key={mood} value={mood}>
                  {mood}
                </option>
              ))}
            </select>
          </label>
          <label>
            Starting message
            <textarea defaultValue={defaultPromptConfig.startingMessageTemplate} />
          </label>
          <label>
            Program context
            <textarea placeholder="Optional bounded school/program guidance" />
          </label>
        </section>

        <section className="panel">
          <h2>Modified Gibbs Cycle</h2>
          <ol className="stages">
            {gibbsStages.map((stage) => (
              <li key={stage}>{stageLabels[stage]}</li>
            ))}
          </ol>
        </section>

        <section className="panel">
          <h2>Safety Concerns</h2>
          <div className="safetyList">
            {safetyConcerns.map((concern) => (
              <article className="safetyItem" key={concern.id}>
                <div>
                  <strong>{concern.studentName}</strong>
                  <span>{concern.createdAt}</span>
                </div>
                <p>{concern.reason}</p>
                <small>
                  {concern.stage}: {concern.messageSnippet}
                </small>
              </article>
            ))}
          </div>
        </section>

        <section className="panel wide">
          <h2>Registered Skills</h2>
          <div className="skillGrid">
            {skills.map((skill) => (
              <article className="skillCard" key={skill.name}>
                <div>
                  <strong>{skill.name}</strong>
                  <span>{skill.permission}</span>
                </div>
                <p>{skill.purpose}</p>
                <small>{skill.persistence}</small>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
