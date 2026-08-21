# Independent lifecycle and command server

This process represents trusted billing infrastructure outside the SDK-installed
API server. It:

- consumes plan-level lifecycle jobs from `credit.lifecycle`;
- consumes DEV `credit.observed` usage jobs from the same lifecycle queue;
- publishes schema-v3 commands to `credit.commands.CAVACH_API`;
- keeps a small in-memory event list only for demonstration.

Compile all examples and start this process:

```sh
npm run start:example:events
```

The API host is the real CAVACH NestJS application with the modules from
`example/host/` integrated. A fake API with a few demo routes is intentionally
not provided because it would fail the bundled catalog's complete startup
audit.

Create an API-credit recharge plan:

```sh
curl -X POST http://localhost:3002/credit-commands/grant \
  -H 'content-type: application/json' \
  -d '{
    "tenantId":"tenant/acme",
    "appId":"app:123",
    "planId":"api-plan-001",
    "amount":1000,
    "grantedAt":1780000000000,
    "expiresAt":1900000000000,
    "reason":"demo-credit-purchase"
  }'
```

The HTTP caller does not supply `serviceType`, `appType`, `creditType`,
`referenceId`, or `criticalBalance`. The trusted server:

- fixes `serviceType` and `appType` to `CAVACH_API`;
- fixes `creditType` to `API_CREDIT`;
- derives stable `commandId` and `referenceId` values from `planId`; and
- calculates `criticalBalance` as `Math.floor(amount * 0.4)`.

The response shows the generated internal identifiers. Retrying the same
`planId` with identical data is idempotent; changing its amount or timestamps
is rejected by the SDK.

Grant a second plan before the first plan runs out:

```sh
curl -X POST http://localhost:3002/credit-commands/grant \
  -H 'content-type: application/json' \
  -d '{
    "tenantId":"tenant/acme",
    "appId":"app:123",
    "planId":"api-plan-002",
    "amount":500,
    "grantedAt":1780000001000,
    "expiresAt":1900000000000
  }'
```

Both plan subjects must exactly match the API host's resolved `tenantId`,
`appType`, `appId`, and `creditType`. The SDK then consumes the plans FIFO. A
plan that exists only in an external database cannot fund a request.

Inspect events received from the SDK:

```sh
curl 'http://localhost:3002/credit-events?limit=25'
```

A split reservation produces separate `credit.reserved` and
`credit.committed` jobs for every funding `planId`. Replace the in-memory store
with a durable consumer that validates the envelope and applies a unique
constraint on `eventId`. Persist the event receipt and its financial side
effect in one database transaction before returning from the BullMQ worker.

A DEV HTTP call produces `credit.observed` with `requestedAmount` and
`deductedAmount: 0`; it does not produce reservation or settlement jobs.

This service and the API server must use the same Redis/BullMQ configuration.
Do not run a lifecycle worker inside the API server: workers on one BullMQ queue
compete instead of receiving independent copies.

This event server validates `schemaVersion`, `serviceType`, event type, and
`eventId`, and deduplicates its bounded in-memory view. The memory store is not
production persistence and is cleared on restart.
