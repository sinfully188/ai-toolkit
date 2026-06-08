import { apiClient } from '@/utils/api';

export const saveJobNow = (jobID: string) => {
  return new Promise<void>((resolve, reject) => {
    apiClient
      .get(`/api/jobs/${jobID}/save_now`)
      .then(res => res.data)
      .then(data => {
        console.log('Job set to save on next step:', data);
        resolve();
      })
      .catch(error => {
        console.error('Error setting job to save on next step:', error);
        reject(error);
      });
  });
};

export const updateLiveThrottle = async (jobID: string, powerPercent: number) => {
  await apiClient.patch(`/api/jobs/${jobID}/throttle`, {
    powerPercent,
  });
};