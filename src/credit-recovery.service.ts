import { Injectable, Logger } from '@nestjs/common';
import { CreditEventDispatcher } from './events/credit.event-dispatcher';
import { CreditService } from './credit.service';

/**
 * Stateless recovery entry point. The library intentionally does not schedule
 * this method; invoke it from a dedicated worker, cron job, or external
 * scheduler so recovery continues when API instances are unavailable.
 *
 * After each recovery pass, `EXPIRED` events are dispatched via the configured
 * `CreditModuleEventHandler` so that downstream reconciliation workers and analytics
 * pipelines are notified automatically.
 */
@Injectable()
export class CreditRecoveryService {
  private readonly logger = new Logger(CreditRecoveryService.name);
  private running = false;

  constructor(
    private readonly credits: CreditService,
    private readonly dispatcher: CreditEventDispatcher,
  ) {}

  async runOnce(): Promise<number> {
    // Prevent overlapping passes within one worker process. Redis Lua still
    // guarantees correctness when several different workers run concurrently.
    if (this.running) return 0;
    this.running = true;
    try {
      const recovered = await this.credits.recoverExpired();
      if (recovered.length > 0) {
        this.logger.warn(
          `Recovered ${recovered.length} expired credit reservation(s)`,
        );
        const now = Date.now();
        for (const res of recovered) {
          this.dispatcher.dispatch({
            type: 'EXPIRED',
            timestamp: now,
            subject: res.subject,
            scopeId: res.scopeId,
            accountId: res.accountId,
            tenantId: res.tenantId,
            accountType: res.accountType,
            serviceId: res.serviceId,
            creditType: res.creditType,
            reservationId: res.reservationId,
            amount: res.amount,
            operation: res.operation,
            balanceAfter: res.balanceAfter,
          });
        }
      }
      return recovered.length;
    } catch (error) {
      this.logger.error('Credit reservation recovery failed', error);
      throw error;
    } finally {
      this.running = false;
    }
  }
}
