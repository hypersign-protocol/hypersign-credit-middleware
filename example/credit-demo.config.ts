import {
  CreditBalanceProvider,
  CreditSubject,
  defineCreditCatalog,
} from '../src';

export const EXAMPLE_ACCOUNT_ID = 'user_123';
export const EXAMPLE_SUBJECT = {
  appId: EXAMPLE_ACCOUNT_ID,
  appType: 'USER',
  serviceId: 'example-service',
  creditType: 'API_CREDIT',
} as const;

export const BLOCKCHAIN_TRANSACTION_SUBJECT = {
  ...EXAMPLE_SUBJECT,
  creditType: 'BLOCKCHAIN_TXN_CREDIT',
} as const;

export const EXAMPLE_COST = {
  CHEAP: 10,
  EXPENSIVE: 70,
  FAILING: 20,
  BLOCKCHAIN_API: 5,
  BLOCKCHAIN_TRANSACTION: 25,
} as const;

export const EXAMPLE_CREDIT_CATALOG = defineCreditCatalog({
  serviceId: 'example-service',
  version: '1',
  routes: [
    { method: 'GET', path: '/demo/free', charges: [] },
    { method: 'GET', path: '/demo/balance', charges: [] },
    { method: 'GET', path: '/demo/reservations/:reservationId', charges: [] },
    { method: 'POST', path: '/demo/orphan', charges: [] },
    { method: 'POST', path: '/demo/deferred', charges: [] },
    {
      method: 'POST',
      path: '/demo/blockchain-operation',
      charges: [
        { id: 'api', creditType: 'API_CREDIT', amount: EXAMPLE_COST.BLOCKCHAIN_API },
        {
          id: 'blockchain-transaction',
          creditType: 'BLOCKCHAIN_TXN_CREDIT',
          amount: EXAMPLE_COST.BLOCKCHAIN_TRANSACTION,
          settlementMode: 'DEFERRED',
          autoRecover: false,
        },
      ],
    },
    { method: 'POST', path: '/demo/deferred/:reservationId/commit', charges: [] },
    { method: 'POST', path: '/demo/deferred/:reservationId/rollback', charges: [] },
    { method: 'GET', path: '/demo/provider-calls', charges: [] },
    { method: 'POST', path: '/demo/recover', charges: [] },
    {
      method: 'POST', path: '/demo/cheap', boundary: true,
      charges: [{ id: 'api', creditType: 'API_CREDIT', amount: EXAMPLE_COST.CHEAP }],
    },
    {
      method: 'POST', path: '/demo/expensive',
      charges: [{ id: 'api', creditType: 'API_CREDIT', amount: EXAMPLE_COST.EXPENSIVE }],
    },
    {
      method: 'POST', path: '/demo/fail',
      charges: [{ id: 'api', creditType: 'API_CREDIT', amount: EXAMPLE_COST.FAILING }],
    },
  ],
});

const walletId = (subject: CreditSubject): string =>
  [
    subject.tenantId ?? '',
    subject.appType ?? '',
    subject.appId,
    subject.serviceId ?? '',
    subject.creditType ?? '',
  ].join(':');

export class ExampleBalanceProvider implements CreditBalanceProvider {
  calls = 0;
  private readonly balances = new Map<string, number>([
    [walletId(EXAMPLE_SUBJECT), 0],
    [walletId(BLOCKCHAIN_TRANSACTION_SUBJECT), 0],
  ]);

  async getBalance(subject: CreditSubject) {
    this.calls++;
    return {
      balance: this.balances.get(walletId(subject)) ?? 0,
      source: 'example-authoritative-store',
    };
  }
}

export const exampleBalanceProvider = new ExampleBalanceProvider();
