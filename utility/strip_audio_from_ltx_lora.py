import argparse
import os
from collections import Counter

from safetensors import safe_open
from safetensors.torch import load_file, save_file


DEFAULT_PATTERNS = [
    "audio_attn1",
    "audio_attn2",
    "audio_ff",
    "audio_to_video_attn",
    "video_to_audio_attn",
    "audio_",
    "_audio",
    "av_ca",
    "a2v",
    "v2a",
]


def should_drop_key(key, patterns):
    lowered = key.lower()
    return any(pattern.lower() in lowered for pattern in patterns)


def default_output_path(input_path):
    base, ext = os.path.splitext(input_path)
    return f"{base}.no_audio{ext}"


def summarize_keys(keys, patterns):
    counts = Counter()
    for key in keys:
        matched = False
        for pattern in patterns:
            if pattern.lower() in key.lower():
                counts[pattern] += 1
                matched = True
                break
        if not matched:
            counts["kept"] += 1
    return counts


parser = argparse.ArgumentParser(
    description="Remove audio-related tensors from a LoRA safetensors file."
)
parser.add_argument("input_path", type=str, help="Path to the source LoRA safetensors file")
parser.add_argument(
    "output_path",
    nargs="?",
    default=None,
    help="Optional output path. Defaults to <input>.no_audio.safetensors",
)
parser.add_argument(
    "--contains",
    action="append",
    default=[],
    help="Additional substring to match for removal. Can be used multiple times.",
)
parser.add_argument(
    "--only-custom-patterns",
    action="store_true",
    help="Use only the custom --contains patterns instead of the built-in LTX defaults.",
)
parser.add_argument(
    "--dry-run",
    action="store_true",
    help="Report what would be removed without writing an output file.",
)

args = parser.parse_args()
args.input_path = os.path.abspath(args.input_path)
args.output_path = os.path.abspath(args.output_path) if args.output_path else default_output_path(args.input_path)

if not os.path.exists(args.input_path):
    raise FileNotFoundError(f"Input file not found: {args.input_path}")

patterns = list(args.contains)
if not args.only_custom_patterns:
    patterns = DEFAULT_PATTERNS + patterns

if len(patterns) == 0:
    raise ValueError("No removal patterns provided")

state_dict = load_file(args.input_path)

with safe_open(args.input_path, framework="pt") as handle:
    metadata = handle.metadata() or {}

removed_keys = [key for key in state_dict if should_drop_key(key, patterns)]
kept_state_dict = {key: value for key, value in state_dict.items() if key not in removed_keys}

print(f"Input: {args.input_path}")
print(f"Total tensors: {len(state_dict)}")
print(f"Removed tensors: {len(removed_keys)}")
print(f"Kept tensors: {len(kept_state_dict)}")

summary = summarize_keys(removed_keys, patterns)
if len(removed_keys) > 0:
    print("Matched removal counts:")
    for pattern, count in summary.items():
        if pattern == "kept":
            continue
        print(f"  {pattern}: {count}")

    print("Sample removed keys:")
    for key in removed_keys[:25]:
        print(f"  {key}")

if args.dry_run:
    print("Dry run requested. No output file written.")
else:
    updated_metadata = {
        **metadata,
        "repair_note": "Removed audio-related LoRA tensors using scripts/strip_audio_from_lora.py",
    }
    save_file(kept_state_dict, args.output_path, metadata=updated_metadata)
    print(f"Saved stripped LoRA to {args.output_path}")