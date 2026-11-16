# Changelog

## 0.1.0-preview.1

- Initial preview of subzero delegation and its pi parent extension.
- Guided setup: `/subzero:init` with no model in Claude Code and `/subzero init`
  in pi list the child host's models, suggest a model for each tier, ask the
  endpoint limits, can check that each model answers, and write
  `.agents/subzero.yaml` only after you confirm the diff. `init <model>` stays
  as the quick path. The plugin's init skill uses the new `subzero config`
  commands.
