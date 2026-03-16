import prisma from '../prisma';

import { Job, Queue } from '@prisma/client';
import startJob from './startJob';

let loggedNoQueues = false;
const queueStateByGpu = new Map<string, string>();

function logQueueState(gpuIds: string, state: string, message: string) {
  if (queueStateByGpu.get(gpuIds) === state) {
    return;
  }
  queueStateByGpu.set(gpuIds, state);
  console.log(message);
}

export default async function processQueue() {
  try {
    const queues: Queue[] = await prisma.queue.findMany({
      orderBy: {
        id: 'asc',
      },
    });

    if (queues.length === 0) {
      if (!loggedNoQueues) {
        console.log('[ProcessQueue] No queues found in database. Create a queue before starting jobs.');
        loggedNoQueues = true;
      }
      return;
    }
    loggedNoQueues = false;

    for (const queue of queues) {
      if (!queue.is_running) {
        // stop any running jobs first
        const runningJobs: Job[] = await prisma.job.findMany({
          where: {
            status: 'running',
            gpu_ids: queue.gpu_ids,
          },
        });

        if (runningJobs.length > 0) {
          logQueueState(
            queue.gpu_ids,
            `stopping:${runningJobs.length}`,
            `[ProcessQueue] Queue for GPU(s) ${queue.gpu_ids} is stopped. Returning ${runningJobs.length} running job(s) to queue.`
          );
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
          logQueueState(
            queue.gpu_ids,
            'stopped-idle',
            `[ProcessQueue] Queue for GPU(s) ${queue.gpu_ids} is stopped and idle.`
          );
        }
      }

      if (queue.is_running) {
        // first see if one is already running, status of running or stopping
        const runningJob: Job | null = await prisma.job.findFirst({
          where: {
            status: { in: ['running', 'stopping'] },
            gpu_ids: queue.gpu_ids,
          },
        });

        if (runningJob) {
          logQueueState(
            queue.gpu_ids,
            `${runningJob.status}:${runningJob.id}`,
            `[ProcessQueue] Queue for GPU(s) ${queue.gpu_ids} is busy with job ${runningJob.id} (${runningJob.name}) in status ${runningJob.status}.`
          );
          // already running, nothing to do
          continue; // skip to next queue
        } else {
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
            queueStateByGpu.set(queue.gpu_ids, `starting:${nextJob.id}`);
            console.log(`[ProcessQueue] Found queued job: ${nextJob.id} (${nextJob.name}). Calling startJob now...`);
            await startJob(nextJob.id);
          } else {
            logQueueState(
              queue.gpu_ids,
              'empty',
              `[ProcessQueue] No queued jobs found for GPU(s) ${queue.gpu_ids}. Stopping the queue.`
            );
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
  } catch (error) {
    console.error('[ProcessQueue] Error processing queue:', error);
    throw error;
  }
}
