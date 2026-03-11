## UI LR Scheduler And Training Intent Presets

### Scope

This fix is for the simple job builder in `./ui/`, not the advanced YAML editor.

The backend already supported `train.lr_scheduler` and `train.lr_scheduler_params`, but the simple UI did not expose them.

The change also adds simple training-intent presets for common LoRA starting points.

### Problem

UI-created jobs did not surface the optimizer learning-rate scheduler.

Because the simple UI never wrote `train.lr_scheduler`, those jobs silently fell back to the backend default of `constant`.

That created three problems:

1. Users could not select `cosine`, `linear`, or `cosine_with_restarts` without switching to the advanced YAML editor.
2. The simple UI had no way to expose restart cycles with a clear explanation of what cycles means.
3. There was no guided starting point for common LoRA goals such as characters, objects, concepts, or styles.

### Root Cause

The issue was mostly a UI omission, but there was also a backend mismatch for cosine restarts.

UI side:

- `SimpleJob.tsx` did not expose `train.lr_scheduler`
- `TrainConfig` in the UI types did not include scheduler fields
- default simple-job config therefore relied on backend fallback behavior

Backend side:

- `cosine_with_restarts` was mapped to `CosineAnnealingWarmRestarts`
- the existing translation used the full training length as a single restart window
- that meant a UI `cycles` field would not have matched user expectations unless restart span calculation was corrected

### Fix

The fix has four parts.

1. Expose LR scheduler in the simple UI.

Added an `LR Scheduler` dropdown to the simple training form with:

- `constant`
- `linear`
- `cosine`
- `cosine_with_restarts`

2. Expose restart cycles only when relevant.

When `cosine_with_restarts` is selected, the UI now shows `Cycles` and explains it as the number of times the learning rate jumps back up during training.

3. Correct backend cosine-restart semantics.

The backend now interprets `num_cycles` as the number of hard restarts and derives the restart span from total training steps.

That makes the simple UI control line up with the actual schedule behavior instead of being a cosmetic field.

4. Add training-intent presets.

The simple UI now includes recommended starting-point presets for:

- `Face or Character`
- `Object or Product`
- `General Concept`
- `Style or Look`

These presets update a small set of high-impact settings:

- steps
- learning rate
- LR scheduler
- timestep bias

### Compatibility

This change preserves older jobs.

- New simple-UI jobs default to `cosine`
- migrated older jobs keep `constant` if they never had an explicit scheduler

This avoids silently changing scheduler behavior for existing saved jobs.

### Guidance Note

The training-intent presets are deliberately framed as practical starting points, not authoritative rules.

Official Hugging Face training docs and examples support exposing scheduler controls and clearly define cosine restart behavior, but they do not provide a canonical four-way preset taxonomy for character vs object vs concept vs style training.

So the presets should be treated as UI guidance for first runs, then adjusted based on sample quality and dataset behavior.