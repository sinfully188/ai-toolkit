from typing import Union, OrderedDict

from toolkit.config import get_config


def get_job(
        config_path: Union[str, dict, OrderedDict],
        name=None
):
    print(f"[toolkit.job] get_job called with config_path: {config_path if isinstance(config_path, str) else type(config_path).__name__}")
    config = get_config(config_path, name)
    print(f"[toolkit.job] Config loaded successfully")
    
    if not config.get('job'):
        raise ValueError('config file is invalid. Missing "job" key')

    job = config['job']
    print(f"[toolkit.job] Job type detected: {job}")
    print(f"[toolkit.job] Job name: {config.get('config', {}).get('name', 'UNKNOWN')}")
    
    if job == 'extract':
        print(f"[toolkit.job] Instantiating ExtractJob")
        from jobs import ExtractJob
        return ExtractJob(config)
    if job == 'train':
        print(f"[toolkit.job] Instantiating TrainJob")
        from jobs import TrainJob
        return TrainJob(config)
    if job == 'mod':
        print(f"[toolkit.job] Instantiating ModJob")
        from jobs import ModJob
        return ModJob(config)
    if job == 'generate':
        print(f"[toolkit.job] Instantiating GenerateJob")
        from jobs import GenerateJob
        return GenerateJob(config)
    if job == 'extension':
        print(f"[toolkit.job] Instantiating ExtensionJob")
        from jobs import ExtensionJob
        return ExtensionJob(config)

    # elif job == 'train':
    #     from jobs import TrainJob
    #     return TrainJob(config)
    else:
        raise ValueError(f'Unknown job type {job}')


def run_job(
        config: Union[str, dict, OrderedDict],
        name=None
):
    print(f"[toolkit.job] run_job called")
    job = get_job(config, name)
    print(f"[toolkit.job] Job retrieved, calling job.run()")
    job.run()
    print(f"[toolkit.job] Job completed, cleaning up")
    job.cleanup()
    print(f"[toolkit.job] Cleanup complete")
