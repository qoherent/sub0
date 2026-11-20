# Changelog

## 0.1.0-preview.1

- Initial preview of subzero delegation and its pi parent extension.
- Guided setup: `/subzero:init` with no model in Claude Code and `/subzero init`
  in pi list the child host's models, suggest a model for each tier, ask the
  endpoint limits, can check that each model answers, and write
  `.agents/subzero.yaml` only after you confirm the diff. `init <model>` stays
  as the quick path. The plugin's init skill uses the new `subzero config`
  commands.
- Global config file: `~/.agents/subzero.yaml` (or the path in
  `SUBZERO_GLOBAL_CONFIG`) holds `models.tiers`, endpoint `parallel` limits and
  `routing` for every project. A project's `.agents/subzero.yaml` is read over it
  and merged by name; a project entry replaces the global one whole, and
  `large:` or `local:` with nothing after the colon removes an inherited tier or
  limit. Any other key in the global file is a load error.
- Behavior change: a global file with a `medium` tier turns subzero on in every
  project, with or without a project file, using built-in `general` and
  `fallback` agents. Put `enabled: false` in a project's `.agents/subzero.yaml`
  to switch subzero off there.
- Guided init asks first whether the models are for every project or only this
  one, and writes tiers and limits only, never agents. `subzero config preview`
  and `apply` take `--scope global|project`, and `config show` marks where each
  tier and limit comes from. `init <model>` is unchanged.
- Load errors name the file they come from, the global file or the project file.
- Global file key `hosts.pi.extensions`: a list of pi extension files (absolute or
  `~/` paths) that every pi process of subzero loads with `-e` next to `-ne`:
  child runs, `subzero config models` and `subzero config check`. A project file
  with a `hosts` key is a load error. The process environment, including
  `SUBZERO_GLOBAL_CONFIG`, is trusted. The pi driver, not the config, checks the
  section. A path
  that names no file loads, and pi is not started for it: the child run, listing
  or check fails with a message that names the path.
