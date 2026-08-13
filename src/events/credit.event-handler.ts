import {
  CreditBalanceInitializedEvent,
  CreditCommittedEvent,
  CreditCriticalBalanceEvent,
  CreditExpiredEvent,
  CreditGrantedEvent,
  CreditReservedEvent,
  CreditRolledBackEvent,
} from './credit.events';

/**
 * Implement this interface in your application and pass the instance to
 * `CreditModule.forRoot({ eventHandler: myHandler })` to receive real-time
 * credit lifecycle events from the SDK.
 *
 * All methods are optional — implement only the events you care about.
 *
 * The SDK calls handlers asynchronously and **never** awaits the result
 * on the critical path. Errors thrown by a handler are caught, logged,
 * and silently swallowed so that a buggy handler can never fail an API
 * request or block the HTTP response.
 *
 * @example
 * ```ts
 * class MyCreditEvents implements CreditModuleEventHandler {
 *   async onCommitted(event: CreditCommittedEvent) {
 *     await kafka.produce('credit-events', event);
 *   }
 *   async onCriticalBalance(event: CreditCriticalBalanceEvent) {
 *     await pagerDuty.alert(`Low credits: ${event.accountId}`);
 *   }
 *   async onExpired(event: CreditExpiredEvent) {
 *     await reconciliationQueue.push(event);
 *   }
 * }
 *
 * // In your AppModule:
 * CreditModule.forRoot({ eventHandler: new MyCreditEvents() })
 * ```
 */
export interface CreditModuleEventHandler {
  /**
   * Called after a credit reservation is successfully created.
   * Idempotent retries do not emit another handler event.
   */
  onReserved?(event: CreditReservedEvent): Promise<void> | void;

  /**
   * Called after a reservation is committed — the API call succeeded and
   * the credit deduction is permanent.
   */
  onCommitted?(event: CreditCommittedEvent): Promise<void> | void;

  /**
   * Called after a reservation is rolled back — the API call failed and
   * credits were refunded. Use this to feed reconciliation workers or
   * analytics pipelines.
   */
  onRolledBack?(event: CreditRolledBackEvent): Promise<void> | void;

  /**
   * Called by `CreditRecoveryService` after it finds and refunds an expired
   * reservation (typically from a crashed process). Use this to trigger
   * downstream reconciliation.
   */
  onExpired?(event: CreditExpiredEvent): Promise<void> | void;

  onCreditGranted?(event: CreditGrantedEvent): Promise<void> | void;

  /**
   * Called when the remaining balance is at or below `criticalBalance` after
   * a reserve operation. Use this to send low-balance alerts, trigger a
   * top-up flow, or notify billing systems.
   */
  onCriticalBalance?(event: CreditCriticalBalanceEvent): Promise<void> | void;

  /**
   * Called when the SDK consults the authoritative `balanceProvider` and
   * initializes a previously missing scoped Redis wallet.
   */
  onBalanceInitialized?(event: CreditBalanceInitializedEvent): Promise<void> | void;
}
