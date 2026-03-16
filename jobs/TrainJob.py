import json
import os

from jobs import BaseJob
from toolkit.kohya_model_util import load_models_from_stable_diffusion_checkpoint
from collections import OrderedDict
from typing import List
from jobs.process import BaseExtractProcess, TrainFineTuneProcess
from datetime import datetime


process_dict = {
    'vae': 'TrainVAEProcess',
    'slider': 'TrainSliderProcess',
    'slider_old': 'TrainSliderProcessOld',
    'lora_hack': 'TrainLoRAHack',
    'rescale_sd': 'TrainSDRescaleProcess',
    'esrgan': 'TrainESRGANProcess',
    'reference': 'TrainReferenceProcess',
}


class TrainJob(BaseJob):

    def __init__(self, config: OrderedDict):
        super().__init__(config)
        print(f"[TrainJob] Initializing TrainJob: {self.name}")
        self.training_folder = self.get_conf('training_folder', required=True)
        self.is_v2 = self.get_conf('is_v2', False)
        self.device = self.get_conf('device', 'cpu')
        # self.gradient_accumulation_steps = self.get_conf('gradient_accumulation_steps', 1)
        # self.mixed_precision = self.get_conf('mixed_precision', False)  # fp16
        self.log_dir = self.get_conf('log_dir', None)

        print(f"[TrainJob] Training folder: {self.training_folder}")
        print(f"[TrainJob] Device: {self.device}")
        print(f"[TrainJob] Is V2: {self.is_v2}")

        # loads the processes from the config
        print(f"[TrainJob] Loading processes...")
        self.load_processes(process_dict)


    def run(self):
        super().run()
        print("")
        print(f"[TrainJob] Starting execution of {len(self.process)} process{'' if len(self.process) == 1 else 'es'}")

        for i, process in enumerate(self.process, 1):
            print(f"[TrainJob] Executing process {i}/{len(self.process)}: {type(process).__name__}")
            try:
                process.run()
                print(f"[TrainJob] Process {i}/{len(self.process)} completed successfully")
            except Exception as e:
                print(f"[TrainJob] ERROR in process {i}/{len(self.process)}: {str(e)}")
                raise
        
        print(f"[TrainJob] All {len(self.process)} process(es) completed successfully")
