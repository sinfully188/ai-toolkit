## WAN 2.2 I2V Scheduler Channel Mismatch

### Scope

This fix is for the WAN 2.2 image-to-video path, not the plain text-to-video path.

The affected architecture is `wan22_14b_i2v`.

Why:

- In the I2V path, the pipeline accepts a 36-channel input tensor.
- The first 16 channels are the actual latent channels.
- The remaining 20 channels are first-frame conditioning.
- The scheduler step still operates on the 16 latent channels only.

That split is visible in the WAN 2.2 pipeline before denoising continues.

### Problem

The training run was not failing during model loading, latent caching, text embedding caching, or the training step itself.

It failed during baseline sample generation before training starts.

The failing sequence was:

1. The pipeline received a 36-channel latent tensor for WAN 2.2 I2V.
2. It split that tensor into 16 latent channels and 20 conditioning channels.
3. It concatenated the conditioning back onto the latent tensor before calling the transformer.
4. The transformer output could therefore also have 36 channels.
5. That full prediction was being passed into `scheduler.step(...)`.
6. The scheduler state tensor still had only 16 channels.

Result:

- shape mismatch at the scheduler step
- error pattern: 36 channels versus 16 channels

### Root Cause

The pipeline correctly handled conditioned input assembly for I2V, but it did not trim the model prediction back to the latent channel count before the scheduler update.

That means the scheduler received a prediction tensor aligned to conditioned input width instead of latent width.

### Fix

The fix trims model outputs back to `latents.shape[1]` before scheduler stepping.

Applied in:

- `extensions_built_in/diffusion_models/wan22/wan22_pipeline.py`
- `ai-toolkit/extensions_built_in/diffusion_models/wan22/wan22_pipeline.py`

Behavior after the patch:

1. The transformer can still receive the full conditioned 36-channel input in the I2V path.
2. If the transformer returns more channels than the latent state, the prediction is sliced back to the latent channel count.
3. The same safeguard is applied to the unconditional prediction path used for classifier-free guidance.
4. The scheduler only sees tensors that match the latent state width.

### Defensive Check

The patch also raises a clear error if the model returns fewer channels than the latent tensor expects.

This prevents a silent wrong-shape update and makes future regressions easier to diagnose.

### Temporary Workarounds

If you want to bypass baseline sampling and start training immediately, either of these settings should skip the failing pre-training sample stage:

- `skip_first_sample: true`
- `disable_sampling: true`

These are workarounds only. They avoid the baseline sample path but do not address the underlying sampling bug by themselves.

### Summary

This is not a general WAN 2.2 T2V fix.

It is a WAN 2.2 I2V sampling fix for the case where:

- conditioned input width is 36 channels
- latent state width is 16 channels
- scheduler updates must operate only on the 16 latent channels