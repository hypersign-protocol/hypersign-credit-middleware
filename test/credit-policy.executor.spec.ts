import { CreditCatalogService } from '../src/credit.catalog';
import { DEFAULT_CREDIT_OPTIONS } from '../src/credit.constants';
import { CreditPolicyExecutor } from '../src/credit-policy.executor';

describe('CreditPolicyExecutor', () => {
  const options = {
    ...DEFAULT_CREDIT_OPTIONS,
    catalog: {
      serviceType: 'kyc', version: '1', routes: [{
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
    environment: 'PROD' as const,
    billingMode: 'ENFORCE' as const,
    existing: false,
    settlementMode: creditType === 'API' ? 'IMMEDIATE' as const : 'DEFERRED' as const,
    subject: { appId: 'account', creditType },
    allocations: [{ planId: `${creditType}-plan`, amount: 5, planBalanceAfter: 45 }],
  });

  it('creates independent PROD reservations with scoped request IDs', async () => {
    const credits = { reserve: jest.fn(), observe: jest.fn(), rollback: jest.fn() };
    credits.reserve
      .mockResolvedValueOnce(result('api-res', 'API'))
      .mockResolvedValueOnce(result('txn-res', 'TXN'));
    const executor = new CreditPolicyExecutor(credits as any, catalog);

    const applied = await executor.apply(route, {
      subject: { appId: 'account' }, requestId: 'request-1', environment: 'PROD',
    });

    expect(applied.map((value) => value.billingMode === 'ENFORCE'
      ? value.reservation.reservationId : 'unexpected'))
      .toEqual(['api-res', 'txn-res']);
    expect(credits.reserve).toHaveBeenNthCalledWith(1, expect.objectContaining({
      requestId: 'request-1:api',
      subject: { appId: 'account', creditType: 'API' },
      environment: 'PROD',
    }));
    expect(credits.reserve).toHaveBeenNthCalledWith(2, expect.objectContaining({
      requestId: 'request-1:txn', settlementMode: 'DEFERRED', autoRecover: false,
    }));
    expect(credits.observe).not.toHaveBeenCalled();
  });

  it('compensates an earlier reservation when a later charge fails', async () => {
    const credits = { reserve: jest.fn(), rollback: jest.fn().mockResolvedValue(true) };
    credits.reserve
      .mockResolvedValueOnce(result('api-res', 'API'))
      .mockRejectedValueOnce(new Error('insufficient TXN'));
    const executor = new CreditPolicyExecutor(credits as any, catalog);

    await expect(executor.apply(route, {
      subject: { appId: 'account' }, requestId: 'request-1', environment: 'PROD',
    })).rejects.toThrow('insufficient TXN');
    expect(credits.rollback).toHaveBeenCalledWith(
      'api-res', 'catalog_reservation_failed',
    );
  });

  it('records DEV observations without reserving, checking, or rolling back credit', async () => {
    const credits = {
      reserve: jest.fn(), rollback: jest.fn(),
      observe: jest.fn()
        .mockResolvedValueOnce(observation('api-event', 'API', 5))
        .mockResolvedValueOnce(observation('txn-event', 'TXN', 25)),
    };
    const executor = new CreditPolicyExecutor(credits as any, catalog);

    const applied = await executor.apply(route, {
      subject: { appId: 'account' }, requestId: 'request-dev', environment: 'DEV',
    });

    expect(applied.map((value) => value.billingMode)).toEqual(['OBSERVE', 'OBSERVE']);
    expect(credits.observe).toHaveBeenNthCalledWith(1, expect.objectContaining({
      requestId: 'request-dev:api', amount: 5, environment: 'DEV',
      subject: { appId: 'account', creditType: 'API' },
    }));
    expect(credits.observe).toHaveBeenNthCalledWith(2, expect.objectContaining({
      requestId: 'request-dev:txn', amount: 25, environment: 'DEV',
      subject: { appId: 'account', creditType: 'TXN' },
    }));
    expect(credits.reserve).not.toHaveBeenCalled();
    await executor.rollbackAll(applied, 'controller failed');
    expect(credits.rollback).not.toHaveBeenCalled();
  });

  it('fails closed when the trusted environment is missing or invalid', async () => {
    const credits = { reserve: jest.fn(), observe: jest.fn() };
    const executor = new CreditPolicyExecutor(credits as any, catalog);

    await expect(executor.apply(route, {
      subject: { appId: 'account' }, environment: undefined as any,
    })).rejects.toThrow('A trusted billing environment is required');
    await expect(executor.apply(route, {
      subject: { appId: 'account' }, environment: 'STAGING' as any,
    })).rejects.toThrow('Billing environment must be PROD or DEV');
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(credits.observe).not.toHaveBeenCalled();
  });

  it('normalizes a trusted lowercase DEV value and rejects boundary mode changes', async () => {
    const credits = {
      reserve: jest.fn(), rollback: jest.fn(),
      observe: jest.fn()
        .mockResolvedValueOnce(observation('api-event', 'API', 5))
        .mockResolvedValueOnce(observation('txn-event', 'TXN', 25)),
    };
    const executor = new CreditPolicyExecutor(credits as any, catalog);
    const applied = await executor.apply(route, {
      subject: { appId: 'account' }, requestId: 'request-dev',
      environment: 'dev' as any,
    });

    await expect(executor.claim(route, {
      subject: { appId: 'account' }, requestId: 'request-dev', environment: 'DEV',
    }, applied)).resolves.toBe(applied);
    await expect(executor.claim(route, {
      subject: { appId: 'account' }, requestId: 'request-dev', environment: 'PROD',
    }, applied)).rejects.toThrow('Early credit reservation does not match');
  });
});

function observation(eventId: string, creditType: string, amount: number) {
  return {
    eventId, requestId: `request-dev:${creditType.toLowerCase()}`,
    scopeId: `scope-${creditType}`, environment: 'DEV' as const,
    billingMode: 'OBSERVE' as const, requestedAmount: amount,
    deductedAmount: 0 as const, existing: false,
    operation: 'POST /submit', subject: { appId: 'account', creditType },
  };
}
