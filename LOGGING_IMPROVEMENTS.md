# Job Startup Logging Improvements

## Overview
This document outlines the comprehensive logging improvements made to the AI Toolkit to diagnose and resolve job startup issues. The logging system now provides visibility at every stage of the job lifecycle, from queue processing through job execution.

## Critical Logging Blind Spots Identified and Fixed

### 1. **Cron Worker Loop** (`ui/cron/worker.ts`)
**Problem:** No visibility into whether the cron worker was actually executing
**Solution:** Added:
- Loop iteration counting with `[CronWorker]` prefix
- Startup message showing interval (1000ms = 1 second)
- Iteration start/completion logging
- Duration tracking for each loop iteration
- Debug logging when iteration is already running

**Example Output:**
```
[CronWorker] Cron worker started with interval: 1000 ms
[CronWorker] Starting loop iteration #1
[CronWorker] Loop iteration #1 completed in 45ms
[CronWorker] Starting loop iteration #2
```

### 2. **Queue Processing** (`ui/cron/actions/processQueue.ts`)
**Problem:** No logging for queue detection, queue empty states, or job selection logic
**Solution:** Added comprehensive logging for:
- Initial queue discovery (how many queues exist)
- Queue.is_running state for each queue
- Detection of running vs stopped jobs
- Job selection logic and reasons for skipping jobs
- Queue status updates

**Key Log Points:**
```
[ProcessQueue] Starting queue processing...
[ProcessQueue] Found 1 queue(s) to process
[ProcessQueue] Processing queue for GPU(s): 0 (is_running: false)
[ProcessQueue] Queue for GPU(s) 0 is NOT running. Stopping any running jobs...
[ProcessQueue] No running jobs found for GPU(s) 0
[ProcessQueue] No queued jobs found for GPU(s) 0. Stopping the queue...
```

**IMPORTANT:** If you see "No queues found in database", this means:
- Jobs are created but no Queue object exists for the GPU IDs
- You need to create a Queue and set `is_running = true` before jobs will start

### 3. **Job Startup** (`ui/cron/actions/startJob.ts`)
**Problem:** Minimal logging of job startup process, no visibility into file paths or Python process launching
**Solution:** Added detailed logging including:
- Job ID and metadata
- File paths (training folder, log path, config path)
- Virtual environment detection (.venv vs venv)
- Python executable path
- Config file writing
- Process spawn information including:
  - Platform detection (Windows vs Unix)
  - Process ID (PID)
  - Environment variables set
  - CUDA device configuration
- Detachment confirmation

**Example Output:**
```
[StartJob] startJob called with jobID: abc-123-def
[StartJob] Found job in database - Name: training_job_1, GPU: 0
[StartJob] Training folder: /path/to/training/training_job_1
[StartJob] Log file path: /path/to/training/training_job_1/log.txt
[StartJob] Found .venv, using Python at: /opt/ai-toolkit/.venv/bin/python
[StartJob] Spawning Python process...
[StartJob] Process spawned with PID: 45678
[StartJob] Process unreferenced (detached from parent)
```

### 4. **Python Job Execution** (`run.py`)
**Problem:** No startup/completion logging, error messages weren't prefixed, config loading was invisible
**Solution:** Added:
- Script startup logging (stderr for immediate visibility)
- Arguments parsing confirmation
- Log file path confirmation
- Job ID and CUDA device information
- Job loading progress (config parsing, job instantiation)
- Per-job execution progress (1/N, 2/N, etc.)
- Exception details with traceback
- Completion status for each job
- Script completion logging

**Example Output:**
```
[run.py] Script started
[run.py] Initializing toolkit...
[run.py] Accelerator initialized
[run.py] Starting main()
[run.py] Arguments parsed: config_files=['/path/config.json'], log=/path/log.txt
[run.py] Setting up logging to file: /path/log.txt
[run.py] Running 1 job
[run.py] Job ID: job-123-abc
[run.py] CUDA_VISIBLE_DEVICES: 0
[run.py] Processing job 1/1: /path/config.json
[run.py] Loading job config from: /path/config.json
[run.py] Job loaded successfully: my_training_job
[run.py] Starting job execution...
[run.py] All 1 process(es) completed successfully
[run.py] Script finished
```

### 5. **Job Loading and Process Management** (`toolkit/job.py`)
**Problem:** No visibility into job type detection and instantiation
**Solution:** Added:
- Config path logging
- Config load confirmation
- Job type detection
- Specific job class instantiation logging
- run_job tracking

**Example Output:**
```
[toolkit.job] get_job called with config_path: /path/config.json
[toolkit.job] Config loaded successfully
[toolkit.job] Job type detected: train
[toolkit.job] Job name: my_lora_training
[toolkit.job] Instantiating TrainJob
```

### 6. **Job Base Classes** (`jobs/BaseJob.py`, `jobs/TrainJob.py`)
**Problem:** Silent job initialization and process loading
**Solution:** Added:
- Job initialization confirmation
- Process loading progress
- Process type identification for each process
- Process count summary
- Cleanup confirmation

**Example Output:**
```
[BaseJob] Job initialized: my_training_job
[BaseJob] Loading processes...
[BaseJob] Loading process 0: TrainFluxLoRAProcess
[BaseJob] Process 0 (TrainFluxLoRAProcess) loaded successfully
[BaseJob] All 1 process(es) loaded successfully
[TrainJob] Initializing TrainJob: my_training_job
[TrainJob] Training folder: /output/my_training_job
[TrainJob] Device: cuda
[TrainJob] Is V2: False
[TrainJob] Starting execution of 1 process(es)
[TrainJob] Executing process 1/1: TrainFluxLoRAProcess
```

## How to Use the Logs for Debugging

### 1. **Job Not Starting at All**
Check these in order:
1. Look at UI logs for `[CronWorker]` messages - if none appear, cron worker isn't running
2. Look for `[ProcessQueue] Found X queue(s)` - if 0 queues, database needs queue setup
3. Look for `[ProcessQueue] Processing queue for GPU(s)` - see if is_running is properly set
4. Look for `[ProcessQueue] Found queued job` - check if job has status='queued'
5. Look for `[StartJob] Process spawned with PID` - check if Python process launch succeeded

### 2. **Job Starts but No Progress**
1. Check that `log.txt` file is being written to
2. Look for `[StartJob] Log file path:` to find where logs should go
3. Verify file permissions on the training folder
4. Check `[run.py] Job loaded successfully` to confirm Python side started
5. Look for `[TrainJob] Executing process` to see if training process started

### 3. **Job Errors Not Visible**
1. UI should show job status as 'error'
2. Check `job.info` field in database for error message
3. Look in training folder for:
   - `log.txt` - main output log
   - `pid.txt` - process ID (to verify process launched)
   - `logs/` - archived previous logs
4. Check Node.js console for `[StartJob]` error messages

### 4. **Configuration Issues**
Look for:
- `[toolkit.job] Config loaded successfully` - if missing, config file failed to load
- `[toolkit.job] Job type detected: XXX` - confirm correct job type
- `[BaseJob] Missing "config.XXX" key` - required config fields missing
- `[BaseJob] Unknown process type` - process type in config not recognized

## Database Queue Setup

If jobs never start, ensure you have a Queue entry:

```sql
INSERT INTO queue (gpu_ids, is_running) VALUES ('0', true);
```

The queue must have:
- `gpu_ids` matching the job's `gpu_ids` field (must be exact match, e.g., "0", "0,1")
- `is_running` set to `true` for queue processor to check for jobs

## Log File Locations

1. **UI/Node.js Logs:** Check console where you started the Next.js app
2. **Training Logs:** `{training_root}/{job_name}/log.txt`
3. **Previous Training Logs:** `{training_root}/{job_name}/logs/{num}_log.txt`
4. **Archived Config:** `{training_root}/{job_name}/.job_config.json`

## Performance Notes

- Cron worker runs every 1000ms (1 second)
- Each loop iteration logs its duration
- If you see consistently high durations (>1 second), database queries may be slow
- Look for `[CronWorker] Loop N already running` - indicates previous iteration still running

## Summary of Log Prefixes

| Prefix | Component | Purpose |
|--------|-----------|---------|
| `[CronWorker]` | Cron timer loop | Job queue polling schedule |
| `[ProcessQueue]` | Queue processor | Job selection and queue management |
| `[StartJob]` | Job start handler | Python process launching |
| `[run.py]` | Python runner | Job execution lifecycle |
| `[toolkit.job]` | Config loader | Job instantiation |
| `[BaseJob]` | Job base class | Job initialization |
| `[TrainJob]` | Training job | Training-specific execution |

## Testing the Logging System

To test if logging is working:

1. Start the UI and check for `[CronWorker]` messages
2. Queue a job and look for `[ProcessQueue] Found queued job`
3. Watch for `[StartJob] Process spawned with PID`
4. Check training folder for `log.txt` and `pid.txt`
5. Monitor `[run.py]` messages in the console

If you see all these messages appear but job still isn't working, the issue is in the training process itself (Python side), not the job startup system.
