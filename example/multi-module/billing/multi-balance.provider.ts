import { CreditBalanceProvider, CreditSubject } from '../../../src';

export const MULTI_MODULE_SUBJECT: CreditSubject = {
  tenantId: 'tenant_1',
  appType: 'BUSINESS',
  appId: 'business_123',
  serviceId: 'kyc',
  creditType: 'API_CREDIT',
};

const subjectKey = (subject: CreditSubject) => JSON.stringify([
  subject.tenantId ?? '', subject.appType ?? '', subject.appId,
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
}

export const multiBalanceProvider = new MultiBalanceProvider();
