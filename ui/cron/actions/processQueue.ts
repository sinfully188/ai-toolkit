import prisma from '../prisma';

import { Job, Queue } from '@prisma/client';
import startJob from './startJob';

export default async function processQueue() {
  try {
    console.log('[ProcessQueue] Starting queue processing...');
    const queues: Queue[] = await prisma.queue.findMany({
      orderBy: {
        id: 'asc',
      },
    });

    if (queues.length === 0) {
      console.log('[ProcessQueue] No queues found in database. Create a queue before starting jobs.');
      return;
    }

    console.log(`[ProcessQueue] Found ${queues.length} queue(s) to process`);

    for (const queue of queues) {
      console.log(`[ProcessQueue] Processing queue for GPU(s): ${queue.gpu_ids} (is_running: ${queue.is_running})`);

      if (!queue.is_running) {
        console.log(`[ProcessQueue] Queue for GPU(s) ${queue.gpu_ids} is NOT running. Stopping any running jobs...`);
        // stop any running jobs first
        const runningJobs: Job[] = await prisma.job.findMany({
          where: {
            status: 'running',
            gpu_ids: queue.gpu_ids,
          },
        });

        if (runningJobs.length > 0) {
          console.log(`[ProcessQueue] Found ${runningJobs.length} running job(s) to stop`);
          for (const job of runningJobs) {
            console.log(`[ProcessQueue] Stopping job ${job.id} (name: ${job.name}) on GPU(s) ${job.gpu_ids}`);
            await prisma.job.update({
              where: { id: job.id },
              data: {
                return_to_queue: true,
                info: 'Stopping job...',
              },
            });
          }
        } else {
          console.log(`[ProcessQueue] No running jobs found for GPU(s) ${queue.gpu_ids}`);
        }
      }

      if (queue.is_running) {
        console.log(`[ProcessQueue] Queue for GPU(s) ${queue.gpu_ids} IS running. Checking for jobs...`);
        // first see if one is already running, status of running or stopping
        const runningJob: Job | null = await prisma.job.findFirst({
          where: {
            status: { in: ['running', 'stopping'] },
            gpu_ids: queue.gpu_ids,
          },
        });

        if (runningJob) {
          console.log(`[ProcessQueue] Job ${runningJob.id} (${runningJob.name}) is already ${runningJob.status}. Skipping this queue iteration.`);
          // already running, nothing to do
          continue; // skip to next queue
        } else {
          console.log(`[ProcessQueue] No running/stopping jobs found. Looking for next queued job on GPU(s) ${queue.gpu_ids}...`);
          // find the next job in the queue
          const nextJob: Job | null = await prisma.job.findFirst({
            where: {
              status: 'queued',
              gpu_ids: queue.gpu_ids,
            },
            orderBy: {
              queue_position: 'asc',
            },
          });
          if (nextJob) {
            console.log(`[ProcessQueue] Found queued job: ${nextJob.id} (${nextJob.name}). Calling startJob now...`);
            await startJob(nextJob.id);
          } else {
            console.log(`[ProcessQueue] No queued jobs found for GPU(s) ${queue.gpu_ids}. Stopping the queue...`);
            // no more jobs, stop the queue
            await prisma.queue.update({
              where: { id: queue.id },
              data: { is_running: false },
            });
          }
        }
      }
    }
    console.log('[ProcessQueue] Queue processing completed successfully');
  } catch (error) {
    console.error('[ProcessQueue] Error processing queue:', error);
    throw error;
  }
}
