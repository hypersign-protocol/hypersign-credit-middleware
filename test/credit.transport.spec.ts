import { CreditCatalogService } from '../src/credit.catalog';
import { DEFAULT_CREDIT_OPTIONS } from '../src/credit.constants';
import { CreditCommandWorker, CreditEventRelay } from '../src/credit.transport';

const createTransport = () => {
  const provider = { add: jest.fn(), createWorker: jest.fn() };
  const streamClient = {
    xgroup: jest.fn(), xreadgroup: jest.fn(), xautoclaim: jest.fn(), xack: jest.fn(),
  };
  const options = {
    ...DEFAULT_CREDIT_OPTIONS,
    catalog: { serviceId: 'kyc', version: '7', routes: [] },
    bullMq: {
      provider,
      streamClient,
      lifecycleQueueNames: ['credit.lifecycle', 'credit.audit'],
      commandQueueName: 'credit.commands.kyc',
      consumerGroup: 'relay:kyc',
      batchSize: 100,
      blockMs: 5_000,
      pendingIdleMs: 30_000,
    },
  };
  return { provider, streamClient, options };
};

describe('CreditEventRelay', () => {
  it('publishes every destination before acknowledging the Stream event', async () => {
    const { provider, streamClient, options } = createTransport();
    provider.add.mockResolvedValue({});
    const catalog = new CreditCatalogService(options);
    const relay = new CreditEventRelay({ eval: jest.fn() }, options, catalog);

    await (relay as any).publishEntries([[
      '1234-0',
      ['event', 'COMMITTED', 'timestamp', '1234', 'serviceId', 'kyc',
        'accountId', 'a1', 'creditType', 'API', 'amount', '4',
        'balanceAfter', '96', 'reservationId', 'r1'],
    ]]);

    expect(provider.add).toHaveBeenCalledTimes(2);
    expect(provider.add).toHaveBeenCalledWith(
      'credit.lifecycle',
      'credit.committed',
      expect.objectContaining({
        eventId: '1234-0', schemaVersion: 1, catalogVersion: '7',
        event: expect.objectContaining({ amount: 4, balanceAfter: 96 }),
      }),
      { jobId: 'kyc-1234-0' },
    );
    expect(streamClient.xack).toHaveBeenCalledWith(
      DEFAULT_CREDIT_OPTIONS.eventStreamKey, 'relay:kyc', '1234-0',
    );
    expect(provider.add.mock.invocationCallOrder[1])
      .toBeLessThan(streamClient.xack.mock.invocationCallOrder[0]);
  });

  it('does not acknowledge an event when BullMQ publishing fails', async () => {
    const { provider, streamClient, options } = createTransport();
    provider.add.mockRejectedValue(new Error('queue unavailable'));
    const relay = new CreditEventRelay(
      { eval: jest.fn() }, options, new CreditCatalogService(options),
    );
    await expect((relay as any).publishEntries([[
      '1234-0', ['event', 'RESERVED', 'serviceId', 'kyc'],
    ]])).rejects.toThrow('queue unavailable');
    expect(streamClient.xack).not.toHaveBeenCalled();
  });

  it('recreates a consumer group lost during a Redis restart', async () => {
    const { streamClient, options } = createTransport();
    const relay = new CreditEventRelay(
      { eval: jest.fn() }, options, new CreditCatalogService(options),
    );
    streamClient.xgroup.mockResolvedValue('OK');
    streamClient.xautoclaim
      .mockRejectedValueOnce(new Error('NOGROUP No such key or consumer group'))
      .mockResolvedValueOnce(['0-0', []]);
    streamClient.xreadgroup.mockImplementation(async () => {
      (relay as any).running = false;
      return null;
    });
    (relay as any).running = true;

    await (relay as any).run();

    expect(streamClient.xgroup).toHaveBeenCalledWith(
      'CREATE', options.eventStreamKey, options.bullMq.consumerGroup, '0', 'MKSTREAM',
    );
    expect(streamClient.xautoclaim).toHaveBeenCalledTimes(2);
  });
});

describe('CreditCommandWorker', () => {
  it('executes a trusted idempotent grant command', async () => {
    const { provider, options } = createTransport();
    const credits = { grant: jest.fn().mockResolvedValue({ balance: 50, existing: false }) };
    const worker = new CreditCommandWorker(
      options,
      new CreditCatalogService(options),
      credits as any,
    );

    await expect((worker as any).process({
      id: 'command-1',
      name: 'credit.grant.requested',
      data: {
        commandId: 'command-1', schemaVersion: 1, serviceId: 'kyc',
        payload: {
          subject: { accountId: 'account-1', creditType: 'API' },
          amount: 50,
          referenceId: 'payment-1',
        },
      },
    })).resolves.toEqual({ balance: 50, existing: false });

    expect(credits.grant).toHaveBeenCalledWith({
      subject: {
        accountId: 'account-1', serviceId: 'kyc', creditType: 'API',
        tenantId: undefined, accountType: undefined,
      },
      amount: 50,
      referenceId: 'payment-1',
      reason: undefined,
    });
    expect(provider.add).not.toHaveBeenCalled();
  });

  it('publishes a command rejection to every lifecycle destination', async () => {
    const { provider, options } = createTransport();
    provider.add.mockResolvedValue({});
    const worker = new CreditCommandWorker(
      options,
      new CreditCatalogService(options),
      { grant: jest.fn() } as any,
    );
    await expect((worker as any).process({
      id: 'bad-command',
      name: 'credit.grant.requested',
      data: {
        commandId: 'bad-command', schemaVersion: 1, serviceId: 'kyc',
        payload: { subject: { accountId: 'a', creditType: 'API' }, amount: -1 },
      },
    })).rejects.toThrow('positive safe integer');
    expect(provider.add).toHaveBeenCalledTimes(2);
    expect(provider.add).toHaveBeenCalledWith(
      'credit.lifecycle', 'credit.command-rejected',
      expect.objectContaining({ commandId: 'bad-command' }),
      { jobId: 'kyc-bad-command-rejected' },
    );
  });
});
