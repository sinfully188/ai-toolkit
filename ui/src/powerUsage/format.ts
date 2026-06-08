import type { PowerUsageSummary } from '@/powerUsage/types';

type ProjectionOptions = {
  currentStep?: number;
  totalSteps?: number;
  jobStatus?: string;
  speedString?: string | null;
};

export function formatEnergy(totalEnergyWh: number) {
  if (!Number.isFinite(totalEnergyWh) || totalEnergyWh < 0) {
    return '';
  }

  if (totalEnergyWh >= 1000) {
    return `${(totalEnergyWh / 1000).toFixed(2)} kWh`;
  }

  if (totalEnergyWh >= 10) {
    return `${totalEnergyWh.toFixed(1)} Wh`;
  }

  return `${totalEnergyWh.toFixed(2)} Wh`;
}

export function formatCurrencyAmount(amount: number, currency: string | null) {
  if (!Number.isFinite(amount) || amount < 0) {
    return '';
  }

  let digits = 2;
  if (amount < 0.01) {
    digits = 4;
  } else if (amount < 0.1) {
    digits = 3;
  }

  return `${currency ? `${currency} ` : ''}${amount.toFixed(digits)}`;
}

function parseSecondsPerIter(speedString: string | null | undefined) {
  const match = speedString?.match(/([0-9]+(?:\.[0-9]+)?)\s*sec\/iter/i);
  if (!match) {
    return null;
  }

  const secondsPerIter = Number.parseFloat(match[1]);
  return Number.isFinite(secondsPerIter) && secondsPerIter > 0 ? secondsPerIter : null;
}

function estimateTrackedSteps(summary: PowerUsageSummary, speedString: string | null | undefined) {
  const secondsPerIter = parseSecondsPerIter(speedString);
  if (secondsPerIter == null || summary.averagePowerW <= 0 || summary.totalEnergyWh <= 0) {
    return null;
  }

  const trackedDurationHours = summary.totalEnergyWh / summary.averagePowerW;
  const trackedSteps = (trackedDurationHours * 3600) / secondsPerIter;
  return Number.isFinite(trackedSteps) && trackedSteps > 0 ? trackedSteps : null;
}

function formatProjectedCost(summary: PowerUsageSummary, options: ProjectionOptions) {
  if (summary.estimatedCost == null) {
    return '';
  }

  const { currentStep, totalSteps, speedString } = options;
  if (!Number.isFinite(totalSteps) || (totalSteps ?? 0) <= 0) {
    return '';
  }

  const trackedSteps = estimateTrackedSteps(summary, speedString);
  let divisor = trackedSteps;

  if (divisor == null) {
    if (!Number.isFinite(currentStep) || (currentStep ?? 0) <= 0) {
      return '';
    }
    divisor = Math.min(currentStep!, totalSteps!);
  }

  const estimatedTotalCost = (summary.estimatedCost / divisor) * totalSteps!;
  if (!Number.isFinite(estimatedTotalCost) || estimatedTotalCost < 0 || estimatedTotalCost > 1_000_000_000) {
    return '';
  }

  return ` (estimating ${formatCurrencyAmount(estimatedTotalCost, summary.currency)} for ${totalSteps} steps)`;
}

export function formatPowerSummary(summary: PowerUsageSummary | null | undefined, options: ProjectionOptions = {}) {
  if (!summary || summary.sampleCount <= 0) {
    return null;
  }

  const averagePower = Math.round(summary.averagePowerW);
  const peakPower = Math.round(summary.peakPowerW);
  const energyText = formatEnergy(summary.totalEnergyWh);
  const costText =
    summary.estimatedCost != null
      ? ` | Cost ${formatCurrencyAmount(summary.estimatedCost, summary.currency)}`
      : '';
  const projectedCostText =
    options.jobStatus === 'running' || options.jobStatus === 'queued' || options.jobStatus === 'stopping'
      ? formatProjectedCost(summary, options)
      : '';

  return `Avg ${averagePower} W | Peak ${peakPower} W | Energy ${energyText}${costText}${projectedCostText}`;
}
