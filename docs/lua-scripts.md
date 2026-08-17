# Redis Lua scripts

Lua makes each balance mutation, reservation transition, idempotency update,
expiration-index update, and durable event atomic. Redis cannot expose a
partially completed transition to another client.

The source of truth in the repository is `src/credit.scripts.ts`; packaged
JavaScript is emitted as `dist/credit.scripts.js`.

## Conventions

- `KEYS[n]` is a complete key from `CreditKeyspace`.
- `ARGV[n]` is a scalar supplied by `CreditService`.
- Timestamps and TTLs use milliseconds.
- Optional strings are stored as `''` and restored as `undefined`.
- All keys share the configured Redis Cluster hash tag.

## RESERVE_SCRIPT

Validates request idempotency, checks balance, deducts credit, creates the
reservation/request hashes, optionally indexes expiry, appends `RESERVED`, and
also appends `CRITICAL_BALANCE` when the resulting balance reaches the configured
threshold.

Keys:

1. balance string
2. reservation hash
3. request hash
4. expiration sorted set
5. event stream

Arguments:

1. amount
2. reservation ID
3. scope ID
4–8. account ID, tenant ID, account type, service ID, credit type
9. request ID
10. current time
11. lease duration
12. lease token
13. retention duration (retained in the call contract)
14. settlement mode
15. operation
16. `1`/`0` auto-recovery
17. critical-balance threshold
18. stream maximum length

Success returns:

```text
[reservationId, remainingBalance, expiresAt, existing, leaseToken, autoRecover]
```

Special results: `-1` insufficient balance; `-2` request ID reused with
different semantics; `-3` missing balance. An idempotent retry returns the
existing reservation without deducting or emitting again.

## COMMIT_SCRIPT

Changes `RESERVED` to `COMMITTED`, removes expiry, applies retention TTLs to
the reservation/request hashes, and appends `COMMITTED`. Commit does not mutate
balance because reserve already deducted it.

Keys: reservation hash, expiration sorted set, event stream, request hash.

Arguments: current time, reservation ID, retention TTL, stream maximum length.

Success returns:

```text
[1, scopeId, accountId, tenantId, accountType, serviceId, creditType,
 amount, operation, balanceAfter]
```

`balanceAfter` is the remaining balance stored during reserve. `[0]` means
already committed, `[-1]` means another final state, and `[-2]` means missing.

## ROLLBACK_SCRIPT

Verifies the stored balance key, refunds with `INCRBY`, finalizes, removes
expiry, applies retention, and appends the rollback event.

Keys: reservation, expirations, stream, balance, request hash.

Arguments: final status, time, reason, reservation ID, retention TTL, stream
maximum length. Success returns finalization fields plus refunded
`balanceAfter`. `[0]` means not active; `[-2]` means balance-key mismatch.

## RENEW_SCRIPT

Extends an active lease, increments reservation `version`, and updates the
sorted-set score when auto-recovery is enabled.

Keys: reservation and expirations. Arguments: lease token, time, lease
duration, reservation ID. Returns new expiry; `-1` means not reserved and `-2`
means invalid lease token.

## FIND_EXPIRED_SCRIPT

Returns at most `batchSize` expiration members with score `<= now`.

Key: expirations. Arguments: time and batch size. This is a read operation;
`RECOVER_SCRIPT` rechecks all conditions before mutation.

## REMOVE_EXPIRATION_SCRIPT

Removes one dangling reservation ID when its hash no longer exists. Key:
expirations. Argument: reservation ID. Returns the `ZREM` count.

## RECOVER_SCRIPT

Rechecks status, auto-recovery, and expiry; verifies the balance key; refunds;
marks `EXPIRED`; removes the index member; applies retention; and appends
`EXPIRED`.

Keys: reservation, expirations, stream, balance, request hash.

Arguments: time, reservation ID, retention TTL, stream maximum length. Success
returns finalization fields plus refunded balance. `[0]` means no recovery was
needed/allowed; `[-2]` means balance-key mismatch. The atomic recheck makes
concurrent recovery workers safe—only one can refund.

## ACQUIRE_LOCK_SCRIPT

Acquires a per-wallet initialization lock using `SET NX PX`.

Key: initialization lock. Arguments: random token and TTL. Returns `1` when
acquired, otherwise `0`.

## INITIALIZE_BALANCE_SCRIPT

Sets a provider balance only if the wallet is still absent after lock
acquisition and appends `BALANCE_INITIALIZED` in the same atomic operation.

Keys: balance and event stream.

Arguments: initial balance, time, scope ID, five subject dimensions, provider
source, provider revision, and stream maximum length. Returns `1` when written,
otherwise `0`.

## RELEASE_LOCK_SCRIPT

Deletes the initialization lock only if it still contains the caller's token,
so an expired owner cannot delete a newer owner's lock. Key: lock. Argument:
token. Returns delete count or `0`.

## GRANT_SCRIPT

Applies an idempotent top-up, stores the reference record with retention, and
appends `CREDIT_GRANTED`.

Keys: balance, grant hash, event stream.

Arguments: amount, time, scope ID, five subject dimensions, reference ID,
reason, retention TTL, stream maximum length. Returns `[balance, existing]`.
`[-1]` means reference reused with another amount; `[-2]` means missing wallet.

## GET_RESERVATION_SCRIPT and GET_BALANCE_SCRIPT

These read scripts call `HGETALL` and `GET`. A missing balance returns Redis
nil, mapped to `null`; it is deliberately distinct from a stored zero.

## Safe-change checklist

1. Keep the TypeScript key/argument order synchronized with this document.
2. Preserve the single Redis Cluster slot invariant.
3. Update the in-memory Redis behavior in `test/credit.service.spec.ts`.
4. Test retry, competing finalizers, missing keys, and special return codes.
5. Update stream fields and public event types together.
