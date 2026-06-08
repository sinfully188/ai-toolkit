import glob
import os
import random
import re
import time
import traceback

import numpy as np
import torch

from toolkit.basic import flush
from toolkit.print import print_acc


class AutoSaveManager:
    AUTOSAVE_PREFIX = 'autosave-'

    def __init__(self, process):
        self.process = process

    def is_enabled(self):
        interval_minutes = getattr(self.process.save_config, 'autosave_every_minutes', 0)
        return interval_minutes is not None and interval_minutes > 0

    def should_run(self):
        if not self.process.accelerator.is_main_process or not self.is_enabled():
            return False
        interval_seconds = float(self.process.save_config.autosave_every_minutes) * 60.0
        return (time.time() - self.process.last_timed_save_time) >= interval_seconds

    def get_save_prefix_from_path(self, path):
        if path is None:
            return ''
        name = os.path.basename(os.path.normpath(path))
        if name.startswith(self.AUTOSAVE_PREFIX):
            return self.AUTOSAVE_PREFIX
        return ''

    def normalize_save_name(self, path):
        name = os.path.basename(os.path.normpath(path))
        if name.startswith(self.AUTOSAVE_PREFIX):
            return name[len(self.AUTOSAVE_PREFIX):]
        return name

    def get_resume_artifact_candidates(self, filename):
        candidates = []
        prefixes = []
        if self.process.resume_save_prefix:
            prefixes.append(self.process.resume_save_prefix)
        prefixes.append('')
        for prefix in prefixes:
            candidate = self.process._make_output_path(filename, prefix)
            if candidate not in candidates:
                candidates.append(candidate)
        return candidates

    def save_resume_training_state(self, save_prefix=''):
        training_state = {
            'step_num': self.process.step_num,
            'start_step': self.process.start_step,
            'epoch_num': self.process.epoch_num,
            'grad_accumulation_step': self.process.grad_accumulation_step,
            'python_random_state': random.getstate(),
            'numpy_random_state': np.random.get_state(),
            'torch_random_state': torch.get_rng_state(),
            'torch_cuda_random_state': torch.cuda.get_rng_state_all() if torch.cuda.is_available() else None,
        }
        training_state_path = self.process._make_output_path('training_state.pt', save_prefix)
        self.process._write_torch_atomic(training_state, training_state_path)

    def load_resume_training_state(self):
        for training_state_path in self.get_resume_artifact_candidates('training_state.pt'):
            if not os.path.exists(training_state_path):
                continue
            try:
                training_state = torch.load(training_state_path, map_location='cpu', weights_only=False)
                if self.process.train_config.start_step is None and 'step_num' in training_state:
                    self.process.step_num = training_state['step_num']
                    self.process.start_step = self.process.step_num
                self.process.epoch_num = training_state.get('epoch_num', self.process.epoch_num)
                self.process.grad_accumulation_step = training_state.get('grad_accumulation_step', self.process.grad_accumulation_step)
                if 'python_random_state' in training_state:
                    random.setstate(training_state['python_random_state'])
                if 'numpy_random_state' in training_state:
                    np.random.set_state(training_state['numpy_random_state'])
                if 'torch_random_state' in training_state:
                    torch.set_rng_state(training_state['torch_random_state'])
                cuda_state = training_state.get('torch_cuda_random_state', None)
                if torch.cuda.is_available() and cuda_state is not None:
                    torch.cuda.set_rng_state_all(cuda_state)
                print_acc(f'Loaded training state from {training_state_path}')
            except Exception as error:
                print_acc(f'Failed to load training state from {training_state_path}')
                print_acc(error)
            break

    def load_resume_scheduler_state(self):
        if self.process.lr_scheduler is None:
            return
        for scheduler_state_path in self.get_resume_artifact_candidates('lr_scheduler.pt'):
            if not os.path.exists(scheduler_state_path):
                continue
            try:
                print_acc(f'Loading lr scheduler state from {scheduler_state_path}')
                scheduler_state = torch.load(scheduler_state_path, map_location='cpu', weights_only=False)
                self.process.lr_scheduler.load_state_dict(scheduler_state)
            except Exception as error:
                print_acc(f'Failed to load lr scheduler state from {scheduler_state_path}')
                print_acc(error)
            break

    def clear_autosave_artifacts(self):
        if not os.path.exists(self.process.save_root):
            return
        for pattern in [
            f'{self.AUTOSAVE_PREFIX}*',
            f'{self.AUTOSAVE_PREFIX}*.tmp',
            f'{self.AUTOSAVE_PREFIX}*.bak',
        ]:
            for item in glob.glob(os.path.join(self.process.save_root, pattern)):
                self.process._remove_path(item)

    def clear_legacy_autosave_step_artifacts(self):
        if not os.path.exists(self.process.save_root):
            return
        legacy_autosave_pattern = re.compile(
            rf'^{re.escape(self.AUTOSAVE_PREFIX)}.+_\d{{9}}(?:$|[._])'
        )
        for pattern in [
            f'{self.AUTOSAVE_PREFIX}*',
            f'{self.AUTOSAVE_PREFIX}*.tmp',
            f'{self.AUTOSAVE_PREFIX}*.bak',
        ]:
            for item in glob.glob(os.path.join(self.process.save_root, pattern)):
                name = os.path.basename(os.path.normpath(item))
                if legacy_autosave_pattern.match(name):
                    self.process._remove_path(item)

    def finalize_save(self, is_autosave, primary_save_path):
        if is_autosave:
            if self.process.lr_scheduler is not None:
                self.process._write_torch_atomic(
                    self.process.lr_scheduler.state_dict(),
                    self.process._make_output_path('lr_scheduler.pt', self.AUTOSAVE_PREFIX)
                )
            self.save_resume_training_state(self.AUTOSAVE_PREFIX)
            self.process._write_yaml_atomic(
                self.process.job.raw_config,
                self.process._make_output_path('config.yaml', self.AUTOSAVE_PREFIX),
            )
            self.clear_legacy_autosave_step_artifacts()
        else:
            self.process.clean_up_saves()
            self.clear_autosave_artifacts()
            self.process.post_save_hook(primary_save_path)

        self.process.last_timed_save_time = time.time()

    def run_timed_autosave(self, optimizer):
        if self.process.progress_bar is not None:
            self.process.progress_bar.pause()
        try:
            print_acc(f"\nAutosaving at step {self.process.step_num}")
            self.process.save(self.process.step_num, save_prefix=self.AUTOSAVE_PREFIX)
            self.process.ensure_params_requires_grad()
            optimizer.zero_grad()
            flush()
            return True
        except Exception as error:
            print_acc(f"Autosave failed at step {self.process.step_num}")
            print_acc(error)
            self.process.last_timed_save_time = time.time()
            traceback.print_exc()
            return False
        finally:
            if self.process.progress_bar is not None:
                self.process.progress_bar.unpause()