import os
import sys
import sqlite3
from typing import Union, OrderedDict
from dotenv import load_dotenv
# Load the .env file if it exists
load_dotenv()
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = os.getenv("HF_HUB_ENABLE_HF_TRANSFER", "1")
os.environ["NO_ALBUMENTATIONS_UPDATE"] = "1"
seed = None
if "SEED" in os.environ:
    try:
        seed = int(os.environ["SEED"])
    except ValueError:
        print(f"Invalid SEED value: {os.environ['SEED']}. SEED must be an integer.")

sys.path.insert(0, os.getcwd())
# must come before ANY torch or fastai imports
# import toolkit.cuda_malloc

# turn off diffusers telemetry until I can figure out how to make it opt-in
os.environ['DISABLE_TELEMETRY'] = 'YES'

# set torch to trace mode
import torch
    
# check if we have DEBUG_TOOLKIT in env
if os.environ.get("DEBUG_TOOLKIT", "0") == "1":
    torch.autograd.set_detect_anomaly(True)

if seed is not None:
    import random
    import numpy as np
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)

import argparse
from toolkit.job import get_job
from toolkit.config import get_config
from toolkit.accelerator import get_accelerator
from toolkit.print import print_acc, setup_log_to_file

print("[run.py] Initializing toolkit...", file=sys.stderr, flush=True)
accelerator = get_accelerator()
print("[run.py] Accelerator initialized", file=sys.stderr, flush=True)


def print_end_message(jobs_completed, jobs_failed):
    if not accelerator.is_main_process:
        return
    failure_string = f"{jobs_failed} failure{'' if jobs_failed == 1 else 's'}" if jobs_failed > 0 else ""
    completed_string = f"{jobs_completed} completed job{'' if jobs_completed == 1 else 's'}"

    print_acc("")
    print_acc("[run.py] ========================================")
    print_acc("[run.py] FINAL RESULT:")
    if len(completed_string) > 0:
        print_acc(f"[run.py]  - {completed_string}")
    if len(failure_string) > 0:
        print_acc(f"[run.py]  - {failure_string}")
    print_acc("[run.py] ========================================")


def mark_ui_job_error(config_file, name, error_message):
    job_id = os.environ.get('AITK_JOB_ID', None)
    if job_id is None:
        return

    try:
        config = get_config(config_file, name)
        process_configs = config.get('config', {}).get('process', [])
        sqlite_db_path = None
        for process_config in process_configs:
            sqlite_db_path = process_config.get('sqlite_db_path', None)
            if sqlite_db_path:
                break

        if sqlite_db_path is None or not os.path.exists(sqlite_db_path):
            return

        with sqlite3.connect(sqlite_db_path, timeout=10.0) as conn:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE Job SET status = ?, info = ? WHERE id = ?",
                ('error', str(error_message), job_id.strip())
            )
            conn.commit()
    except Exception as db_error:
        print_acc(f"[run.py] Failed to mark UI job as error: {db_error}")


def main():
    print("[run.py] Starting main()", file=sys.stderr, flush=True)
    parser = argparse.ArgumentParser()

    # require at lease one config file
    parser.add_argument(
        'config_file_list',
        nargs='+',
        type=str,
        help='Name of config file (eg: person_v1 for config/person_v1.json/yaml), or full path if it is not in config folder, you can pass multiple config files and run them all sequentially'
    )

    # flag to continue if failed job
    parser.add_argument(
        '-r', '--recover',
        action='store_true',
        help='Continue running additional jobs even if a job fails'
    )

    # flag to continue if failed job
    parser.add_argument(
        '-n', '--name',
        type=str,
        default=None,
        help='Name to replace [name] tag in config file, useful for shared config file'
    )
    
    parser.add_argument(
        '-l', '--log',
        type=str,
        default=None,
        help='Log file to write output to'
    )
    args = parser.parse_args()
    
    print(f"[run.py] Arguments parsed: config_files={args.config_file_list}, log={args.log}, recover={args.recover}", file=sys.stderr, flush=True)
    
    if args.log is not None:
        print_acc(f"[run.py] Setting up logging to file: {args.log}")
        setup_log_to_file(args.log)

    config_file_list = args.config_file_list
    if len(config_file_list) == 0:
        raise Exception("You must provide at least one config file")

    jobs_completed = 0
    jobs_failed = 0

    if accelerator.is_main_process:
        print_acc(f"[run.py] Running {len(config_file_list)} job{'' if len(config_file_list) == 1 else 's'}")
        print_acc(f"[run.py] Job ID: {os.environ.get('AITK_JOB_ID', 'NOT SET')}")
        print_acc(f"[run.py] CUDA_VISIBLE_DEVICES: {os.environ.get('CUDA_VISIBLE_DEVICES', 'NOT SET')}")

    for i, config_file in enumerate(config_file_list, 1):
        try:
            print_acc(f"[run.py] Processing job {i}/{len(config_file_list)}: {config_file}")
            print(f"[run.py] Loading job config from: {config_file}", file=sys.stderr, flush=True)
            
            job = get_job(config_file, args.name)
            
            print_acc(f"[run.py] Job loaded successfully: {job.name}")
            print_acc(f"[run.py] Starting job execution...")
            
            job.run()
            
            print_acc(f"[run.py] Job execution completed successfully")
            print_acc(f"[run.py] Cleaning up job resources...")
            
            job.cleanup()
            
            jobs_completed += 1
            print_acc(f"[run.py] Job {i} completed successfully")
            
        except Exception as e:
            print_acc(f"[run.py] ERROR running job {i}: {str(e)}")
            print(f"[run.py] Exception details: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            import traceback
            print_acc(f"[run.py] Traceback: {traceback.format_exc()}")
            
            jobs_failed += 1
            try:
                if 'job' in locals() and hasattr(job, 'process') and len(job.process) > 0:
                    print_acc(f"[run.py] Calling on_error handler...")
                    job.process[0].on_error(e)
                else:
                    mark_ui_job_error(config_file, args.name, e)
            except Exception as e2:
                print_acc(f"[run.py] Error running on_error handler: {e2}")
            if not args.recover:
                print_end_message(jobs_completed, jobs_failed)
                raise e
        except KeyboardInterrupt as e:
            print_acc(f"[run.py] KeyboardInterrupt caught - stopping job")
            try:
                if 'job' in locals() and hasattr(job, 'process') and len(job.process) > 0:
                    job.process[0].on_error(e)
            except Exception as e2:
                print_acc(f"[run.py] Error running on_error handler: {e2}")
            if not args.recover:
                print_end_message(jobs_completed, jobs_failed)
                raise e
    
    print_end_message(jobs_completed, jobs_failed)
    print(f"[run.py] main() completed", file=sys.stderr, flush=True)


if __name__ == '__main__':
    print("[run.py] Script started", file=sys.stderr, flush=True)
    main()
    print("[run.py] Script finished", file=sys.stderr, flush=True)
