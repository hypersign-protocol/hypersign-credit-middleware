import { CreditCatalogService } from '../src/credit.catalog';
import { DEFAULT_CREDIT_OPTIONS } from '../src/credit.constants';
import { CreditPolicyExecutor } from '../src/credit-policy.executor';

describe('CreditPolicyExecutor', () => {
  const options = {
    ...DEFAULT_CREDIT_OPTIONS,
    catalog: {
      catalogId: 'kyc', version: '1', routes: [{
        method: 'POST', path: '/submit', charges: [
          { id: 'api', creditType: 'API', amount: 5 },
          {
            id: 'txn', creditType: 'TXN', amount: 25,
            settlementMode: 'DEFERRED' as const, autoRecover: false,
          },
        ],
      }],
    },
  };
  const catalog = new CreditCatalogService(options);
  const route = catalog.find('POST', '/submit')!;
  const result = (id: string, creditType: string) => ({
    reservationId: id,
    leaseToken: `lease-${id}`,
    scopeId: `scope-${id}`,
    remainingBalance: 50,
    expiresAt: 1_000,
    autoRecover: creditType === 'API',
    existing: false,
    settlementMode: creditType === 'API' ? 'IMMEDIATE' as const : 'DEFERRED' as const,
    subject: { appId: 'account', creditType },
    allocations: [{ planId: `${creditType}-plan`, amount: 5, planBalanceAfter: 45 }],
  });

  it('creates independent catalog reservations with scoped request IDs', async () => {
    const credits = { reserve: jest.fn(), rollback: jest.fn() };
    credits.reserve
      .mockResolvedValueOnce(result('api-res', 'API'))
      .mockResolvedValueOnce(result('txn-res', 'TXN'));
    const executor = new CreditPolicyExecutor(credits as any, catalog);

    const applied = await executor.reserve(route, {
      subject: { appId: 'account' }, requestId: 'request-1',
    });

    expect(applied.map((value) => value.reservation.reservationId))
      .toEqual(['api-res', 'txn-res']);
    expect(credits.reserve).toHaveBeenNthCalledWith(1, expect.objectContaining({
      requestId: 'request-1:api',
      subject: { appId: 'account', creditType: 'API' },
    }));
    expect(credits.reserve).toHaveBeenNthCalledWith(2, expect.objectContaining({
      requestId: 'request-1:txn', settlementMode: 'DEFERRED', autoRecover: false,
    }));
  });

  it('compensates an earlier reservation when a later charge fails', async () => {
    const credits = { reserve: jest.fn(), rollback: jest.fn().mockResolvedValue(true) };
    credits.reserve
      .mockResolvedValueOnce(result('api-res', 'API'))
      .mockRejectedValueOnce(new Error('insufficient TXN'));
    const executor = new CreditPolicyExecutor(credits as any, catalog);

    await expect(executor.reserve(route, {
      subject: { appId: 'account' }, requestId: 'request-1',
    })).rejects.toThrow('insufficient TXN');
    expect(credits.rollback).toHaveBeenCalledWith(
      'api-res', 'catalog_reservation_failed',
    );
  });
});
