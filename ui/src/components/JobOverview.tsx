import { JobWithPowerSummary, PowerUsageSummary } from '@/types';
import useGPUInfo from '@/hooks/useGPUInfo';
import useCPUInfo from '@/hooks/useCPUInfo';
import GPUWidget from '@/components/GPUWidget';
import CPUWidget from '@/components/CPUWidget';
import FilesWidget from '@/components/FilesWidget';
import { getTotalSteps } from '@/utils/jobs';
import { Cpu, HardDrive, Info, Gauge } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import useJobLog from '@/hooks/useJobLog';
import { apiClient } from '@/utils/api';

interface JobOverviewProps {
  job: JobWithPowerSummary;
}

const MAX_THROTTLE_DELAY_SECONDS = 0.25;

function getCurrentStepPauseSeconds(job: JobWithPowerSummary) {
  try {
    const jobConfig = JSON.parse(job.job_config);
    const value = jobConfig?.config?.process?.[0]?.train?.step_pause_seconds ?? 0;
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? Math.max(0, numericValue) : 0;
  } catch {
    return 0;
  }
}

function stepPauseSecondsToPowerPercent(stepPauseSeconds: number) {
  const clampedDelay = Math.min(MAX_THROTTLE_DELAY_SECONDS, Math.max(0, stepPauseSeconds));
  return Math.round(((MAX_THROTTLE_DELAY_SECONDS - clampedDelay) / MAX_THROTTLE_DELAY_SECONDS) * 100);
}

function powerPercentToStepPauseSeconds(powerPercent: number) {
  const clampedPercent = Math.min(100, Math.max(0, powerPercent));
  const delay = ((100 - clampedPercent) / 100) * MAX_THROTTLE_DELAY_SECONDS;
  return Math.round(delay * 1000) / 1000;
}

function formatProjectedCost(summary: PowerUsageSummary, currentStep: number, totalSteps: number) {
  if (summary.estimatedCost == null) {
    return '';
  }

  if (!Number.isFinite(currentStep) || !Number.isFinite(totalSteps) || currentStep <= 0 || totalSteps <= 0) {
    return '';
  }

  const safeCurrentStep = Math.min(currentStep, totalSteps);
  if (safeCurrentStep <= 0) {
    return '';
  }

  const estimatedTotalCost = (summary.estimatedCost / safeCurrentStep) * totalSteps;
  if (!Number.isFinite(estimatedTotalCost) || estimatedTotalCost < 0 || estimatedTotalCost > 1_000_000_000) {
    return '';
  }

  return ` (estimating ${summary.currency ? `${summary.currency} ` : ''}${estimatedTotalCost.toFixed(2)} for ${totalSteps} steps)`;
}

function formatPowerSummary(summary: PowerUsageSummary | null | undefined, currentStep: number, totalSteps: number, jobStatus: string) {
  if (!summary || summary.sampleCount <= 0) {
    return null;
  }

  const averagePower = Math.round(summary.averagePowerW);
  const peakPower = Math.round(summary.peakPowerW);
  const energyKwh = summary.totalEnergyWh / 1000;
  const costText =
    summary.estimatedCost != null
      ? ` | Cost ${summary.currency ? `${summary.currency} ` : ''}${summary.estimatedCost.toFixed(2)}`
      : '';
  const projectedCostText =
    jobStatus === 'running' || jobStatus === 'queued' || jobStatus === 'stopping'
      ? formatProjectedCost(summary, currentStep, totalSteps)
      : '';

  return `Avg ${averagePower} W | Peak ${peakPower} W | ${energyKwh.toFixed(2)} kWh${costText}${projectedCostText}`;
}

export default function JobOverview({ job }: JobOverviewProps) {
  const currentStepPauseSeconds = useMemo(() => getCurrentStepPauseSeconds(job), [job]);
  const gpuIds = useMemo(() => {
    if (job.gpu_ids === 'mps') {
      return [0]; // For MPS, we can just return a single GPU ID since it's virtualized
    }
    return job.gpu_ids.split(',').map(id => parseInt(id));
  }, [job.gpu_ids]);
  const { log, setLog, status: statusLog, refresh: refreshLog } = useJobLog(job.id, 2000);
  const logRef = useRef<HTMLDivElement>(null);
  const lastSavedPowerPercentRef = useRef(stepPauseSecondsToPowerPercent(currentStepPauseSeconds));
  // Track whether we should auto-scroll to bottom
  const [isScrolledToBottom, setIsScrolledToBottom] = useState(true);
  console.log('job.gpu_ids', job.gpu_ids);
  const { gpuList, isGPUInfoLoaded } = useGPUInfo(gpuIds, 5000);
  const { cpuInfo, isCPUInfoLoaded } = useCPUInfo(5000);
  const totalSteps = getTotalSteps(job);
  const progress = (job.step / totalSteps) * 100;
  const isStopping = job.stop && job.status === 'running';
  const powerSummaryText = formatPowerSummary(job.powerSummary, job.step, totalSteps, job.status);
  const liveThrottleEnabled = ['running', 'queued', 'stopping'].includes(job.status);
  const [powerPercent, setPowerPercent] = useState(stepPauseSecondsToPowerPercent(currentStepPauseSeconds));
  const [isDraggingThrottle, setIsDraggingThrottle] = useState(false);
  const [isSavingThrottle, setIsSavingThrottle] = useState(false);
  const [throttleError, setThrottleError] = useState<string | null>(null);

  const logLines: string[] = useMemo(() => {
    // split at line breaks on \n or \r\n but not \r
    let splits: string[] = log.split(/\n|\r\n/);

    splits = splits.map(line => {
      return line.split(/\r/).pop();
    }) as string[];

    // only return last 100 lines max
    const maxLines = 1000;
    if (splits.length > maxLines) {
      splits = splits.slice(splits.length - maxLines);
    }

    return splits;
  }, [log]);

  // Handle scroll events to determine if user has scrolled away from bottom
  const handleScroll = () => {
    if (logRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = logRef.current;
      // Consider "at bottom" if within 10 pixels of the bottom
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 10;
      setIsScrolledToBottom(isAtBottom);
    }
  };

  // Auto-scroll to bottom only if we were already at the bottom
  useEffect(() => {
    if (logRef.current && isScrolledToBottom) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log, isScrolledToBottom]);

  useEffect(() => {
    if (!isDraggingThrottle) {
      const nextPowerPercent = stepPauseSecondsToPowerPercent(currentStepPauseSeconds);
      setPowerPercent(nextPowerPercent);
      lastSavedPowerPercentRef.current = nextPowerPercent;
    }
  }, [currentStepPauseSeconds, isDraggingThrottle]);

  const saveThrottle = async (nextPowerPercent: number) => {
    if (!liveThrottleEnabled) {
      return;
    }

    if (lastSavedPowerPercentRef.current === nextPowerPercent) {
      return;
    }

    setIsSavingThrottle(true);
    setThrottleError(null);
    try {
      await apiClient.patch(`/api/jobs/${job.id}/throttle`, {
        powerPercent: nextPowerPercent,
      });
      lastSavedPowerPercentRef.current = nextPowerPercent;
    } catch (error) {
      console.error('Error updating live throttle:', error);
      setThrottleError('Failed to update throttle');
    } finally {
      setIsSavingThrottle(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'running':
        return 'bg-emerald-500/10 text-emerald-500';
      case 'stopping':
        return 'bg-amber-500/10 text-amber-500';
      case 'stopped':
        return 'bg-gray-500/10 text-gray-400';
      case 'completed':
        return 'bg-blue-500/10 text-blue-500';
      case 'error':
        return 'bg-rose-500/10 text-rose-500';
      default:
        return 'bg-gray-500/10 text-gray-400';
    }
  };

  const jobType = job?.job_type || 'unknown';

  let status = job.status;
  if (isStopping) {
    status = 'stopping';
  }

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
      {/* Job Information Panel */}
      <div className="col-span-2 bg-gray-900 rounded-xl shadow-lg overflow-hidden border border-gray-800 flex flex-col">
        <div className="bg-gray-800 px-4 py-3 flex items-center justify-between">
          <h2 className="text-gray-100">
            <Info className="w-5 h-5 mr-2 -mt-1 text-amber-600 dark:text-amber-400 inline-block" /> {job.info}
          </h2>
          <span className={`px-3 py-1 rounded-full text-sm ${getStatusColor(job.status)}`}>{job.status}</span>
        </div>

        <div className="p-4 space-y-6 flex flex-col flex-grow">
          {/* Progress Bar */}
          {job.job_type === 'train' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Progress</span>
                <span className="text-gray-200">
                  Step {job.step} of {totalSteps}
                </span>
              </div>
              <div className="w-full bg-gray-800 rounded-full h-2">
                <div className="h-2 rounded-full bg-blue-500 transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {/* Job Info Grid */}
          <div className="grid gap-4 grid-cols-1 md:grid-cols-3">
            <div className="flex items-center space-x-4">
              <HardDrive className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              <div>
                <p className="text-xs text-gray-400">Job Name</p>
                <p className="text-sm font-medium text-gray-200">{job.name}</p>
                {powerSummaryText ? (
                  <p className="text-xs text-gray-400 mt-1">{powerSummaryText}</p>
                ) : null}
              </div>
            </div>

            <div className="flex items-center space-x-4">
              <Cpu className="w-5 h-5 text-purple-600 dark:text-purple-400" />
              <div>
                <p className="text-xs text-gray-400">Assigned GPUs</p>
                <p className="text-sm font-medium text-gray-200">GPUs: {job.gpu_ids}</p>
              </div>
            </div>

            <div className="flex items-center space-x-4">
              <Gauge className="w-5 h-5 text-green-600 dark:text-green-400" />
              <div>
                <p className="text-xs text-gray-400">Speed</p>
                <p className="text-sm font-medium text-gray-200">{job.speed_string == '' ? '?' : job.speed_string}</p>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-gray-800 bg-gray-950 p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-gray-200">Training Power</p>
                <p className="text-xs text-gray-400">
                  0% adds {MAX_THROTTLE_DELAY_SECONDS.toFixed(2)}s delay per step. 100% means no throttling.
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm font-medium text-gray-200">{powerPercent}%</p>
                <p className="text-xs text-gray-400">{powerPercentToStepPauseSeconds(powerPercent).toFixed(2)}s delay</p>
              </div>
            </div>
            <div className="pt-3">
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={powerPercent}
                disabled={!liveThrottleEnabled || isSavingThrottle}
                onMouseDown={() => setIsDraggingThrottle(true)}
                onTouchStart={() => setIsDraggingThrottle(true)}
                onChange={event => setPowerPercent(Number(event.target.value))}
                onMouseUp={async event => {
                  setIsDraggingThrottle(false);
                  await saveThrottle(Number((event.target as HTMLInputElement).value));
                }}
                onTouchEnd={async event => {
                  setIsDraggingThrottle(false);
                  await saveThrottle(Number((event.target as HTMLInputElement).value));
                }}
                onKeyUp={async event => {
                  await saveThrottle(Number((event.target as HTMLInputElement).value));
                }}
                onBlur={async event => {
                  setIsDraggingThrottle(false);
                  await saveThrottle(Number((event.target as HTMLInputElement).value));
                }}
                className="w-full accent-blue-500 disabled:opacity-50"
              />
              <div className="mt-2 flex justify-between text-[11px] text-gray-500">
                <span>Max throttle</span>
                <span>No throttle</span>
              </div>
              {!liveThrottleEnabled ? (
                <p className="mt-2 text-xs text-gray-500">Available while the job is running or queued.</p>
              ) : null}
              {isSavingThrottle ? <p className="mt-2 text-xs text-gray-400">Updating throttle...</p> : null}
              {throttleError ? <p className="mt-2 text-xs text-rose-400">{throttleError}</p> : null}
            </div>
          </div>

          {/* Log - Now using flex-grow to fill remaining space */}
          <div className="bg-gray-950 rounded-lg p-4 relative flex-grow min-h-60">
            <div
              ref={logRef}
              className="text-xs text-gray-300 absolute inset-0 p-4 overflow-y-auto"
              onScroll={handleScroll}
            >
              {statusLog === 'loading' && 'Loading log...'}
              {statusLog === 'error' && 'Error loading log'}
              {['success', 'refreshing'].includes(statusLog) && (
                <div>
                  {logLines.map((line, index) => {
                    return <pre key={index}>{line}</pre>;
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* GPU Widget Panel */}
      <div className="col-span-1">
        <div>{isCPUInfoLoaded && cpuInfo && <CPUWidget cpu={cpuInfo} />}</div>
        <div className="mt-4">{isGPUInfoLoaded && gpuList.length > 0 && <GPUWidget gpu={gpuList[0]} />}</div>
        {jobType === 'train' && (
          <div className="mt-4">
            <FilesWidget jobID={job.id} />
          </div>
        )}
      </div>
    </div>
  );
}
