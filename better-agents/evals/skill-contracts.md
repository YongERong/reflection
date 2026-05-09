# Skill Contract Evals

Every registered skill must declare:

- `name`
- `purpose`
- `inputSchema`
- `outputSchema`
- `permission`
- `persistence`
- `evalCoverage`

Required skills:

- `ask_next_gibbs_question`
- `summarize_reflection`
- `extract_actionables`
- `propose_memory_update`
- `detect_safety_concern`
- `generate_teacher_summary`

Sensitive skills may propose persistence, but backend logic must validate before writing durable memory, teacher-visible summaries, safety flags, or admin analytics.
