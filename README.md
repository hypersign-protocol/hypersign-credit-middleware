# Hypersign Credit Middleware

Version 3 is a catalog-driven NestJS SDK for Redis-backed API credits. The SDK validates the
installed service's routes, reserves credit before controllers execute, owns
commit/rollback/recovery state transitions, writes a transactional Redis Stream
outbox, relays lifecycle events to BullMQ, and consumes trusted BullMQ commands.

Operational references:

- [Redis keyspace, records, TTLs, and inspection](docs/redis-keyspace.md)
- [Lua scripts, keys, arguments, and return codes](docs/lua-scripts.md)

## Main model

The authoritative HTTP price source is a versioned service catalog. Controllers
do not use a credit decorator.

```ts
export const KYC_CREDIT_CATALOG = defineCreditCatalog({
  serviceId: 'kyc',
  version: '2026-08-14',
  globalPrefix: 'api',
  routes: [
    {
      method: 'POST',
      path: '/api/v1/session',
      charges: [
        { id: 'api', creditType: 'API_CREDIT', amount: 4 },
      ],
    },
    {
      method: 'GET',
      path: '/api/v1/session/:sessionId',
      charges: [], // explicitly free
    },
  ],
});
```

At application bootstrap the SDK compares every discovered Nest controller
route with the catalog. Startup fails when either side contains a route absent
from the other, or when a catalog contains duplicate/invalid routes or charges.
An empty `charges` array distinguishes an intentionally free route from a route
that was forgotten.

Set `globalPrefix` to the prefix configured on the Nest application. Versioned
controllers default to URI paths such as `v1`; use `versioning: 'NONE'` for
header, media-type, or custom versioning where the version is not in the URL.
The audit covers Nest controller metadata. Raw Express/Fastify routes, Swagger,
health probes mounted directly on the adapter, and gateway-only endpoints are
outside Nest discovery and must be governed separately.

## Billing identity

Every wallet has an explicit subject:

```ts
const subject: CreditSubject = {
  tenantId: 'tenant_1',
  appType: 'BUSINESS',
  appId: 'business_123',
  serviceId: 'kyc',
  creditType: 'API_CREDIT',
};
```

Only `appId` is intrinsically required. Catalog charges set `serviceId` to
the selected catalog and set `creditType` per charge. The remaining identity
must come from trusted authentication context, never request body/query data.

## Host providers

The installing service supplies:

1. `CREDIT_REDIS_CLIENT`: the Redis connection used for Lua credit operations.
2. A second Redis connection for blocking Stream reads. It must not be the
   operation connection.
3. A `CreditBullMqProvider` implemented using the host's BullMQ connections.
4. A `CreditBalanceProvider` for initialization of missing wallets.
5. `requestContextResolver` for trusted account/tenant/request identity.

The structural BullMQ contract is intentionally small:

```ts
interface CreditBullMqProvider {
  add(queueName, jobName, data, { jobId }): Promise<unknown>;
  createWorker(queueName, processor): Promise<{ close(): Promise<void> }>;
}
```

The complete real BullMQ adapter is in
[`example/bullmq.module.ts`](example/bullmq.module.ts).

## Registration

```ts
CreditModule.forRootAsync({
  imports: [RedisModule, CreditQueueModule],
  inject: [LedgerBalanceProvider, CREDIT_BULLMQ_PROVIDER, STREAM_REDIS],
  useFactory: (balanceProvider, bullMq, streamClient) => ({
    catalog: KYC_CREDIT_CATALOG,
    leaseMs: 60_000,
    retentionMs: 7 * 24 * 60 * 60 * 1_000,
    criticalBalance: 20,
    balanceProvider,
    bullMq: {
      provider: bullMq,
      streamClient,
      lifecycleQueueNames: ['credit.lifecycle'],
      commandQueueName: 'credit.commands.kyc',
    },
    requestContextResolver: (unknownRequest) => {
      const request = unknownRequest as AuthenticatedRequest;
      return {
        subject: {
          tenantId: request.service.tenantId,
          appType: 'BUSINESS',
          appId: request.service.appId,
          serviceId: 'kyc',
        },
        requestId: request.requestId,
      };
    },
  }),
});
```

Register `CreditModule` once in the root billing/infrastructure module. It
installs one global interceptor; feature controllers contain no pricing code.

## Request lifecycle

For each charge the SDK creates an independent reservation. A stable HTTP
request ID is combined with the catalog charge ID, preventing collisions when
one endpoint consumes multiple credit types.

```text
Catalog match
  -> reserve every charge
  -> execute controller
  -> commit IMMEDIATE reservations after success
  -> leave DEFERRED reservations active
  -> rollback all still-active reservations after failure
```

Example with two independent lifecycles:

```ts
{
  method: 'POST',
  path: '/api/v1/blockchain/submit',
  charges: [
    { id: 'api', creditType: 'API_CREDIT', amount: 5 },
    {
      id: 'transaction',
      creditType: 'BLOCKCHAIN_TXN_CREDIT',
      amount: 25,
      settlementMode: 'DEFERRED',
      autoRecover: false,
    },
  ],
}
```

The API reservation commits after controller success. The transaction
reservation remains active until a trusted command commits or rolls it back.
`autoRecover: false` is valid only for deferred work and requires age monitoring
because a lost downstream owner can otherwise hold credit indefinitely.

Multiple reservations are independent, not a transaction group. If a later
reservation fails, the SDK compensates earlier new reservations with rollback.

## Early middleware boundary

Nest middleware runs before guards and interceptors. If trusted identity is
already established by middleware and a later middleware can terminate a paid
request, mark that route:

```ts
{
  method: 'POST',
  path: '/api/v1/mobile-flow',
  boundary: true,
  charges: [{ id: 'api', creditType: 'API_CREDIT', amount: 10 }],
}
```

Then register:

```ts
consumer.apply(
  AuthenticationContextMiddleware,
  CreditBoundaryMiddleware,
  FeatureValidationMiddleware,
).forRoutes('*');
```

The boundary and interceptor use the same catalog. There is no duplicated
policy list. If identity is produced by a guard instead, do not use the early
boundary; charging occurs after authentication and before the controller.

## Durable BullMQ lifecycle events

Every balance/state transition appends its event to the Redis Stream in the same
Lua transaction. This includes `RESERVED`, `COMMITTED`, `ROLLED_BACK`, `EXPIRED`,
`CREDIT_GRANTED`, `CRITICAL_BALANCE`, and `BALANCE_INITIALIZED`.

The SDK-owned relay uses a Redis consumer group:

```text
Redis Stream
  -> XAUTOCLAIM abandoned pending entries
  -> XREADGROUP new entries
  -> BullMQ add using serviceId + Stream ID as jobId
  -> XACK only after every configured destination accepts the job
```

Default output queue: `credit.lifecycle`.

Job names:

```text
credit.reserved
credit.committed
credit.rolled-back
credit.expired
credit.granted
credit.critical-balance
credit.balance-initialized
credit.command-rejected
```

All lifecycle and command job names are exported for consumers:

```ts
import { CREDIT_EVENT_NAMES } from '@hypersign-protocol/credit-middleware';

if (job.name === CREDIT_EVENT_NAMES.RESERVED) {
  // Handle the reservation event.
}
```

BullMQ provides competing consumers, not RabbitMQ-style topic fan-out. Configure
multiple `lifecycleQueueNames` when independent systems must each receive every
event. Bull job IDs make relay retries idempotent. Database consumers must also
uniquely persist `eventId` because processing is at least once.

Balance changes occur at these events:

| Event | Available balance delta |
| --- | ---: |
| `RESERVED` | `-amount` |
| `COMMITTED` | `0` |
| `ROLLED_BACK` | `+amount` |
| `EXPIRED` | `+amount` |
| `CREDIT_GRANTED` | `+amount` |

`COMMITTED.balanceAfter` is the snapshot captured when reservation deducted the
credit; it is not necessarily the current wallet balance if other operations
happened before commit.

## Trusted inbound commands

The SDK registers a worker on `credit.commands.<serviceId>` by default. Supported
job names are:

```text
credit.grant.requested
credit.reserve.requested
credit.commit.requested
credit.rollback.requested
```

Example grant command:

```ts
await queueProvider.add(
  'credit.commands.kyc',
  CREDIT_EVENT_NAMES.GRANT_REQUESTED,
  {
  schemaVersion: 1,
  commandId: payment.eventId,
  serviceId: 'kyc',
  source: 'payment-service',
  payload: {
    subject: {
      tenantId: 'tenant_1',
      appId: 'business_123',
      creditType: 'API_CREDIT',
    },
    amount: 100,
    referenceId: payment.transactionId,
    reason: 'credit_purchase',
  },
  },
  { jobId: payment.eventId },
);
```

Grant uses `referenceId` for Redis idempotency. Commit/rollback commands accept a
reservation ID and always load the stored subject and amount; external callers
cannot choose a refund amount. Rejected valid envelopes emit
`credit.command-rejected` and the Bull job fails for its configured retry policy.
Command-created reservations are always `DEFERRED`; an `IMMEDIATE` reservation
only has meaning in the HTTP controller success/failure lifecycle.

Redis grant markers expire after `retentionMs`. Financial systems must also keep
a permanent unique payment/reference ID in the authoritative ledger.

## Balance initialization

`CreditBalanceProvider` runs only when the exact scoped balance key is absent.
A stored zero is a real zero. Low or insufficient balance never refreshes from
the provider, preventing a stale database snapshot from recreating spent credit.

Concurrent initialization uses a per-wallet lock. Provider failure fails closed.
Recharge after initialization arrives through `credit.grant.requested`.

## Crash recovery

The SDK creates no `setInterval` or `setTimeout`. A dedicated scheduler or worker
invokes:

```ts
await creditRecoveryService.runOnce();
```

The operation is atomic and safe with multiple workers. Expired, auto-recoverable
reservations are refunded once and emit durable `EXPIRED`. BullMQ workers and the
event relay use blocking Redis reads, not application polling timers.

## Examples

The API examples use `redis://localhost:6379`, a dedicated Stream connection, a
real BullMQ adapter, strict startup catalog auditing, and inbound command
consumption. The separate event server consumes lifecycle events and produces
trusted commands; the SDK-installed API server does neither in its controllers.

```sh
npm run start:example
npm run start:example:multi
npm run start:example:events
```

Single-server multi-credit request:

```sh
curl -X POST http://localhost:3000/demo/blockchain-operation \
  -H 'x-request-id: blockchain-demo-001'
```

Multi-module catalog route:

```sh
curl http://localhost:3001/api/v1/mobile-flows/flow_1 \
  -H 'x-business-id: business_123' \
  -H 'x-request-id: request-001'
```

Run `start:example:multi` and `start:example:events` in separate terminals, then
produce a grant from the event server:

```sh
curl -X POST http://localhost:3002/credit-commands/grant \
  -H 'content-type: application/json' \
  -d '{"serviceId":"kyc","tenantId":"tenant_1","appType":"BUSINESS","appId":"business_123","creditType":"API_CREDIT","amount":25,"referenceId":"payment-001"}'
```

Inspect lifecycle events received by the separate process:

```sh
curl 'http://localhost:3002/credit-events?limit=25'
```

See [`example/event-server/README.md`](example/event-server/README.md) for the
responsibility split and the TimescaleDB replacement point.

The example headers simulate authenticated identity and must not be copied as a
production authentication mechanism.

## Production Redis requirements

- Redis 6.2 or newer for `XAUTOCLAIM`.
- AOF persistence, tested backups, replication, and `noeviction`.
- TLS, authentication, least-privilege access, and isolated key prefixes.
- Dedicated operation and blocking Stream connections.
- Monitoring for pending Stream entries, consumer lag, recovery backlog, Bull
  failures, provider failures, insufficient-credit responses, and Redis memory.
- `eventStreamMaxLength` sized above the longest tolerated relay outage; approximate
  trimming can remove an event that was never delivered if configured too small.

## Package

The package name is:

```ts
import {
  CreditModule,
  CreditService,
  defineCreditCatalog,
} from '@hypersign-protocol/credit-middleware';
```
