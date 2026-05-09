# Better Agents Scenarios

This folder seeds the LangWatch Better Agents workflow for the reflection bot. The app code keeps the runtime in TypeScript, while Better Agents is used for prompt/versioning discipline, scenario coverage, and evaluation expectations.

Core invariants:

- The modified Gibbs cycle includes `People` immediately after `Description`.
- Editable prompts may change tone, starting message, school/program context, and summary format.
- Editable prompts must not change privacy, safety, storage, or role-boundary behavior.
- Skills are registered in code and carry permission, persistence, schema, and eval metadata.
