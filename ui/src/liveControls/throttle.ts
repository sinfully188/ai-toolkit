import { JobWithPowerSummary } from '@/types';

export const MAX_THROTTLE_DELAY_SECONDS = 0.25;

export function getCurrentStepPauseSeconds(job: JobWithPowerSummary) {
  try {
    const jobConfig = JSON.parse(job.job_config);
    const value = jobConfig?.config?.process?.[0]?.train?.step_pause_seconds ?? 0;
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? Math.max(0, numericValue) : 0;
  } catch {
    return 0;
  }
}

export function stepPauseSecondsToPowerPercent(stepPauseSeconds: number) {
  const clampedDelay = Math.min(MAX_THROTTLE_DELAY_SECONDS, Math.max(0, stepPauseSeconds));
  return Math.round(((MAX_THROTTLE_DELAY_SECONDS - clampedDelay) / MAX_THROTTLE_DELAY_SECONDS) * 100);
}

export function powerPercentToStepPauseSeconds(powerPercent: number) {
  const clampedPercent = Math.min(100, Math.max(0, powerPercent));
  const delay = ((100 - clampedPercent) / 100) * MAX_THROTTLE_DELAY_SECONDS;
  return Math.round(delay * 1000) / 1000;
}