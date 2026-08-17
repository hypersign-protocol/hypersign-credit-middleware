# Redis keyspace

The SDK stores operational balances, reservations, idempotency records,
expiration indexes, initialization locks, grants, and durable audit events in
Redis. `CreditKeyspace` is the only component that constructs key names.

## Base prefix and Redis Cluster slot

Every key starts with `<keyPrefix>:{<redisHashTag>}`. With defaults:

```text
credit:{credit}
```

The braces define a Redis Cluster hash tag. Every SDK key therefore belongs to
the same cluster slot, which is required because Lua scripts atomically access
multiple keys. Neither configured value may itself contain braces.

This correctness model places one SDK deployment's keyspace in one slot. Use
separate deployments/hash tags when application-level sharding is required.

## Wallet scope

A wallet is identified by `CreditSubject`:

```ts
{
  tenantId?: string;
  accountType?: string;
  accountId: string;
  serviceId?: string;
  creditType?: string;
}
```

Example scope identifier:

```text
tenant=1:acme|accountType=1:SERVICE|account=1:app-123|service=1:KYC|creditType=1:API_CREDIT
```

Values are URI-encoded. Missing dimensions use `0`; present dimensions use
`1:<encoded-value>`. This prevents a missing dimension from colliding with a
real sentinel-like value. Applications should pass a consistent subject and
let `CreditKeyspace` construct the scope.

## Keys and Redis data types

`<base>` means `credit:{credit}` with default configuration.

| Purpose | Key pattern | Type | Lifetime |
| --- | --- | --- | --- |
| Wallet balance | `<base>:balance:<scope>` | String integer | No SDK TTL |
| Reservation | `<base>:reservation:<reservationId>` | Hash | No TTL while active; `retentionMs` after finalization |
| Request idempotency | `<base>:request:<scope>:<requestId>` | Hash | No TTL while active; `retentionMs` after finalization |
| Expiration index | `<base>:reservation:expirations` | Sorted set | Persistent; members removed on finalization |
| Grant idempotency | `<base>:grant:<scope>:<referenceId>` | Hash | `retentionMs` after grant |
| Initialization lock | `<base>:initialize:<scope>` | String token | `initializationLockMs` |
| Audit events | `<base>:events` | Stream | Approximately capped by `eventStreamMaxLength` |

IDs embedded in keys are URI-encoded.

## Stored records

### Balance string

The integer is the currently available balance. Reserve atomically decrements
it; rollback and expiry recovery atomically increment it. Commit does not
change it because the deduction already happened at reservation time.

The balance deliberately has no TTL. If absent, the SDK initializes it once
through `CreditBalanceProvider`. A stored `0` is a real zero and does not cause
provider reinitialization.

### Reservation hash

An active reservation contains:

```text
reservationId, scopeId, accountId, tenantId, accountType, serviceId,
creditType, requestId, amount, remainingBalance, status, leaseToken,
createdAt, expiresAt, version, settlementMode, operation, autoRecover,
balanceKey
```

Finalization adds `finalizedAt` and `finalizationReason`; refunds also update
`remainingBalance`. Status is `RESERVED`, `COMMITTED`, `ROLLED_BACK`, or
`EXPIRED`. Refund scripts verify `balanceKey` before incrementing a wallet.

### Request idempotency hash

```text
reservationId, remainingBalance, expiresAt, amount, settlementMode,
operation, leaseToken, autoRecover
```

Reusing a request ID with different amount, settlement mode, operation, or
recovery policy is rejected.

### Expiration sorted set

Members are reservation IDs; scores are Unix expiry times in milliseconds.
Only `autoRecover=true` reservations are indexed. A scheduler must invoke
`CreditRecoveryService.runOnce()`; the SDK starts no timer or interval.

### Grant idempotency hash

Stores the grant `amount` and resulting `balance`. Repeating a reference with
the same amount returns the existing result; a different amount is rejected.

### Event stream

The stream contains `RESERVED`, `COMMITTED`, `ROLLED_BACK`, `EXPIRED`,
`CREDIT_GRANTED`, `CRITICAL_BALANCE`, and `BALANCE_INITIALIZED`. Each balance or
reservation state transition and its event are written by the same Lua script.
`MAXLEN ~` trimming is approximate.

When BullMQ transport is enabled the SDK creates a consumer group on this
stream. Pending entries are reclaimed with `XAUTOCLAIM`; an entry is acknowledged
only after every configured BullMQ lifecycle queue accepts its idempotent job.

## BullMQ-managed keys

BullMQ creates its own Redis keys, normally under `bull:<queue-name>:*`. These
lists, hashes, sorted sets, streams, and marker keys are owned by BullMQ rather
than `CreditKeyspace`. Their exact internal layout is a BullMQ implementation
detail and must not be mutated by SDK Lua scripts or application code.

Typical queue namespaces in the examples are:

```text
bull:credit.lifecycle:*
bull:credit.commands.<serviceId>:*
```

Repeated `BZPOPMIN`, `EVALSHA`, and marker operations visible in `MONITOR` are
normal blocking-worker activity, not an application `setInterval`.

## Inspection with redis-cli

Redis does not expand wildcards passed to `GET`. This does not search hashes:

```text
GET credit:reservation:*
```

Use `SCAN`, then the command matching the key type:

```bash
redis-cli --scan --pattern 'credit:{credit}:*'
redis-cli GET 'credit:{credit}:balance:<scope>'
redis-cli HGETALL 'credit:{credit}:reservation:<reservationId>'
redis-cli ZRANGE 'credit:{credit}:reservation:expirations' 0 -1 WITHSCORES
redis-cli XREVRANGE 'credit:{credit}:events' + - COUNT 25
redis-cli TYPE '<key>'
```

Prefer `SCAN` to the blocking `KEYS` command. Do not leave `MONITOR` running for
routine production inspection; it streams every command and adds overhead.

## Invariants

- Amounts and balances are non-negative safe integers.
- Balance is deducted exactly once, during reservation.
- Commit never deducts again.
- Refund/recovery only mutate a `RESERVED` reservation.
- Refund verifies the stored balance key.
- Repeated finalization cannot apply another mutation.
- Each state transition and its durable stream event share one Lua transaction.

See [Lua scripts](./lua-scripts.md) for atomic-operation contracts.
