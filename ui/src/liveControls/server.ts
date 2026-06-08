import { PrismaClient } from '@prisma/client';

export function toStepPauseSeconds(rawPowerPercent: number) {
  const powerPercent = Math.min(100, Math.max(0, Math.round(rawPowerPercent)));
  const stepPauseSeconds = Math.round((((100 - powerPercent) / 100) * 0.25) * 1000) / 1000;
  return { powerPercent, stepPauseSeconds };
}

export async function markJobSaveNow(prisma: PrismaClient, jobID: string) {
  return prisma.job.update({
    where: { id: jobID },
    data: {
      save_now: true,
    },
  });
}

export async function updateJobThrottle(prisma: PrismaClient, jobID: string, rawPowerPercent: number) {
  const { powerPercent, stepPauseSeconds } = toStepPauseSeconds(rawPowerPercent);

  const job = await prisma.job.findUnique({ where: { id: jobID } });
  if (!job) {
    return { error: 'Job not found.', status: 404 as const };
  }

  const jobConfig = JSON.parse(job.job_config);
  if (!jobConfig?.config?.process?.[0]?.train) {
    return { error: 'Job config is missing train settings.', status: 400 as const };
  }

  jobConfig.config.process[0].train.step_pause_seconds = stepPauseSeconds;

  await prisma.job.update({
    where: { id: jobID },
    data: {
      job_config: JSON.stringify(jobConfig),
    },
  });

  return { powerPercent, stepPauseSeconds };
}