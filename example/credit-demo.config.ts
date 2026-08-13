import {
  CreditBalanceProvider,
  CreditBalanceInitializedEvent,
  CreditCommittedEvent,
  CreditCostOptions,
  CreditCriticalBalanceEvent,
  CreditGrantedEvent,
  CreditExpiredEvent,
  CreditModuleEventHandler,
  CreditReservedEvent,
  CreditRolledBackEvent,
  CreditSubject,
} from '../src';

export const EXAMPLE_ACCOUNT_ID = 'user_123';
export const EXAMPLE_SUBJECT = {
  accountId: EXAMPLE_ACCOUNT_ID,
  accountType: 'USER',
  serviceId: 'example-service',
  creditType: 'API_CREDIT',
} as const;

/** A second wallet for the same customer and service. */
export const BLOCKCHAIN_TRANSACTION_SUBJECT = {
  ...EXAMPLE_SUBJECT,
  creditType: 'BLOCKCHAIN_TXN_CREDIT',
} as const;

/** Shared by the route decorator and the early middleware policy. */
export const CHEAP_CREDIT_POLICY: CreditCostOptions = {
  amount: 10,
  settlementMode: 'IMMEDIATE',
  operation: 'CHEAP_DEMO',
};

/** Charged by the interceptor when the API accepts a blockchain job. */
export const BLOCKCHAIN_API_CREDIT_POLICY: CreditCostOptions = {
  amount: 5,
  settlementMode: 'IMMEDIATE',
  operation: 'SUBMIT_BLOCKCHAIN_TRANSACTION',
};

/** Reserved manually and left for a future worker to settle. */
export const BLOCKCHAIN_TRANSACTION_COST = 25;

const walletId = (subject: CreditSubject): string =>
  [
    subject.tenantId ?? '',
    subject.accountType ?? '',
    subject.accountId,
    subject.serviceId ?? '',
    subject.creditType ?? '',
  ].join(':');

export class ExampleBalanceProvider implements CreditBalanceProvider {
  calls = 0;
  private readonly balances = new Map<string, number>([
    [walletId(EXAMPLE_SUBJECT), 100],
    [walletId(BLOCKCHAIN_TRANSACTION_SUBJECT), 100],
  ]);

  async getBalance(subject: CreditSubject) {
    this.calls++;
    return {
      balance: this.balances.get(walletId(subject)) ?? 0,
      source: 'example-authoritative-store',
    };
  }

  adjustBalance(subject: CreditSubject, delta: number): void {
    const id = walletId(subject);
    this.balances.set(id, (this.balances.get(id) ?? 0) + delta);
  }

}

export const exampleBalanceProvider = new ExampleBalanceProvider();

export class ExampleCreditEventHandler implements CreditModuleEventHandler {
  onReserved(event: CreditReservedEvent): void {
    console.log(
      `[CREDIT] RESERVED account=${event.accountId} amount=${event.amount} ` +
      `remaining=${event.balanceAfter} mode=${event.settlementMode}`,
    );
  }

  onCommitted(event: CreditCommittedEvent): void {
    exampleBalanceProvider.adjustBalance(event.subject, -event.amount);
    console.log(`[CREDIT] COMMITTED reservation=${event.reservationId}`);
  }

  onRolledBack(event: CreditRolledBackEvent): void {
    console.log(
      `[CREDIT] ROLLED_BACK account=${event.accountId} amount=${event.amount} ` +
      `balanceAfter=${event.balanceAfter} reservation=${event.reservationId}`,
    );
  }

  onExpired(event: CreditExpiredEvent): void {
    console.log(
      `[CREDIT] EXPIRED account=${event.accountId} amount=${event.amount} ` +
      `balanceAfter=${event.balanceAfter} reservation=${event.reservationId}`,
    );
  }

  onCriticalBalance(event: CreditCriticalBalanceEvent): void {
    console.warn(
      `[CREDIT] CRITICAL account=${event.accountId} ` +
      `balance=${event.balance} threshold=${event.threshold}`,
    );
  }

  onBalanceInitialized(event: CreditBalanceInitializedEvent): void {
    console.log(`[CREDIT] INITIALIZED account=${event.accountId}`);
  }

  onCreditGranted(event: CreditGrantedEvent): void {
    exampleBalanceProvider.adjustBalance(event.subject, event.amount);
  }
}
