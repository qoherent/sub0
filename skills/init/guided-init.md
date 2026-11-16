# Guided subzero init

This guide is shared by both parents. Claude Code and pi each map the steps below to their own commands or tools. The steps are: **show**, **models**, **ask**, **check**, **preview** and **apply**.

You help the user choose which models run subzero's children, and subzero writes `.agents/subzero.yaml`. The user decides every tier. You suggest.

## Standing rules

These hold for the whole run.

1. **Ask every question with the ask step, and never end your turn until the flow is finished or the user stops it.** A question asked as plain text ends the run, and the user would have to start init again. A dismissed question means the user stopped: say that nothing was written, and stop.
2. **Never create, edit or delete `.agents/subzero.yaml` yourself.** Only the apply step writes it. If subzero refuses something, tell the user why and keep going; never work around a refusal.
3. **Show subzero's preview diff and summary unchanged, and confirm once.** Then apply with the preview's fingerprint and exactly the same changes. If anything changes after the confirmation, preview again and confirm again.
4. **If apply refuses because the file or the changes differ from the preview, preview again.** If a change is refused, say why, naming the agents subzero names, and offer to keep the current value.

## Steps

### 1. Show the current state

Run **show**.

- `refused`: show the error unchanged. Tell the user to fix the file by hand or move it aside, then stop.
- `repairable`: say what will be repaired, for example a missing `fallback` agent. It is added when you apply.
- `no-file`: this run creates the file.
- `ok`: the current tiers and limits are the defaults for every question below.

### 2. List the models

Run **models**. If it fails, relay the message and stop. When no models are listed, the user needs to set up a provider in pi first, which is outside this flow.

Print the full list as compact text, grouped by endpoint (the part of the name before the first slash). For each model, give the name, context window, thinking levels and input/output cost. The question options can hold only a few models, so this list is how the user sees the rest.

### 3. Choose a model for each tier

Ask about `medium` first, because it is required. Then ask about `small` and `large`.

- **Defaults.** A tier that is already set defaults to its current model. Suggest a different model only for a tier that is not set yet. Give each suggestion one line of reason:
  - `small` is the cheapest capable model;
  - `medium` is a mid-tier model;
  - `large` is the strongest model you would trust with review work.
- **Options.** Offer:
  - your suggestion or the current model;
  - "leave unset" for `small` and `large` when they are not set;
  - "remove" when they are set.

  The user can type any listed model name instead. If the name is not in the list, say so and ask again.
- **Large warning.** Before `large` is added or its model changed, show the large warning from **show** and let the user leave it unset.
- **Current model not listed.** If a current model is not in the list, say so ("not listed by pi"), make keeping it the default, and warn that children may fail on it.
- **Removing a tier other agents use.** If the tier has dependents in **show**, refuse the removal at once, naming them, and keep the current model.
- **Other tiers.** Leave tiers other than `small`, `medium` and `large` untouched. Mention them only so the user knows they stay.

### 4. Choose a thinking level for each new or changed tier

Offer only the levels the model lists. If the only level is `off`, use it without asking. A kept model keeps its current level.

### 5. Ask a parallel limit for each endpoint in use

For each endpoint the chosen tiers use, ask one question that names the tiers and models on it: "How many children may run at once on `local`, used by small (local/qwen3-4b) and medium (local/qwen3-coder-30b)?"

- Answers are a whole number of 1 or more, or "no limit". The current limit is the default.
- A single-GPU local server usually wants 1.
- Skip endpoints that only an agent's tier override uses. Their limits stay as they are.
- Two pi providers that point at the same server still count as two endpoints.

### 6. Offer the reachability check

Ask: "Check that each chosen model answers? It sends one short prompt per model."

If the user says yes, run **check** for each new or changed tier's model and thinking level, one at a time. Report each tier as answered, or failed with its one-line reason. For a failed tier, ask whether to keep the model or choose another, and go back to step 3 for that tier.

### 7. Preview and confirm

Run **preview** with every change: tiers set or removed, and limits set or cleared.

- If it lists refusals or reports the result as invalid, explain them and go back to the step that needs a different answer.
- If there is nothing to change, say so and stop.

Otherwise show the diff and the summary unchanged, then ask: "Write this to `.agents/subzero.yaml`?" Offer three options: write it, change something, or cancel.

### 8. Apply and report

Run **apply** with the preview's fingerprint and the same changes, then report the summary.

When the file was created, or a tier was added or removed, tell the user what that means in this parent. The parent's mapping says what to say.
