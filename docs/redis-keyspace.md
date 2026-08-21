# Redis keyspace

For command-to-event sequence diagrams and complete execution algorithms, see
the [technical architecture](technical-architecture.md).

Version 5 uses a versioned base:

```text
<keyPrefix>:v2:{<redisHashTag>}
```

The hash tag keeps every Lua key in one Redis Cluster slot. Version `v2`
prevents legacy aggregate balances from being interpreted as plan state.

Wallet scope is derived from:

```text
tenantId, appType, appId, creditType
```

Each dimension records whether it is absent and URI-encodes its value. The
service type is transport identity and is not part of wallet scope.

## Deterministic construction

The scope uses this fixed dimension order and presence-marker format:

```text
tenant=<encoded>|appType=<encoded>|app=<encoded>|creditType=<encoded>
```

`<encoded>` is `0` for an absent or trimmed-empty optional value and
`1:<encodeURIComponent(value)>` for a present value. `appId` is required.
Values are trimmed and case-sensitive.

For example:

```ts
{
  tenantId: 'tenant/acme',
  appType: 'BUSINESS',
  appId: 'business:123',
  creditType: 'API_CREDIT'
}
```

produces:

```text
tenant=1:tenant%2Facme|appType=1:BUSINESS|app=1:business%3A123|creditType=1:API_CREDIT
```

This value is an identifier, not encrypted data. Redis key enumeration can
expose encoded account metadata and must be access-controlled.

`planId`, `referenceId`, `requestId`, and `reservationId` are URI-encoded when
used in keys. The versioned base and scope make key generation identical across
API instances and recovery workers.

## Keys

| Purpose | Suffix | Type |
| --- | --- | --- |
| Cached aggregate | `balance:<scope>` | String integer |
| FIFO active plans | `plans:order:<scope>` | Sorted set (`grantedAt`, `planId`) |
| Original amount | `plans:amount:<scope>` | Hash (`planId -> integer`) |
| Available amount | `plans:remaining:<scope>` | Hash |
| Expiry | `plans:expires:<scope>` | Hash |
| Grant time | `plans:granted-at:<scope>` | Hash |
| Business reference | `plans:reference:<scope>` | Hash |
| Plan status | `plans:status:<scope>` | Hash |
| Critical balance | `plans:critical-balance:<scope>` | Hash (`planId -> integer`) |
| Expiration member | `plans:expiration-member:<scope>` | Hash |
| Global plan ownership | `plan-owner:<planId>` | Hash |
| Grant idempotency | `grant:<referenceId>` | Hash |
| Plan expiry index | `plan:expirations` | Sorted set |
| Reservation | `reservation:<reservationId>` | Hash |
| Request idempotency | `request:<scope>:<requestId>` | Hash |
| DEV observation idempotency | `observation:<scope>:<requestId>` | Hash |
| Reservation expiry | `reservation:expirations` | Sorted set |
| Transactional outbox | `events` | Stream |

Plan attribute hashes intentionally retain depleted/expired metadata. A plan
may still be referenced by an active reservation, so Redis TTL must not remove
it independently. Operational archival/cleanup must occur only after every
reservation referring to the plan has finalized and reconciliation retention
has elapsed.

`maxActivePlans` caps entries in the active FIFO sorted set. Depleted and
expired plans are removed from that set. `maxPlanAllocationsPerReservation`
limits one request's settlement fan-out.

## Plan state

Statuses:

```text
ACTIVE -> DEPLETED
ACTIVE -> EXPIRED
DEPLETED -> ACTIVE       rollback before expiry
DEPLETED -> EXPIRED      expiry while reserved
ACTIVE/DEPLETED -> REVOKED (reserved for an explicit future command)
```

A grant creates all plan attributes, including its immutable low-balance
threshold, and the aggregate balance in one Lua call. The same call appends
`CREDIT_GRANTED`. Grant idempotency records are persistent; they must not expire
while a delayed BullMQ retry could reapply a payment.

## Reservation state

A reservation stores:

```text
reservationId, scopeId, appId, tenantId, appType, creditType,
requestId, total amount, aggregate balance after reservation,
status, leaseToken, createdAt, expiresAt, version,
settlementMode, operation, autoRecover, environment=PROD, allocations JSON
```

Allocation JSON is an array of:

```json
{
  "planId": "plan-001",
  "amount": 10,
  "planBalanceAfter": 0
}
```

It is immutable. Settlement always uses this stored array.

Finalized reservation and request records receive `retentionMs`. Active records
have no TTL. Only `autoRecover=true` reservations are added to the reservation
expiry index.

## DEV observation state

A DEV catalog charge never creates a reservation and never reads or mutates
wallet or plan keys. One Lua transaction appends `CREDIT_OBSERVED` to the outbox
and stores this short idempotency hash:

```text
eventId, amount, operation, environment=DEV
```

The hash receives `retentionMs`. An exact retry returns the original event ID
without appending another event; reuse with a different amount, operation, or
environment is rejected. Environment is deliberately absent from wallet scope,
so observation cannot create a parallel DEV balance.

## Expiration indexes

Plan-expiration members encode subject dimensions plus `planId` as JSON. This
lets a stateless recovery worker reconstruct the exact scoped hashes.

The SDK creates no timer. `CreditRecoveryService.runOnce()` processes bounded
batches from both expiration indexes. Reservation and plan transitions remain
atomic if several workers run concurrently.

## Events and BullMQ keys

The Stream key is:

```text
<keyPrefix>:v2:{<redisHashTag>}:events
```

Every financial state transition appends its event in the same Lua call. The
relay acknowledges a Stream entry only after all configured BullMQ queues accept
it. BullMQ itself creates keys such as:

```text
bull:credit.lifecycle:*
bull:credit.commands.<serviceType>:*
```

These physical names use BullMQ's default `prefix: 'bull'`. The SDK's `keyPrefix` and
`redisHashTag` affect only SDK-owned state and Stream keys; they do not affect
BullMQ keys.

Typical BullMQ suffixes include `wait`, `active`, `delayed`, `completed`,
`failed`, `events`, `meta`, IDs, markers, and individual job records. They are
owned by BullMQ and must be accessed through BullMQ APIs rather than edited or
expired directly.

Default queue and relay identifiers are:

```text
lifecycle queue:       credit.lifecycle
command queue:         credit.commands.<serviceType>
Stream consumer group: credit-bull-relay:<serviceType>
```

Lifecycle BullMQ job IDs are deterministic:

```text
<serviceType>-<redisStreamEventId>
```

A rejected command uses:

```text
<serviceType>-<commandId>-rejected
```

Inbound command job IDs are chosen by the trusted producer and should match the
stable `commandId`. BullMQ job-ID deduplication lasts only while the job record
is retained; lifecycle consumers still need a durable uniqueness constraint on
the envelope `eventId`.

Use AOF, replication, tested backups, and `noeviction`. Evicting a plan or
reservation independently can make a later rollback unrecoverable.
