# ai-toolkit-job-cli

This command manages ai-toolkit jobs stored in an `aitk_db.db` SQLite database.

It is intended for safe job handoff between machines without syncing or sharing a live SQLite database.

## Script Location

- `/opt/ai-toolkit/scripts/ai-toolkit-job-cli`

Default database:

- `/opt/ai-toolkit/aitk_db.db`

Override the database path with:

```bash
--db /path/to/aitk_db.db
```

## Supported Commands

- `list`
- `export`
- `move`
- `import`
- `delete`
- `mark-stopped`

## Core Idea

Use the CLI to move stopped jobs between machines as JSON.

Recommended workflow:

1. Export or move a job from the source machine DB.
2. Copy the JSON file to the destination machine.
3. Import the JSON file into the destination machine DB.
4. Resume training from the shared NAS output folder.

This is safer than syncing full SQLite DB files between Linux and Windows.

## Commands

### List Jobs

```bash
/opt/ai-toolkit/scripts/ai-toolkit-job-cli list
```

Filter examples:

```bash
/opt/ai-toolkit/scripts/ai-toolkit-job-cli list --status stopped
/opt/ai-toolkit/scripts/ai-toolkit-job-cli list --gpu-ids 0
/opt/ai-toolkit/scripts/ai-toolkit-job-cli list --json
```

### Export One Job

Export leaves the source DB untouched.

```bash
/opt/ai-toolkit/scripts/ai-toolkit-job-cli export \
  --name YourLoRA-JobName.KeyTrigger.v1.wan2.2 \
  /tmp/YourLoRA-JobName.KeyTrigger.v1.wan2.2.json
```

### Move One Job

Move exports the job as JSON and then deletes the row from the source DB.

```bash
/opt/ai-toolkit/scripts/ai-toolkit-job-cli move \
  --id de54d791-694e-49c3-863a-84abe1de8033 \
  /tmp/YourLoRA-JobName.KeyTrigger.v1.wan2.2.json
```

### Import One Job

By default, import resets the imported job to a safe stopped state:

- `status = stopped`
- `stop = 0`
- `return_to_queue = 0`

Example:

```bash
/opt/ai-toolkit/scripts/ai-toolkit-job-cli import \
  /tmp/YourLoRA-JobName.KeyTrigger.v1.wan2.2.json
```

Useful flags:

```bash
--replace
--create-queue
--preserve-status
```

Example:

```bash
/opt/ai-toolkit/scripts/ai-toolkit-job-cli import \
  /tmp/YourLoRA-JobName.KeyTrigger.v1.wan2.2.json \
  --replace \
  --create-queue
```

### Delete One Job

Delete removes only the job row from the DB.

It does not delete checkpoints, output folders, or training artifacts on disk.

```bash
/opt/ai-toolkit/scripts/ai-toolkit-job-cli delete \
  --name YourLoRA-JobName.KeyTrigger.v1.wan2.2
```

### Mark One Job Stopped

This is the intended repair command for stale `running` jobs.

```bash
/opt/ai-toolkit/scripts/ai-toolkit-job-cli mark-stopped \
  --id de54d791-694e-49c3-863a-84abe1de8033
```

You can customize the info string:

```bash
/opt/ai-toolkit/scripts/ai-toolkit-job-cli mark-stopped \
  --id de54d791-694e-49c3-863a-84abe1de8033 \
  --info "Marked stopped after source machine shutdown"
```

## PID Safety Rules

The CLI checks for a `pid.txt` file under:

- `<training_folder>/<job_name>/pid.txt`

If `pid.txt` exists, the CLI:

1. reads the PID
2. checks whether that PID is alive
3. inspects the process command line when possible
4. decides whether it still looks like an ai-toolkit process

If the process still looks like a live ai-toolkit job, the CLI refuses to:

- `mark-stopped`
- `move`
- `delete`

unless `--force` is used.

This helps prevent accidentally stopping or deleting a job that is still running.

### Force Override

Use `--force` only when you are sure the recorded process should be ignored.

Examples:

```bash
/opt/ai-toolkit/scripts/ai-toolkit-job-cli mark-stopped \
  --id de54d791-694e-49c3-863a-84abe1de8033 \
  --force
```

```bash
/opt/ai-toolkit/scripts/ai-toolkit-job-cli move \
  --id de54d791-694e-49c3-863a-84abe1de8033 \
  --allow-active \
  --force \
  /tmp/job.json
```

## Active Status Rules

For `move` and `delete`, the CLI also blocks rows whose DB status is:

- `running`
- `stopping`

To override the DB-status guard, use:

```bash
--allow-active
```

This is separate from `--force`.

- `--allow-active` overrides the DB status check
- `--force` overrides the live PID safety check

For a live running job, you may need both flags.

## Export File Format

The exported JSON contains:

- the full `Job` row
- the parsed `job_config`
- the matching `Queue` row, if one exists
- export metadata

This makes the file suitable for machine-to-machine handoff.

## Recommended Handoff Workflow

### Source Machine

1. Stop the job normally, or use `mark-stopped` if the status is stale.
2. Move or export the job:

```bash
/opt/ai-toolkit/scripts/ai-toolkit-job-cli move \
  --id YOUR_JOB_ID \
  /tmp/job.json
```

### Destination Machine

1. Copy `job.json` to the destination machine.
2. Import it:

```bash
/opt/ai-toolkit/scripts/ai-toolkit-job-cli import \
  /tmp/job.json \
  --create-queue
```

3. Requeue or start the job from the destination machine UI.

## Notes

- The CLI manages database rows only.
- It does not move checkpoints or output files.
- Resume state comes from the shared NAS output folder.
- The safest model is moving individual jobs, not syncing whole DB files.