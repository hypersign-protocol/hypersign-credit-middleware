import { Injectable, Logger } from '@nestjs/common';
import { CreditService } from './credit.service';

/**
 * Stateless recovery entry point. The library intentionally does not schedule
 * this method; invoke it from a dedicated worker, cron job, or external
 * scheduler so recovery continues when API instances are unavailable.
 */
@Injectable()
export class CreditRecoveryService {
  private readonly logger = new Logger(CreditRecoveryService.name);
  private running = false;

  constructor(private readonly credits: CreditService) {}

  async runOnce(): Promise<number> {
    // Prevent overlapping passes within one worker process. Redis Lua still
    // guarantees correctness when several different workers run concurrently.
    if (this.running) return 0;
    this.running = true;
    try {
      const recovered = await this.credits.recoverExpired();
      if (recovered > 0) {
        this.logger.warn(`Recovered ${recovered} expired credit reservation(s)`);
      }
      return recovered;
    } catch (error) {
      this.logger.error('Credit reservation recovery failed', error);
      throw error;
    } finally {
      this.running = false;
    }
  }
}
