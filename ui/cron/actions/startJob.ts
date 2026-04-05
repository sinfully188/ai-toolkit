import prisma from '../prisma';
import { Job } from '@prisma/client';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { TOOLKIT_ROOT, getTrainingFolder, getHFToken } from '../paths';
const isWindows = process.platform === 'win32';

const startAndWatchJob = (job: Job) => {
  // starts and watches the job asynchronously
  return new Promise<void>(async (resolve, reject) => {
    const jobID = job.id;
    console.log(`[StartJob] Starting async job watcher for job ${jobID}`);

    // setup the training
    const trainingRoot = await getTrainingFolder();
    console.log(`[StartJob] Training root: ${trainingRoot}`);

    const trainingFolder = path.join(trainingRoot, job.name);
    console.log(`[StartJob] Training folder: ${trainingFolder}`);
    if (!fs.existsSync(trainingFolder)) {
      console.log(`[StartJob] Creating training folder...`);
      fs.mkdirSync(trainingFolder, { recursive: true });
    }

    // make the config file
    const configPath = path.join(trainingFolder, '.job_config.json');

    //log to path
    const logPath = path.join(trainingFolder, 'log.txt');
    console.log(`[StartJob] Log file path: ${logPath}`);

    try {
      // if the log path exists, move it to a folder called logs and rename it {num}_log.txt, looking for the highest num
      // if the log path does not exist, create it
      if (fs.existsSync(logPath)) {
        console.log(`[StartJob] Previous log file exists, archiving it...`);
        const logsFolder = path.join(trainingFolder, 'logs');
        if (!fs.existsSync(logsFolder)) {
          fs.mkdirSync(logsFolder, { recursive: true });
        }

        let num = 0;
        while (fs.existsSync(path.join(logsFolder, `${num}_log.txt`))) {
          num++;
        }

        fs.renameSync(logPath, path.join(logsFolder, `${num}_log.txt`));
        console.log(`[StartJob] Archived previous log to: ${num}_log.txt`);
      }
    } catch (e) {
      console.error(`[StartJob] Error moving log file:`, e);
    }

    // update the config dataset path
    const jobConfig = JSON.parse(job.job_config);
    jobConfig.config.process[0].sqlite_db_path = path.join(TOOLKIT_ROOT, 'aitk_db.db');

    // write the config file
    console.log(`[StartJob] Writing config file to: ${configPath}`);
    fs.writeFileSync(configPath, JSON.stringify(jobConfig, null, 2));

    let pythonPath = 'python';
    // use .venv or venv if it exists
    if (fs.existsSync(path.join(TOOLKIT_ROOT, '.venv'))) {
      if (isWindows) {
        pythonPath = path.join(TOOLKIT_ROOT, '.venv', 'Scripts', 'python.exe');
      } else {
        pythonPath = path.join(TOOLKIT_ROOT, '.venv', 'bin', 'python');
      }
      console.log(`[StartJob] Found .venv, using Python at: ${pythonPath}`);
    } else if (fs.existsSync(path.join(TOOLKIT_ROOT, 'venv'))) {
      if (isWindows) {
        pythonPath = path.join(TOOLKIT_ROOT, 'venv', 'Scripts', 'python.exe');
      } else {
        pythonPath = path.join(TOOLKIT_ROOT, 'venv', 'bin', 'python');
      }
      console.log(`[StartJob] Found venv, using Python at: ${pythonPath}`);
    } else {
      console.log(`[StartJob] No venv found, using system Python: ${pythonPath}`);
    }

    const runFilePath = path.join(TOOLKIT_ROOT, 'run.py');
    if (!fs.existsSync(runFilePath)) {
      console.error(`[StartJob] CRITICAL ERROR: run.py not found at path: ${runFilePath}`);
      await prisma.job.update({
        where: { id: jobID },
        data: {
          status: 'error',
          info: `Error launching job: run.py not found at ${runFilePath}`,
        },
      });
      return;
    }
    console.log(`[StartJob] Found run.py at: ${runFilePath}`);

    const additionalEnv: any = {
      AITK_JOB_ID: jobID,
      CUDA_DEVICE_ORDER: 'PCI_BUS_ID',
      CUDA_VISIBLE_DEVICES: `${job.gpu_ids}`,
      IS_AI_TOOLKIT_UI: '1',
    };

    // HF_TOKEN
    const hfToken = await getHFToken();
    if (hfToken && hfToken.trim() !== '') {
      additionalEnv.HF_TOKEN = hfToken;
      console.log(`[StartJob] HuggingFace token set`);
    }

    // Add the --log argument to the command
    const args = [runFilePath, configPath, '--log', logPath];
    console.log(`[StartJob] Command args: ${args.join(' ')}`);
    console.log(`[StartJob] Working directory: ${TOOLKIT_ROOT}`);
    console.log(`[StartJob] GPU devices: ${job.gpu_ids}`);

    try {
      console.log(`[StartJob] Spawning Python process...`);
      let subprocess;

      if (isWindows) {
        // Spawn Python directly on Windows so the process can survive parent exit
        console.log(`[StartJob] Using Windows spawn mode`);
        subprocess = spawn(pythonPath, args, {
          env: {
            ...process.env,
            ...additionalEnv,
          },
          cwd: TOOLKIT_ROOT,
          detached: true,
          windowsHide: true,
          stdio: 'ignore', // don't tie stdio to parent
        });
      } else {
        // For non-Windows platforms, fully detach and ignore stdio so it survives daemon-like
        console.log(`[StartJob] Using Unix spawn mode (detached)`);
        subprocess = spawn(pythonPath, args, {
          detached: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            ...additionalEnv,
          },
          cwd: TOOLKIT_ROOT,
        });
      }

      // Save the PID to the database and a file for future management (stop/inspect)
      const pid = subprocess.pid ?? null;
      console.log(`[StartJob] Process spawned with PID: ${pid ?? 'unknown'}`);
      if (pid != null) {
        await prisma.job.update({
          where: { id: jobID },
          data: { pid },
        });
      }

      // Important: let the child run independently of this Node process.
      if (subprocess.unref) {
        subprocess.unref();
        console.log(`[StartJob] Process unreferenced (detached from parent)`);
      }

      // Optionally write a pid file for future management (stop/inspect) without keeping streams open
      try {
        const pidFile = path.join(trainingFolder, 'pid.txt');
        fs.writeFileSync(pidFile, String(pid ?? ''), { flag: 'w' });
        console.log(`[StartJob] PID file written to: ${pidFile}`);
      } catch (e) {
        console.error(`[StartJob] Error writing pid file:`, e);
      }
      // (No stdout/stderr listeners — logging should go to --log handled by your Python)
      // (No monitoring loop — the whole point is to let it live past this worker)
      console.log(`[StartJob] Process successfully spawned and detached. Job should be running.`);
    } catch (error: any) {
      // Handle any exceptions during process launch
      console.error(`[StartJob] CRITICAL ERROR launching process:`, error);

      await prisma.job.update({
        where: { id: jobID },
        data: {
          status: 'error',
          info: `Error launching job: ${error?.message || 'Unknown error'}`,
        },
      });
      return;
    }
    // Resolve the promise immediately after starting the process
    console.log(`[StartJob] Promise resolved, returning control to queue processor`);
    resolve();
  });
};

export default async function startJob(jobID: string) {
  console.log(`[StartJob] startJob called with jobID: ${jobID}`);
  const job: Job | null = await prisma.job.findUnique({
    where: { id: jobID },
  });
  if (!job) {
    console.error(`[StartJob] CRITICAL ERROR: Job with ID ${jobID} not found in database`);
    return;
  }
  console.log(`[StartJob] Found job in database - Name: ${job.name}, GPU: ${job.gpu_ids}`);
  
  // update job status to 'running', this will run sync so we don't start multiple jobs.
  console.log(`[StartJob] Updating job status to 'running'`);
  await prisma.job.update({
    where: { id: jobID },
    data: {
      status: 'running',
      stop: false,
      return_to_queue: false,
      info: 'Starting job...',
    },
  });
  console.log(`[StartJob] Job status updated. Starting async job watcher...`);
  // start and watch the job asynchronously so the cron can continue
  startAndWatchJob(job);
}
