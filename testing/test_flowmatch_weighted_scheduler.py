import torch

from toolkit.samplers.custom_flowmatch_sampler import CustomFlowMatchEulerDiscreteScheduler
from toolkit.timestep_weighing.default_weighing_scheme import default_weighing_scheme


def test_weighted_timesteps_use_weighted_scheme():
    scheduler = CustomFlowMatchEulerDiscreteScheduler(num_train_timesteps=1000)
    scheduler.set_train_timesteps(1000, device="cpu", timestep_type="weighted")

    timesteps = scheduler.timesteps[[0, 25, 100, 500, 999]]
    weights = scheduler.get_weights_for_timesteps(
        timesteps, timestep_type="weighted"
    )

    expected = torch.tensor(
        [default_weighing_scheme[i] for i in [0, 25, 100, 500, 999]],
        dtype=weights.dtype,
    )

    assert torch.allclose(weights.cpu(), expected, atol=1e-6)


if __name__ == "__main__":
    test_weighted_timesteps_use_weighted_scheme()
    print("ok")