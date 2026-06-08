import json

from toolkit.basic import flush
from toolkit.print import print_acc


class LiveControlManager:
    def __init__(self, trainer):
        self.trainer = trainer

    def should_stop(self):
        if not self.trainer.is_ui_trainer:
            return False

        def _check_stop():
            with self.trainer._db_connect() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT stop FROM Job WHERE id = ?", (self.trainer.job_id,)
                )
                stop = cursor.fetchone()
                return False if stop is None else stop[0] == 1

        return self.trainer._retry_db_operation(_check_stop)

    def should_return_to_queue(self):
        if not self.trainer.is_ui_trainer:
            return False

        def _check_return_to_queue():
            with self.trainer._db_connect() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT return_to_queue FROM Job WHERE id = ?", (self.trainer.job_id,)
                )
                return_to_queue = cursor.fetchone()
                return False if return_to_queue is None else return_to_queue[0] == 1

        return self.trainer._retry_db_operation(_check_return_to_queue)

    def refresh_training_controls(self):
        if not self.trainer.is_ui_trainer:
            return

        def _read_job_config():
            with self.trainer._db_connect() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT job_config FROM Job WHERE id = ?", (self.trainer.job_id,)
                )
                row = cursor.fetchone()
                return None if row is None else row[0]

        try:
            job_config_raw = self.trainer._retry_db_operation(_read_job_config)
            if not job_config_raw:
                return
            job_config = json.loads(job_config_raw)
            live_step_pause_seconds = (
                job_config.get("config", {})
                .get("process", [{}])[0]
                .get("train", {})
                .get("step_pause_seconds", self.trainer.train_config.step_pause_seconds)
            )
            self.trainer.train_config.step_pause_seconds = max(0.0, float(live_step_pause_seconds))
        except Exception:
            pass

    def maybe_stop(self):
        if not self.trainer.is_ui_trainer:
            return
        if self.should_stop():
            self.trainer._run_async_operation(
                self.trainer._update_status("stopped", "Job stopped")
            )
            self.trainer.is_stopping = True
            raise Exception("Job stopped")
        if self.should_return_to_queue():
            self.trainer._run_async_operation(
                self.trainer._update_status("queued", "Job queued")
            )
            self.trainer.is_stopping = True
            raise Exception("Job returning to queue")

    def should_save(self):
        if not self.trainer.is_ui_trainer:
            return False

        def _check_save():
            with self.trainer._db_connect() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT save_now FROM Job WHERE id = ?", (self.trainer.job_id,)
                )
                save_now = cursor.fetchone()
                return False if save_now is None else save_now[0] == 1

        return self.trainer._retry_db_operation(_check_save)

    def maybe_save(self):
        if not self.trainer.is_ui_trainer:
            return
        if self.should_save():
            self.trainer.update_db_key("save_now", 0)
            if self.trainer.progress_bar is not None:
                self.trainer.progress_bar.pause()
            print_acc(f"\nSaving at step {self.trainer.step_num}")
            self.trainer.optimizer.zero_grad()
            self.trainer.save(self.trainer.step_num)
            self.trainer.ensure_params_requires_grad()
            flush()
            if self.trainer.progress_bar is not None:
                self.trainer.progress_bar.unpause()
            self.trainer.save(self.trainer.step_num)