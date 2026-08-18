# Independent lifecycle and command server

This process represents trusted billing infrastructure outside the SDK-installed
API server. It:

- consumes plan-level lifecycle jobs from `credit.lifecycle`;
- publishes schema-v2 commands to `credit.commands.<catalogId>`;
- keeps a small in-memory event list only for demonstration.

Start it beside one API example:

```sh
npm run start:example:events
npm run start:example
```

Create an API-credit recharge plan:

```sh
curl -X POST http://localhost:3002/credit-commands/grant \
  -H 'content-type: application/json' \
  -d '{
    "catalogId":"example-service",
    "appId":"user_123",
    "appType":"USER",
    "creditType":"API_CREDIT",
    "planId":"api-plan-001",
    "amount":100,
    "grantedAt":1780000000000,
    "expiresAt":1900000000000,
    "referenceId":"payment-001",
    "reason":"demo-credit-purchase"
  }'
```

Inspect events received from the SDK:

```sh
curl 'http://localhost:3002/credit-events?limit=25'
```

A split reservation produces separate `credit.reserved` and
`credit.committed` jobs for every funding `planId`. Replace the in-memory store
with an idempotent TimescaleDB consumer keyed by the envelope `eventId`.

This service and the API server must use the same Redis/BullMQ configuration.
Do not run a lifecycle worker inside the API server: workers on one BullMQ queue
compete instead of receiving independent copies.
