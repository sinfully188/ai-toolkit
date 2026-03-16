import processQueue from './actions/processQueue';
class CronWorker {
  interval: number;
  is_running: boolean;
  intervalId: NodeJS.Timeout;
  
  constructor() {
    this.interval = 1000; // Default interval of 1 second
    this.is_running = false;
    this.intervalId = setInterval(() => {
      this.run();
    }, this.interval);
  }
  async run() {
    if (this.is_running) {
      return;
    }
    this.is_running = true;
    try {
      await this.loop();
    } catch (error) {
      console.error('[CronWorker] Error in queue processing loop:', error);
    }
    this.is_running = false;
  }

  async loop() {
    await processQueue();
  }
}

// it automatically starts the loop
const cronWorker = new CronWorker();
console.log('[CronWorker] Cron worker started with interval:', cronWorker.interval, 'ms. This worker processes the job queue every', cronWorker.interval, 'milliseconds.');
