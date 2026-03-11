## WAN Text Encoder Quantization Used `qtype` Instead Of `qtype_te`

### Problem

The WAN loader had a configuration bug in the text encoder quantization path.

When `quantize_te: true` was enabled, the code quantized the UMT5 text encoder using `model.qtype` instead of `model.qtype_te`.

That meant:

- `qtype_te` was effectively ignored for WAN models
- changing text encoder quantization independently from transformer quantization had no effect
- experiments that tried lighter or safer text encoder quantization settings were misleading

### Why It Matters

For WAN training, the text encoder is often cached and then unloaded, so this bug usually does **not** explain training-step OOM by itself.

However, it still matters because:

- startup behavior was not matching config
- users could not tune transformer and text encoder quantization independently
- future runs without cached text embeddings would be affected more directly

### Fix

Updated the WAN text encoder quantization path to use `qtype_te`.

Changed in:

- `toolkit/models/wan21/wan21.py`
- `ai-toolkit/toolkit/models/wan21/wan21.py`

Before:

- text encoder quantization used `get_qtype(self.model_config.qtype)`

After:

- text encoder quantization uses `get_qtype(self.model_config.qtype_te)`

### Practical Impact

This fix does not change the transformer quantization path.

It only ensures that WAN text encoder quantization now follows the config the user actually supplied.

### VRAM Note

In runs with:

- `cache_text_embeddings: true`
- text encoder unloaded before training

the effect on steady-state training VRAM is limited.

The main benefit is correctness and predictable behavior.