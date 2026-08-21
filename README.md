# Hypersign Credit Middleware v5

NestJS credit-lifecycle SDK backed by Redis Lua and BullMQ. Version 5 uses
immutable recharge plans instead of one aggregate balance or a balance provider.
Each API reservation records exactly which plans funded it, consumes plans FIFO,
and emits one settlement event per affected plan.

- [Developer integration guide — start here](docs/developer-guide.md#start-here-complete-integration)
- [Technical architecture](docs/technical-architecture.md)
- [Redis keys and records](docs/redis-keyspace.md)
- [Lua state transitions](docs/lua-scripts.md)

## Credit model

A wallet is scoped by `tenantId`, `appType`, `appId`, and `creditType`.
`serviceId` is not part of billing identity.

The trusted request context also carries `environment: 'PROD' | 'DEV'`. It is
not part of wallet identity: PROD calls enforce credit, while DEV calls only
record usage.

```ts
const subject: CreditSubject = {
  tenantId: 'tenant_1',
  appType: 'BUSINESS',
  appId: 'business_123',
  creditType: 'API_CREDIT',
};
```

Every recharge creates a distinct immutable plan:

```ts
await credits.grant({
  subject,
  planId: 'plan_01',
  amount: 100,
  criticalBalance: 20,
  grantedAt: Date.now(),
  expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1_000,
  referenceId: 'payment_01',
  reason: 'credit_purchase',
});
```

There is no `CreditBalanceProvider`. Before the first grant, `getBalance()`
returns `null` and paid requests fail closed with insufficient credit.

An exact retry of a grant is idempotent. Reusing a `planId` with another amount,
expiry, grant time, critical balance, or reference is rejected. Reusing a
reference for another plan is also rejected. Both `planId` ownership and
payment references are
enforced globally inside one SDK Redis namespace, not merely per wallet.

## FIFO allocation

Plans are ordered by `grantedAt`, then `planId`. Expired and depleted plans are
skipped. If a cost cannot be paid completely, the reservation makes no credit
deductions.

```text
plan-old remaining 10
plan-new remaining 50
request cost       25

reservation allocations:
  plan-old 10
  plan-new 15
```

The allocation is stored in the reservation. Commit, rollback, and crash
recovery never recalculate FIFO.

Every plan must be granted to the SDK before it can participate in FIFO. A plan
that exists only in a dashboard/payment database is not part of the Redis
wallet. `criticalBalance` emits a lifecycle notification; it does not register
or activate the next plan. See the
[plan-2 HTTP 402 checklist](docs/redis-keyspace.md#diagnosing-http-402-before-plan-2).

Commit writes one `COMMITTED` event per allocation. A database consumer can use
`reservationId + planId + event type` as its idempotency key.

Rollback restores each allocation to its original plan only while that plan is
still active. If the plan expired while credit was reserved, rollback reports
the allocation as expired and does not resurrect it. Commit remains valid after
plan expiry because credit was reserved while eligible.

## Catalog

Controllers contain no pricing decorators. The authoritative KYC route and
pricing catalog is bundled in `src/catalogs/catalog.kyc.json`. Host
applications cannot supply or override it. Change that file and release a new
SDK version whenever KYC routes or prices change.

Startup fails if an application route is missing from the catalog, a catalog
route is missing from the application, or routes/charges are invalid.

`serviceType` identifies the SDK installation and transport. It is deliberately
separate from `CreditSubject` and does not split a wallet.

## Registration

```ts
CreditModule.forRootAsync({
  imports: [RedisModule],
  useFactory: () => ({
    keyPrefix: 'credit-kyc',
    redisHashTag: 'credit-kyc',
    requestContextResolver: (unknownRequest) => {
      const request = unknownRequest as AuthenticatedRequest;
      const environment = request.service.env?.trim().toUpperCase();
      if (environment !== 'PROD' && environment !== 'DEV') {
        throw new Error('Trusted service environment must be PROD or DEV');
      }
      return {
        subject: {
          tenantId: request.service.subdomain,
          appType: 'CAVACH_API',
          appId: request.service.appId ?? '',
        },
        requestId: request.requestId,
        environment,
      };
    },
  }),
});
```

The host supplies only `CREDIT_REDIS_CLIENT`. The SDK duplicates that ioredis
client for its blocking Stream relay and BullMQ queues/workers, applies its own
job policy, and closes only the connections it creates. Transport is enabled by
default and can be disabled explicitly with `transport: false`.

## Request lifecycle

```text
catalog match
  -> resolve trusted per-request environment
  -> PROD: atomically reserve FIFO plan allocations
  -> DEV: atomically append CREDIT_OBSERVED with deductedAmount=0
  -> execute controller
  -> PROD only: commit/leave deferred/roll back reservations
```

Catalog routes may contain several credit types. Each catalog charge creates an
independent PROD reservation or DEV observation. DEV does not read balances,
require a grant, or mutate plans. If a later PROD charge fails, earlier new
reservations are compensated.

For middleware that can return before the interceptor, use `boundary: true` and
install `CreditBoundaryMiddleware` after trusted authentication context exists.

## BullMQ transport

Transport envelopes use `schemaVersion: 3`.

Default lifecycle queue:

```text
credit.lifecycle
```

Lifecycle job names:

```text
credit.granted
credit.plan-expired
credit.reserved
credit.committed
credit.rolled-back
credit.expired
credit.critical-balance
credit.observed
credit.command-rejected
```

Default inbound queue:

```text
credit.commands.<serviceType>
```

Supported command jobs:

```text
credit.grant.requested
credit.reserve.requested
credit.commit.requested
credit.rollback.requested
```

Grant command example:

```ts
await queueProvider.add(
  'credit.commands.CAVACH_API',
  CREDIT_EVENT_NAMES.GRANT_REQUESTED,
  {
    schemaVersion: 3,
    commandId: payment.eventId,
    serviceType: 'CAVACH_API',
    source: 'payment-service',
    payload: {
      subject: {
        tenantId: 'tenant_1',
        appType: 'BUSINESS',
        appId: 'business_123',
        creditType: 'API_CREDIT',
      },
      planId: payment.planId,
      amount: 100,
      criticalBalance: payment.criticalBalance,
      grantedAt: payment.createdAt.getTime(),
      expiresAt: payment.expiresAt.getTime(),
      referenceId: payment.transactionId,
      reason: 'credit_purchase',
    },
  },
  { jobId: payment.eventId },
);
```

The Redis Stream is the transactional outbox. It is acknowledged only after
every configured lifecycle queue accepts the BullMQ job. BullMQ delivery is at
least once, so consumers must persist `eventId` idempotently.

BullMQ queues use competing consumers. Configure separate lifecycle queue names
when reconciliation, notifications, and analytics each require every event.

## Expiry and crash recovery

No interval is started by the SDK. Invoke the stateless recovery entry point
from a Nest scheduler or dedicated worker. The runnable example uses:

```ts
@Injectable()
export class CreditRecoveryScheduler {
  constructor(private readonly recovery: CreditRecoveryService) {}

  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: 'credit-recovery',
    waitForCompletion: true,
  })
  async run(): Promise<void> {
    await this.recovery.runOnce();
  }
}
```

One pass handles both expired reservation leases and expired unused plan credit.
Redis Lua makes concurrent recovery workers safe.

Plan records do not use Redis TTL because an active reservation may still refer
to an expired plan. Finalized reservation/request records use `retentionMs`.

## Examples

Start the SDK server and the independent lifecycle/command server:

```sh
npm run start:example
npm run start:example:events
```

Grant two FIFO plans through the event server (use current millisecond values):

```sh
curl -X POST http://localhost:3002/credit-commands/grant \
  -H 'content-type: application/json' \
  -d '{
    "serviceType":"CAVACH_API",
    "appId":"user_123",
    "appType":"USER",
    "creditType":"API_CREDIT",
    "planId":"plan-old",
    "amount":10,
    "criticalBalance":2,
    "grantedAt":1780000000000,
    "expiresAt":1900000000000,
    "referenceId":"payment-old"
  }'
```

Repeat with a new `planId`, `referenceId`, and later `grantedAt`, then call:

```sh
curl -X POST http://localhost:3000/demo/cheap \
  -H 'x-request-id: request-001' \
  -H 'x-service-environment: PROD'

curl http://localhost:3000/demo/plans
curl 'http://localhost:3002/credit-events?limit=25'
```

The multi-module server uses service type `CAVACH_API` and queue
`credit.commands.CAVACH_API`:

```sh
npm run start:example:multi
```

## Production requirements

- Redis 6.2+ with AOF, replication, tested backups, and `noeviction`.
- TLS/authentication and separate operation/blocking connections.
- Stable request IDs, plan IDs, payment references, and grant timestamps.
- A scheduler for `CreditRecoveryService.runOnce()`.
- Alerts for recovery backlog, Stream pending entries, relay shutdown, BullMQ
  failures, rejected commands, plan count, and insufficient-credit responses.
- `eventStreamMaxLength` larger than the longest expected relay outage.
- Idempotent database consumers keyed by the lifecycle `eventId`.

Version 5 stores Redis state under `<keyPrefix>:v2:{<hashTag>}:...`; it does not
read version 3 aggregate-balance keys.
