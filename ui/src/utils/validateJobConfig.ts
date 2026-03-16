import { JobConfig } from '@/types';

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * Validates a job config for incompatible settings before saving or starting.
 * These rules mirror the Python-side validation in:
 *   - toolkit/config_modules.py (validate_config_pair)
 *   - extensions_built_in/sd_trainer/SDTrainer.py
 */
export function validateJobConfig(jobConfig: JobConfig): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const process = jobConfig?.config?.process?.[0];
  if (!process) {
    errors.push('Job config is missing process configuration.');
    return { errors, warnings };
  }

  const train = process.train;
  const model = process.model;
  const network = process.network;
  const datasets = process.datasets;
  const triggerWord = process.trigger_word;

  // ─── Required fields ───────────────────────────────────────────────
  if (!jobConfig.config.name || jobConfig.config.name.trim() === '') {
    errors.push('Training name is required.');
  }

  if (!model?.name_or_path) {
    errors.push('Model name or path must be specified.');
  }

  // ─── Differential Output Preservation checks ──────────────────────
  if (train?.diff_output_preservation) {
    if (!triggerWord || triggerWord.trim() === '') {
      errors.push(
        'Differential Output Preservation requires a trigger word to be set.'
      );
    }
    if (!network) {
      errors.push(
        'Differential Output Preservation requires a network (e.g. LoRA) to be configured.'
      );
    }
    if (train.train_text_encoder) {
      errors.push(
        'Differential Output Preservation is not supported when training the text encoder. Disable "Train Text Encoder" or disable DOP.'
      );
    }
    if (train.cache_text_embeddings) {
      errors.push(
        'Cannot use Differential Output Preservation with cached text embeddings. Disable one of these settings.'
      );
    }
  }

  // ─── Blank Prompt Preservation checks ─────────────────────────────
  if (train?.blank_prompt_preservation) {
    if (!network) {
      errors.push(
        'Blank Prompt Preservation requires a network (e.g. LoRA) to be configured.'
      );
    }
  }

  // ─── Mutual exclusion: DOP + blank prompt preservation ────────────
  if (train?.diff_output_preservation && train?.blank_prompt_preservation) {
    errors.push(
      'Cannot use both Differential Output Preservation and Blank Prompt Preservation at the same time. Disable one of them.'
    );
  }

  // ─── Bypass guidance + guidance loss ──────────────────────────────
  // Python field is do_guidance_loss; TS type may use do_differential_guidance
  const doGuidanceLoss = (train as any)?.do_guidance_loss || train?.do_differential_guidance;
  if (train?.bypass_guidance_embedding && doGuidanceLoss) {
    errors.push(
      'Cannot bypass guidance embedding and use guidance loss at the same time. Disable one of them.'
    );
  }

  // ─── Accuracy Recovery Adapter + Assistant LoRA ───────────────────
  if (model?.model_kwargs?.accuracy_recovery_adapter && model?.assistant_lora_path) {
    errors.push(
      'Cannot use an Accuracy Recovery Adapter and an Assistant LoRA at the same time. Remove one of them.'
    );
  }

  // ─── Unload text encoder + train text encoder ─────────────────────
  if (train?.unload_text_encoder && train?.train_text_encoder) {
    errors.push(
      'Cannot unload the text encoder while also training it. Disable one of these settings.'
    );
  }

  // ─── qwen_image_edit specific ─────────────────────────────────────
  if (model?.arch === 'qwen_image_edit') {
    if (train?.unload_text_encoder) {
      errors.push(
        'Cannot unload text encoder with qwen_image_edit model. Control images are encoded with text embeddings. You can cache text embeddings instead.'
      );
    }
  }

  // ─── Cache text embeddings consistency ────────────────────────────
  if (train?.cache_text_embeddings && datasets && datasets.length > 0) {
    // If using the per-dataset cache_text_embeddings field, all must match
    const hasPerDatasetCaching = datasets.some(
      (d: any) => d.cache_text_embeddings !== undefined
    );
    if (hasPerDatasetCaching) {
      const allCached = datasets.every((d: any) => d.cache_text_embeddings);
      if (!allCached) {
        errors.push(
          'When caching text embeddings, all datasets must have cache_text_embeddings enabled.'
        );
      }
    }
  }

  // ─── Save format validation ───────────────────────────────────────
  if (process.save?.save_format && !['safetensors', 'diffusers'].includes(process.save.save_format)) {
    errors.push(
      `Save format must be "safetensors" or "diffusers", got "${process.save.save_format}".`
    );
  }

  // ─── Warnings (non-blocking but helpful) ──────────────────────────
  if (train?.diff_output_preservation && !train?.diff_output_preservation_class) {
    warnings.push(
      'Differential Output Preservation is enabled but no preservation class is set. Consider setting a class (e.g. "person").'
    );
  }

  if (train?.steps && train.steps < 1) {
    errors.push('Training steps must be at least 1.');
  }

  if (train?.lr && train.lr <= 0) {
    errors.push('Learning rate must be greater than 0.');
  }

  if (train?.lr_scheduler === 'cosine_with_restarts') {
    const numCycles = train?.lr_scheduler_params?.num_cycles;
    if (numCycles !== undefined && numCycles < 1) {
      errors.push('Cosine With Restarts requires cycles to be at least 1.');
    }
  }

  if (train?.batch_size && train.batch_size < 1) {
    errors.push('Batch size must be at least 1.');
  }

  if (!datasets || datasets.length === 0) {
    errors.push('At least one dataset must be configured.');
  } else {
    for (let i = 0; i < datasets.length; i++) {
      if (!datasets[i].folder_path || datasets[i].folder_path === '/path/to/images/folder') {
        errors.push(`Dataset ${i + 1}: folder path is not configured.`);
      }
    }
  }

  if (network && network.linear < 1) {
    errors.push('Network rank (linear) must be at least 1.');
  }

  return { errors, warnings };
}

/**
 * Format validation results into a user-friendly message string.
 */
export function formatValidationMessage(result: ValidationResult): string {
  const parts: string[] = [];

  if (result.errors.length > 0) {
    parts.push('ERRORS (job will fail):');
    result.errors.forEach((e, i) => parts.push(`  ${i + 1}. ${e}`));
  }

  if (result.warnings.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push('WARNINGS:');
    result.warnings.forEach((w, i) => parts.push(`  ${i + 1}. ${w}`));
  }

  return parts.join('\n');
}
