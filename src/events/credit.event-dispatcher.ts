import { Inject, Injectable, Logger } from '@nestjs/common';
import { CREDIT_OPTIONS, ResolvedCreditOptions } from '../credit.types';
import { AnyCreditEvent, CreditEventType } from './credit.events';

type HandlerMethodName =
  | 'onReserved'
  | 'onCommitted'
  | 'onRolledBack'
  | 'onExpired'
  | 'onCreditGranted'
  | 'onCriticalBalance'
  | 'onBalanceInitialized';

const EVENT_TO_METHOD: Record<CreditEventType, HandlerMethodName> = {
  RESERVED: 'onReserved',
  COMMITTED: 'onCommitted',
  ROLLED_BACK: 'onRolledBack',
  EXPIRED: 'onExpired',
  CREDIT_GRANTED: 'onCreditGranted',
  CRITICAL_BALANCE: 'onCriticalBalance',
  BALANCE_INITIALIZED: 'onBalanceInitialized',
};

/** Ordered, bounded, best-effort delivery to one in-process event handler. */
@Injectable()
export class CreditEventDispatcher {
  private readonly logger = new Logger(CreditEventDispatcher.name);
  private readonly queue: AnyCreditEvent[] = [];
  private draining = false;
  private scheduled = false;
  private outstanding = 0;

  constructor(
    @Inject(CREDIT_OPTIONS) private readonly options: ResolvedCreditOptions,
  ) {}

  /**
   * Enqueues without blocking the credit operation. Synchronous and async
   * handler failures are caught by `drain`; neither can fail an API request.
   */
  dispatch(event: AnyCreditEvent): void {
    const handler = this.options.eventHandler;
    if (!handler) return;
    const method = EVENT_TO_METHOD[event.type];
    if (typeof handler[method] !== 'function') return;

    if (this.outstanding >= this.options.eventHandlerQueueSize) {
      this.logger.error(
        `Dropping in-process credit event ${event.type}; handler queue is full ` +
        `(capacity=${this.options.eventHandlerQueueSize}, scope=${event.scopeId})`,
      );
      return;
    }
    this.queue.push(event);
    this.outstanding++;
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.draining || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift()!;
        try {
          const handler = this.options.eventHandler;
          if (!handler) continue;
          const method = EVENT_TO_METHOD[event.type];
          const fn = handler[method] as
            | ((value: AnyCreditEvent) => Promise<void> | void)
            | undefined;
          if (typeof fn !== 'function') continue;
          try {
            await fn.call(handler, event);
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(
              `CreditModuleEventHandler.${method} failed for ${event.type} ` +
              `(scope=${event.scopeId}, account=${event.accountId}): ${message}`,
              error instanceof Error ? error.stack : undefined,
            );
          }
        } finally {
          this.outstanding--;
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.length > 0) this.scheduleDrain();
    }
  }
}
