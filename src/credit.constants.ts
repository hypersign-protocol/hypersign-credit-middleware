import { ResolvedCreditOptions } from './credit.types';
export {
  GET_BALANCE_SCRIPT,
  GET_RESERVATION_SCRIPT,
} from './credit.scripts';

export const DEFAULT_KEY_PREFIX = 'credit';
export const DEFAULT_REDIS_HASH_TAG = 'credit';

/** BullMQ job names published or consumed by the SDK. */
export const CREDIT_EVENT_NAMES = {
  RESERVED: 'credit.reserved',
  COMMITTED: 'credit.committed',
  ROLLED_BACK: 'credit.rolled-back',
  EXPIRED: 'credit.expired',
  PLAN_EXPIRED: 'credit.plan-expired',
  CREDIT_GRANTED: 'credit.granted',
  CRITICAL_BALANCE: 'credit.critical-balance',
  COMMAND_REJECTED: 'credit.command-rejected',
  GRANT_REQUESTED: 'credit.grant.requested',
  RESERVE_REQUESTED: 'credit.reserve.requested',
  COMMIT_REQUESTED: 'credit.commit.requested',
  ROLLBACK_REQUESTED: 'credit.rollback.requested',
} as const;

export type CreditEventName =
  typeof CREDIT_EVENT_NAMES[keyof typeof CREDIT_EVENT_NAMES];

export const DEFAULT_CREDIT_OPTIONS: ResolvedCreditOptions = {
  catalog: {
    catalogId: 'unconfigured',
    version: '0',
    routes: [],
  },
  leaseMs: 60_000,
  retentionMs: 7 * 24 * 60 * 60 * 1_000,
  recoveryBatchSize: 100,
  criticalBalance: 0,
  maxActivePlans: 1_000,
  maxPlanAllocationsPerReservation: 100,
  keyPrefix: DEFAULT_KEY_PREFIX,
  redisHashTag: DEFAULT_REDIS_HASH_TAG,
  eventStreamKey: `${DEFAULT_KEY_PREFIX}:v2:{${DEFAULT_REDIS_HASH_TAG}}:events`,
  eventStreamMaxLength: 100_000,
  requestContextResolver: (request: unknown) => {
    const req = request as {
      user?: { id?: string };
      service?: {
        businessId?: string;
        appId?: string;
        id?: string;
        tenantId?: string;
      };
      requestId?: string;
    };
    return {
      subject: {
        appId:
          req.user?.id ??
          req.service?.businessId ??
          req.service?.appId ??
          req.service?.id ??
          '',
        tenantId: req.service?.tenantId,
      },
      requestId: req.requestId,
    };
  },
};
