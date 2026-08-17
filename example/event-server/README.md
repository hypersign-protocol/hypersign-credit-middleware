# Credit event server demo

This is a second NestJS process with no `CreditModule`. It represents the
trusted billing/reconciliation side of the architecture:

- consumes every job from the `credit.lifecycle` BullMQ queue;
- keeps the newest 1,000 jobs in memory so they can be inspected over HTTP;
- publishes idempotent `credit.grant.requested` jobs to
  `credit.commands.<serviceId>`.

The in-memory event store is intentionally only a demo persistence boundary.
A production consumer would insert `eventId` into TimescaleDB (or another
ledger) under a unique constraint and complete the Bull job only after that
database transaction commits.

Run the credit-enabled service and this server in separate terminals:

```sh
npm run start:example:multi
npm run start:example:events
```

Inspect lifecycle events:

```sh
curl 'http://localhost:3002/credit-events?limit=25'
```

Produce a grant command:

```sh
curl -X POST http://localhost:3002/credit-commands/grant \
  -H 'content-type: application/json' \
  -d '{
    "serviceId":"kyc",
    "tenantId":"tenant_1",
    "appType":"BUSINESS",
    "appId":"business_123",
    "creditType":"API_CREDIT",
    "amount":25,
    "referenceId":"payment-001"
  }'
```

The KYC demo consumes the command, applies the grant atomically, and emits a
`credit.granted` lifecycle event back to this server.
