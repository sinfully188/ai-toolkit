import processQueue from './actions/processQueue';
class CronWorker {
  interval: number;
  is_running: boolean;
  intervalId: NodeJS.Timeout;
  loopCount: number = 0;
  
  constructor() {
    this.interval = 1000; // Default interval of 1 second
    this.is_running = false;
    this.intervalId = setInterval(() => {
      this.run();
    }, this.interval);
  }
  async run() {
    if (this.is_running) {
      console.debug(`[CronWorker] Loop ${this.loopCount} already running, skipping iteration`);
      return;
    }
    this.is_running = true;
    this.loopCount++;
    try {
      const startTime = Date.now();
      console.log(`[CronWorker] Starting loop iteration #${this.loopCount}`);
      // Loop logic here
      await this.loop();
      const duration = Date.now() - startTime;
      console.log(`[CronWorker] Loop iteration #${this.loopCount} completed in ${duration}ms`);
    } catch (error) {
      console.error(`[CronWorker] Error in loop iteration #${this.loopCount}:`, error);
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
