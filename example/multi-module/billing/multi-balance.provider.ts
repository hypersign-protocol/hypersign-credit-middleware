import {
  CreditBalanceProvider,
  CreditCommittedEvent,
  CreditExpiredEvent,
  CreditGrantedEvent,
  CreditModuleEventHandler,
  CreditReservedEvent,
  CreditRolledBackEvent,
  CreditSubject,
} from '../../../src';

export const MULTI_MODULE_SUBJECT: CreditSubject = {
  tenantId: 'tenant_1',
  accountType: 'BUSINESS',
  accountId: 'business_123',
  serviceId: 'kyc',
  creditType: 'API_CREDIT',
};

const subjectKey = (subject: CreditSubject) => JSON.stringify([
  subject.tenantId ?? '', subject.accountType ?? '', subject.accountId,
  subject.serviceId ?? '', subject.creditType ?? '',
]);

export class MultiBalanceProvider implements CreditBalanceProvider {
  private readonly balances = new Map([[subjectKey(MULTI_MODULE_SUBJECT), 100]]);

  async getBalance(subject: CreditSubject) {
    return {
      balance: this.balances.get(subjectKey(subject)) ?? 0,
      source: 'multi-module-authoritative-store',
    };
  }

  adjustBalance(subject: CreditSubject, delta: number): void {
    const key = subjectKey(subject);
    this.balances.set(key, (this.balances.get(key) ?? 0) + delta);
  }

}

export const multiBalanceProvider = new MultiBalanceProvider();

/** Demo mirror only. Production persistence consumes the durable Redis stream. */
export class MultiCreditEventHandler implements CreditModuleEventHandler {
  onReserved(_event: CreditReservedEvent): void {
    // A reservation is a temporary Redis hold, not durable consumption.
  }

  onCommitted(event: CreditCommittedEvent): void {
    multiBalanceProvider.adjustBalance(event.subject, -event.amount);
  }

  onRolledBack(_event: CreditRolledBackEvent): void {
    // Nothing was durably consumed, so the ledger does not need a refund.
  }

  onExpired(_event: CreditExpiredEvent): void {
    // Nothing was durably consumed, so the ledger does not need a refund.
  }

  onCreditGranted(event: CreditGrantedEvent): void {
    multiBalanceProvider.adjustBalance(event.subject, event.amount);
  }
}
