# To Consider

## DOP Text Embedding Dual Cache For Static Captions

### Goal

Allow Differential Output Preservation (DOP) to reuse cached text embeddings when prompts are effectively static.

Today the config rejects this combination entirely:

- `diff_output_preservation: true`
- `cache_text_embeddings: true`

This is safe as a general rule, but it leaves performance on the table for simple jobs where prompt text does not change across steps.

### Why Consider It

For DOP, the trainer currently does extra text-encoder work every step:

1. Encode the normal prompt.
2. Encode the DOP class-replaced prompt.
3. Optionally encode unconditional prompts for CFG.

For static-caption jobs this is avoidable. We should be able to cache:

- the normal prompt embedding
- the DOP prompt embedding with trigger replaced by class word

This would reduce step time and may reduce VRAM pressure from keeping more text-encoder work active during training.

### When It Is Safe

This should only be allowed when the effective prompt is deterministic.

At minimum, require all of the following:

- `caption_dropout_rate == 0`
- `token_dropout_rate == 0`
- `shuffle_tokens == false`
- `random_triggers` unset or empty
- no adapter path that mutates prompts at train time
- no text-conditioning path that depends on changing control inputs
- DOP class replacement is deterministic for both `prompt` and `prompt_2`

UI-created FLUX jobs are close to this, but not fully static by default because the template sets `caption_dropout_rate: 0.05`.

### Current Limitation In Code

The existing text embedding cache is keyed from a single resolved caption and some embedding metadata. There is already a TODO in the cache path logic noting that trigger words, DOP, and similar features are not properly accounted for.

So the current restriction is reasonable, but it is broader than necessary for static-caption jobs.

There is also a separate correctness issue in the current DOP prompt construction. Right now the trainer does a naive string replacement of the trigger word with the class word. This is fragile for captions with:

- multiple people or objects in the same caption
- possessives such as Alice's
- captions that already contain the class word
- captions where the trigger appears inside a larger token or phrase

Example:

- original: featuring Alice and a woman, Alice's hair is green, the woman's hair is blue
- naive DOP rewrite: featuring woman and a woman, woman's hair is green, the woman's hair is blue

This loses entity identity and can turn a differential preservation target into an ambiguous or incorrect caption.

### Suggested Implementation

1. Add a capability check such as `can_cache_dop_text_embeddings`.
2. Only enable it when all prompt-variation features are off.
3. Cache two prompt embeddings per item:
   - normal embedding
   - DOP embedding
4. Include cache mode in the cache key so the two files do not collide.
5. Include all prompt-affecting settings in the cache key.
6. Reuse cached DOP embeddings in training instead of calling `encode_prompt()` each step.
7. Keep the current hard error for all unsupported dynamic cases.

Separately, improve DOP prompt construction so it does not rely on unrestricted global string replacement. Better options include:

1. Prefer explicit placeholder-based captions such as [trigger] and replace only that placeholder.
2. Replace only whole trigger tokens, not arbitrary substrings.
3. Optionally skip DOP for captions that contain both the trigger and an existing class entity in a way that makes the replacement ambiguous.
4. Consider warning when a caption contains multiple likely class instances for a single trigger concept.

### Minimal Scope

Do not try to solve all prompt mutation cases in the first pass.

An acceptable first implementation is:

- static captions only
- single deterministic trigger replacement
- deterministic `prompt_2` handling if present
- no adapter prompt mutation support

If placeholder-based replacement is adopted, that should be preferred over raw text substitution for the first implementation.

### Expected Benefit

Biggest gains should show up in runs where text encoding is a noticeable part of step time, especially larger text-encoder setups.

This is mostly a throughput and memory-efficiency improvement. It should not materially change training behavior if the cached prompts match the step-time prompts exactly.