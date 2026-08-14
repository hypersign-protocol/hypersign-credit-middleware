# Hypersign Credit Middleware

NestJS Middleware SDK for atomic, Redis-backed API credit reservations. Version 2 is a
breaking, subject-scoped design: every balance belongs to one explicit wallet.

Internal and operational references:

- [Redis keyspace, data types, TTLs, and inspection](docs/redis-keyspace.md)
- [Lua scripts, keys, arguments, and return codes](docs/lua-scripts.md)

## Billing identity

`CreditSubject` is the complete wallet identity:

```ts
const subject: CreditSubject = {
  tenantId: 'tenant_1',
  accountType: 'BUSINESS',
  accountId: 'business_123',
  serviceId: 'kyc',
  creditType: 'API_CREDIT',
};
```

Only `accountId` is required. Optional dimensions create independent wallets.
Do not put a dimension in the subject unless its balance must be independent.
For example, omit `serviceId` if KYC and SSI intentionally share one wallet.

The SDK encodes every dimension safely and generates keys such as:

```text
credit:{credit}:balance:tenant=tenant_1|accountType=BUSINESS|account=business_123|service=kyc|creditType=API_CREDIT
```

Every transactional key contains the same Redis Cluster hash tag, so reservation,
rollback, recovery, idempotency, and stream writes remain valid in Redis Cluster.

## Installation

NestJS and RxJS are peer dependencies. A consuming application must provide one
runtime copy of them. During local development, install a packed artifact instead
of a live `file:` symlink, which can load the SDK's development Nest installation:

```sh
cd /home/pratap/nestjs-interceptor
npm run build
npm pack

cd /home/pratap/hypersign-kyc-service
npm install ../nestjs-interceptor/hypersign-protocol-credit-sdk-2.0.0.tgz
```

Import from:

```ts
import { CreditModule, CreditCost } from '@hypersign-protocol/credit-sdk';
```

## Redis provider

Expose one application-owned Redis client under `CREDIT_REDIS_CLIENT`:

```ts
@Global()
@Module({
  providers: [{
    provide: CREDIT_REDIS_CLIENT,
    useFactory: () => new Redis(process.env.REDIS_URL!),
  }],
  exports: [CREDIT_REDIS_CLIENT],
})
export class RedisModule {}
```

The client must implement the ioredis-compatible
`eval(script, keyCount, ...keysAndArguments)` API.

## Balance provider safety

The provider receives the exact subject and initializes only a missing Redis
wallet:

```ts
@Injectable()
export class LedgerBalanceProvider implements CreditBalanceProvider {
  constructor(private readonly ledger: BillingLedger) {}

  async getBalance(subject: CreditSubject) {
    const row = await this.ledger.findWallet(subject);
    return {
      balance: row.availableCredits,
      source: 'billing-ledger',
      revision: row.revision,
    };
  }
}
```

An existing balance—including zero—is authoritative. The provider is never
called because a balance is low or insufficient. Therefore a stale database
snapshot cannot overwrite Redis and recreate spent credits. `criticalBalance`
only emits a low-balance notification.

Concurrent first requests use a scoped initialization lock. One initializes;
another receives HTTP 503 and can retry with the same request ID. Provider
failure fails closed.

## Register once for the whole application

Use async registration so application providers can be injected:

```ts
@Module({
  imports: [
    RedisModule,
    CreditModule.forRootAsync({
      imports: [BillingInfrastructureModule],
      inject: [LedgerBalanceProvider, CreditEventsHandler],
      useFactory: (
        balanceProvider: LedgerBalanceProvider,
        eventHandler: CreditEventsHandler,
      ) => ({
        leaseMs: 60_000,
        retentionMs: 7 * 24 * 60 * 60 * 1000,
        criticalBalance: 20,
        balanceProvider,
        eventHandler,
        requestContextResolver: (unknownRequest) => {
          const request = unknownRequest as AuthenticatedRequest;
          return {
            subject: {
              tenantId: request.service.tenantId,
              accountType: 'BUSINESS',
              accountId: request.service.businessId,
              serviceId: 'kyc',
              creditType: 'API_CREDIT',
            },
            requestId: request.requestId,
          };
        },
      }),
    }),
  ],
})
export class BillingModule {}
```

Import this root billing module once. Feature modules do not register
`CreditModule` again. The module installs one global credit interceptor.

The resolver must use identity produced by verified authentication. Never use an
unverified JWT field or user-controlled account header in production.

## Decorator usage

```ts
@Controller('mobile-flows')
export class MobileFlowController {
  @Get(':flowId')
  @CreditCost({
    amount: 10,
    settlementMode: 'IMMEDIATE',
    operation: 'FETCH_MOBILE_FLOW',
  })
  findOne(@Param('flowId') flowId: string) {
    return this.mobileFlowService.findOne(flowId);
  }
}
```

The interceptor atomically reserves from the resolved subject, runs the
controller, commits on success, and refunds once on failure. A stable
`requestId` prevents duplicate deduction. Because the SDK does not store the
original HTTP response, a duplicate decorated request is rejected with `409`
instead of executing the controller side effect again.

## Deferred operations

Register the module once; settlement mode is per operation:

```ts
const reservation = await credits.reserve({
  subject,
  requestId,
  amount: 25,
  operation: 'GENERATE_REPORT',
  settlementMode: 'DEFERRED',
});

// A different worker may extend the lease with the returned capability token.
await credits.renew(reservation.reservationId, reservation.leaseToken);

await credits.commit(reservation.reservationId);
// or
await credits.rollback(reservation.reservationId, 'downstream_failed');
```

Keep `leaseToken` private. Set `leaseMs` above the normal operation duration and
renew only genuinely long-running deferred work.

## Credit grants/top-ups

Apply a successful payment once with its stable business transaction ID:

```ts
await credits.grant({
  subject,
  amount: 100,
  referenceId: payment.transactionId,
  reason: 'credit_purchase',
});
```

Grant retries are idempotent while the Redis grant marker is retained. Reusing
the reference with a different amount is rejected. Permanently deduplicate the
`referenceId` in the authoritative recharge consumer because the Redis marker
expires after `retentionMs`. Persist `CREDIT_GRANTED` from the durable event
stream into the ledger; do not update Redis and the ledger independently in
request code.

## Middleware that can terminate early

Normally use only `@CreditCost`. Add the early boundary only when application
middleware can end a paid request before Nest interceptors run:

```ts
const FETCH_FLOW = {
  amount: 10,
  settlementMode: 'IMMEDIATE' as const,
  operation: 'FETCH_MOBILE_FLOW',
};

CreditModule.forRoot({
  // other options...
  earlyPolicies: [{
    method: 'GET',
    path: '/api/v1/mobile-flows/:flowId',
    ...FETCH_FLOW,
  }],
});

consumer.apply(
  AuthenticationContextMiddleware,
  CreditBoundaryMiddleware,
  FeatureValidationMiddleware,
).forRoutes('*');
```

Keep `@CreditCost(FETCH_FLOW)` on the controller. The boundary reserves once;
the interceptor claims that same reservation. If feature middleware ends the
response, the boundary refunds it. A process crash is handled by recovery.

Decorator metadata is not available to earlier Express middleware, which is why
an early policy is required only for this exceptional path.

## Crash recovery

The SDK creates no interval or timeout. Run recovery from a separate scheduled
worker so it survives API crashes:

```ts
await creditRecoveryService.runOnce();
```

Multiple workers are safe because finalization is atomic and idempotent. Run the
worker more frequently than the acceptable refund delay.

An explicitly deferred reservation may opt out with `autoRecover: false` when
another durable system owns the outcome. `runOnce()` ignores that reservation;
only an explicit `commit()` or `rollback()` settles it. Use this only with
age monitoring and reconciliation, because a lost owner otherwise holds the
credits indefinitely.

## Durable events and ledger synchronization

Reservation, commit, rollback, expiry, and grant state changes append to
`credit:{credit}:events` inside the same Lua transaction. Use a consumer group:

```redis
XGROUP CREATE credit:{credit}:events billing-ledger $ MKSTREAM
XREADGROUP GROUP billing-ledger writer-1 COUNT 100 BLOCK 5000 \
  STREAMS credit:{credit}:events >
```

Use `reservationId` for settlement-event idempotency and `referenceId` for grant
idempotency in the durable database. Acknowledge only after the database
transaction commits. The optional in-process event handler is for logs and
low-latency notifications; it is not a durable ledger writer.

Lifecycle handler payloads use unambiguous fields:

```ts
onRolledBack(event) {
  event.accountId;    // string wallet account ID
  event.amount;       // numeric amount refunded
  event.balanceAfter; // numeric scoped balance after refund
  event.subject;      // complete tenant/account/service/credit identity
}
```

Handler events are ordered through a bounded best-effort queue. Synchronous and
asynchronous handler errors are logged and cannot fail the API. Idempotent
request and grant retries do not emit duplicate handler callbacks. The Redis
Stream remains the durable source for database synchronization.

## Production Redis requirements

- Enable AOF persistence and tested backups. Redis loss can lose both balances
  and the colocated event stream.
- Use `noeviction`; eviction of balances or reservation hashes breaks accounting.
- Use TLS, authentication, least-privilege network access, and separate keyspace.
- Monitor recovery backlog, stream consumer lag, provider failures, 402/503 rates,
  memory, replication health, and persistence errors.
- Use unique request IDs from a trusted gateway/service, with retention longer
  than the maximum client retry window.
- Treat amounts as positive safe integers in the smallest credit unit.
- Reconcile Redis-derived events against the authoritative ledger continuously.

## Examples

Start local Redis on `localhost:6379` and run either server:

```sh
npm run start:example
npm run start:example:multi
```

The single-server demo includes one endpoint with two independent charges for
the same account and service:

- `5 API_CREDIT` is charged immediately by `@CreditCost` after the handler
  succeeds.
- `25 BLOCKCHAIN_TXN_CREDIT` is reserved programmatically as `DEFERRED` and
  emits a durable `RESERVED` event. It passes `autoRecover: false`, so
  `runOnce()` leaves it reserved for its owner to settle explicitly. The demo
  intentionally provides no worker.

```sh
curl -X POST http://localhost:3000/demo/blockchain-operation \
  -H 'x-request-id: blockchain-demo-001'

curl http://localhost:3000/demo/balance
```

On a fresh demo Redis instance, the balance provider initializes both wallets
to `100`. After the call, the balances are `API_CREDIT=95` and
`BLOCKCHAIN_TXN_CREDIT=75`. The API reservation is committed while the
blockchain reservation remains deferred for a future external worker.

Use `autoRecover: false` only when another durable system owns settlement.
Because such a reservation can remain held forever if that owner disappears,
monitor its age and provide an explicit reconciliation or administrative
rollback path. The flag prevents an automatic refund; it does not solve an
unknown downstream outcome.

The multi-module mobile-flow URL is:

```sh
curl http://localhost:3001/api/v1/mobile-flows/flow_1 \
  -H 'x-business-id: business_123' \
  -H 'x-request-id: request-001'
```

An idempotent demo top-up is available at:

```sh
curl -X POST http://localhost:3001/api/v1/operations/grant \
  -H 'content-type: application/json' \
  -H 'x-business-id: business_123' \
  -d '{"amount":25,"referenceId":"payment-001"}'
```

The example header is intentionally simplified and must not replace verified
authentication in a real service.

## Version 2 breaking changes

- Package name is `@hypersign-protocol/credit-sdk`.
- `reserve()` requires `subject`; flat `accountId` input was removed.
- `getBalance()` requires a `CreditSubject` and returns `null` if uninitialized.
- `requestContextResolver` returns `{ subject, requestId }`.
- Low/insufficient balances never trigger provider refresh.
- Redis keys use a new scoped, cluster-safe format; migrate balances explicitly.
- Missing subject dimensions use explicit key tags and cannot collide with real
  values such as `_` or `default`.
- `renew()` requires the per-reservation `leaseToken`.
