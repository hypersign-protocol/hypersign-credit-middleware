/**
 * Redis Lua programs used by CreditService.
 *
 * Keep these scripts free of application policy. Their job is to make each
 * multi-key state transition atomic. See docs/lua-scripts.md for the complete
 * KEYS/ARGV/return-code contract.
 */

export const RESERVE_SCRIPT = `
local existingId = redis.call('HGET', KEYS[3], 'reservationId')
if existingId then
  if redis.call('HGET', KEYS[3], 'amount') ~= ARGV[1]
    or redis.call('HGET', KEYS[3], 'settlementMode') ~= ARGV[14]
    or redis.call('HGET', KEYS[3], 'operation') ~= ARGV[15]
    or redis.call('HGET', KEYS[3], 'autoRecover') ~= ARGV[16] then
    return {-2}
  end
  return {existingId, redis.call('HGET', KEYS[3], 'remainingBalance'),
    redis.call('HGET', KEYS[3], 'expiresAt'), 1,
    redis.call('HGET', KEYS[3], 'leaseToken'),
    redis.call('HGET', KEYS[3], 'autoRecover')}
end
local rawBalance = redis.call('GET', KEYS[1])
if not rawBalance then return {-3} end
local balance = tonumber(rawBalance)
local amount = tonumber(ARGV[1])
if balance < amount then return {-1} end
local expiresAt = tonumber(ARGV[10]) + tonumber(ARGV[11])
local remaining = redis.call('DECRBY', KEYS[1], amount)
redis.call('HSET', KEYS[2],
  'reservationId', ARGV[2], 'scopeId', ARGV[3], 'appId', ARGV[4],
  'tenantId', ARGV[5], 'appType', ARGV[6], 'serviceId', ARGV[7],
  'creditType', ARGV[8], 'requestId', ARGV[9], 'amount', ARGV[1],
  'remainingBalance', remaining, 'status', 'RESERVED', 'leaseToken', ARGV[12],
  'createdAt', ARGV[10], 'expiresAt', expiresAt, 'version', 1,
  'settlementMode', ARGV[14], 'operation', ARGV[15],
  'autoRecover', ARGV[16], 'balanceKey', KEYS[1])
if ARGV[16] == '1' then redis.call('ZADD', KEYS[4], expiresAt, ARGV[2]) end
redis.call('HSET', KEYS[3], 'reservationId', ARGV[2],
  'remainingBalance', remaining, 'expiresAt', expiresAt,
  'amount', ARGV[1], 'settlementMode', ARGV[14], 'operation', ARGV[15],
  'leaseToken', ARGV[12], 'autoRecover', ARGV[16])
redis.call('XADD', KEYS[5], 'MAXLEN', '~', ARGV[18], '*',
  'event', 'RESERVED', 'timestamp', ARGV[10], 'scopeId', ARGV[3],
  'appId', ARGV[4], 'tenantId', ARGV[5], 'appType', ARGV[6],
  'serviceId', ARGV[7], 'creditType', ARGV[8], 'requestId', ARGV[9],
  'operation', ARGV[15], 'amount', ARGV[1], 'reservationId', ARGV[2],
  'settlementMode', ARGV[14], 'autoRecover', ARGV[16],
  'expiresAt', expiresAt,
  'balanceAfter', remaining)
if remaining <= tonumber(ARGV[17]) then
  redis.call('XADD', KEYS[5], 'MAXLEN', '~', ARGV[18], '*',
    'event', 'CRITICAL_BALANCE', 'timestamp', ARGV[10], 'scopeId', ARGV[3],
    'appId', ARGV[4], 'tenantId', ARGV[5], 'appType', ARGV[6],
    'serviceId', ARGV[7], 'creditType', ARGV[8],
    'balance', remaining, 'threshold', ARGV[17])
end
return {ARGV[2], remaining, expiresAt, 0, ARGV[12], ARGV[16]}
`;

export const COMMIT_SCRIPT = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return {-2} end
if status == 'COMMITTED' then return {0} end
if status ~= 'RESERVED' then return {-1} end
local fields = redis.call('HMGET', KEYS[1], 'scopeId', 'appId', 'tenantId',
  'appType', 'serviceId', 'creditType', 'amount', 'operation',
  'remainingBalance')
redis.call('HSET', KEYS[1], 'status', 'COMMITTED', 'finalizedAt', ARGV[1],
  'finalizationReason', 'controller_succeeded')
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('PEXPIRE', KEYS[4], tonumber(ARGV[3]))
redis.call('XADD', KEYS[3], 'MAXLEN', '~', ARGV[4], '*',
  'event', 'COMMITTED', 'timestamp', ARGV[1], 'reservationId', ARGV[2],
  'scopeId', fields[1], 'appId', fields[2], 'tenantId', fields[3],
  'appType', fields[4], 'serviceId', fields[5], 'creditType', fields[6],
  'amount', fields[7], 'operation', fields[8], 'balanceAfter', fields[9])
return {1, fields[1], fields[2], fields[3], fields[4], fields[5], fields[6],
  fields[7], fields[8], fields[9]}
`;

export const ROLLBACK_SCRIPT = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status or status ~= 'RESERVED' then return {0} end
if redis.call('HGET', KEYS[1], 'balanceKey') ~= KEYS[4] then return {-2} end
local fields = redis.call('HMGET', KEYS[1], 'scopeId', 'appId', 'tenantId',
  'appType', 'serviceId', 'creditType', 'amount', 'operation')
local remaining = redis.call('INCRBY', KEYS[4], fields[7])
redis.call('HSET', KEYS[1], 'status', ARGV[1], 'finalizedAt', ARGV[2],
  'finalizationReason', ARGV[3], 'remainingBalance', remaining)
redis.call('ZREM', KEYS[2], ARGV[4])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
redis.call('PEXPIRE', KEYS[5], tonumber(ARGV[5]))
redis.call('XADD', KEYS[3], 'MAXLEN', '~', ARGV[6], '*',
  'event', ARGV[1], 'timestamp', ARGV[2], 'reservationId', ARGV[4],
  'scopeId', fields[1], 'appId', fields[2], 'tenantId', fields[3],
  'appType', fields[4], 'serviceId', fields[5], 'creditType', fields[6],
  'amount', fields[7], 'operation', fields[8], 'reason', ARGV[3],
  'balanceAfter', remaining)
return {1, fields[1], fields[2], fields[3], fields[4], fields[5], fields[6],
  fields[7], fields[8], remaining}
`;

export const RENEW_SCRIPT = `
if redis.call('HGET', KEYS[1], 'status') ~= 'RESERVED' then return -1 end
if redis.call('HGET', KEYS[1], 'leaseToken') ~= ARGV[1] then return -2 end
local expiresAt = tonumber(ARGV[2]) + tonumber(ARGV[3])
redis.call('HSET', KEYS[1], 'expiresAt', expiresAt)
redis.call('HINCRBY', KEYS[1], 'version', 1)
if redis.call('HGET', KEYS[1], 'autoRecover') ~= '0' then
  redis.call('ZADD', KEYS[2], expiresAt, ARGV[4])
end
return expiresAt
`;

export const FIND_EXPIRED_SCRIPT = `
return redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1],
  'LIMIT', 0, tonumber(ARGV[2]))
`;

export const REMOVE_EXPIRATION_SCRIPT = `
return redis.call('ZREM', KEYS[1], ARGV[1])
`;

export const RECOVER_SCRIPT = `
if redis.call('HGET', KEYS[1], 'status') ~= 'RESERVED' then
  redis.call('ZREM', KEYS[2], ARGV[2])
  return {0}
end
if redis.call('HGET', KEYS[1], 'autoRecover') == '0' then
  redis.call('ZREM', KEYS[2], ARGV[2])
  return {0}
end
local expiresAt = tonumber(redis.call('HGET', KEYS[1], 'expiresAt') or '0')
if expiresAt > tonumber(ARGV[1]) then return {0} end
if redis.call('HGET', KEYS[1], 'balanceKey') ~= KEYS[4] then return {-2} end
local fields = redis.call('HMGET', KEYS[1], 'scopeId', 'appId', 'tenantId',
  'appType', 'serviceId', 'creditType', 'amount', 'operation')
local remaining = redis.call('INCRBY', KEYS[4], fields[7])
redis.call('HSET', KEYS[1], 'status', 'EXPIRED', 'finalizedAt', ARGV[1],
  'finalizationReason', 'lease_expired', 'remainingBalance', remaining)
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('PEXPIRE', KEYS[5], tonumber(ARGV[3]))
redis.call('XADD', KEYS[3], 'MAXLEN', '~', ARGV[4], '*',
  'event', 'EXPIRED', 'timestamp', ARGV[1], 'reservationId', ARGV[2],
  'scopeId', fields[1], 'appId', fields[2], 'tenantId', fields[3],
  'appType', fields[4], 'serviceId', fields[5], 'creditType', fields[6],
  'amount', fields[7], 'operation', fields[8], 'reason', 'lease_expired',
  'balanceAfter', remaining)
return {1, fields[1], fields[2], fields[3], fields[4], fields[5], fields[6],
  fields[7], fields[8], remaining}
`;

export const ACQUIRE_LOCK_SCRIPT = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])
then return 1 else return 0 end
`;

export const INITIALIZE_BALANCE_SCRIPT = `
if redis.call('GET', KEYS[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[11], '*',
  'event', 'BALANCE_INITIALIZED', 'timestamp', ARGV[2], 'scopeId', ARGV[3],
  'appId', ARGV[4], 'tenantId', ARGV[5], 'appType', ARGV[6],
  'serviceId', ARGV[7], 'creditType', ARGV[8], 'balance', ARGV[1],
  'source', ARGV[9], 'revision', ARGV[10])
return 1
`;

export const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1]
then return redis.call('DEL', KEYS[1]) else return 0 end
`;

export const GRANT_SCRIPT = `
local existingAmount = redis.call('HGET', KEYS[2], 'amount')
if existingAmount then
  if existingAmount ~= ARGV[1] then return {-1} end
  local currentBalance = redis.call('GET', KEYS[1])
  if not currentBalance then return {-2} end
  return {currentBalance, 1}
end
if not redis.call('GET', KEYS[1]) then return {-2} end
local balance = redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[2], 'amount', ARGV[1], 'balance', balance)
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[11]))
redis.call('XADD', KEYS[3], 'MAXLEN', '~', ARGV[12], '*',
  'event', 'CREDIT_GRANTED', 'timestamp', ARGV[2], 'scopeId', ARGV[3],
  'appId', ARGV[4], 'tenantId', ARGV[5], 'appType', ARGV[6],
  'serviceId', ARGV[7], 'creditType', ARGV[8], 'referenceId', ARGV[9],
  'reason', ARGV[10], 'amount', ARGV[1], 'balanceAfter', balance)
return {balance, 0}
`;

/** Fetches a reservation hash as a flat field/value array. */
export const GET_RESERVATION_SCRIPT = `return redis.call('HGETALL', KEYS[1])`;

/** Returns nil for an uninitialized wallet instead of conflating it with zero. */
export const GET_BALANCE_SCRIPT = `return redis.call('GET', KEYS[1])`;
