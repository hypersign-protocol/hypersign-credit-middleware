import { DEFAULT_CREDIT_OPTIONS } from '../src/credit.constants';
import { CreditEventDispatcher } from '../src/events/credit.event-dispatcher';
import { CreditReservedEvent } from '../src/events/credit.events';

const reservedEvent = (reservationId: string): CreditReservedEvent => ({
  type: 'RESERVED',
  timestamp: 1,
  subject: { accountId: 'account_1' },
  scopeId: 'account=account_1',
  accountId: 'account_1',
  reservationId,
  requestId: `request_${reservationId}`,
  amount: 10,
  balanceAfter: 90,
  expiresAt: 1000,
  autoRecover: true,
  settlementMode: 'IMMEDIATE',
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('CreditEventDispatcher', () => {
  it('contains synchronous handler errors and continues with the next event', async () => {
    const received: string[] = [];
    const handler = {
      onReserved: jest.fn((event: CreditReservedEvent) => {
        received.push(event.reservationId);
        if (event.reservationId === 'first') throw new Error('sync failure');
      }),
    };
    const dispatcher = new CreditEventDispatcher({
      ...DEFAULT_CREDIT_OPTIONS,
      eventHandler: handler,
    });

    expect(() => dispatcher.dispatch(reservedEvent('first'))).not.toThrow();
    dispatcher.dispatch(reservedEvent('second'));
    await flush();

    expect(received).toEqual(['first', 'second']);
  });

  it('delivers handler events in dispatch order even when handlers are async', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const completed: string[] = [];
    const handler = {
      onReserved: jest.fn(async (event: CreditReservedEvent) => {
        if (event.reservationId === 'first') await firstGate;
        completed.push(event.reservationId);
      }),
    };
    const dispatcher = new CreditEventDispatcher({
      ...DEFAULT_CREDIT_OPTIONS,
      eventHandler: handler,
    });

    dispatcher.dispatch(reservedEvent('first'));
    dispatcher.dispatch(reservedEvent('second'));
    await flush();
    expect(completed).toEqual([]);
    releaseFirst();
    await flush();
    expect(completed).toEqual(['first', 'second']);
  });

  it('bounds the waiting queue when a handler is blocked', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handler = {
      onReserved: jest.fn(async (event: CreditReservedEvent) => {
        if (event.reservationId === 'active') await gate;
      }),
    };
    const dispatcher = new CreditEventDispatcher({
      ...DEFAULT_CREDIT_OPTIONS,
      eventHandlerQueueSize: 2,
      eventHandler: handler,
    });

    dispatcher.dispatch(reservedEvent('active'));
    dispatcher.dispatch(reservedEvent('queued'));
    dispatcher.dispatch(reservedEvent('dropped'));
    release();
    await flush();

    expect(handler.onReserved.mock.calls.map(([event]) => event.reservationId))
      .toEqual(['active', 'queued']);
  });
});
