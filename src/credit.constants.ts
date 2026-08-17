import { ResolvedCreditOptions } from './credit.types';
export {
  GET_BALANCE_SCRIPT,
  GET_RESERVATION_SCRIPT,
} from './credit.scripts';

export const DEFAULT_KEY_PREFIX = 'credit';
export const DEFAULT_REDIS_HASH_TAG = 'credit';

export const DEFAULT_CREDIT_OPTIONS: ResolvedCreditOptions = {
  catalog: {
    serviceId: 'unconfigured',
    version: '0',
    routes: [],
  },
  leaseMs: 60_000,
  retentionMs: 7 * 24 * 60 * 60 * 1_000,
  recoveryBatchSize: 100,
  criticalBalance: 0,
  initializationLockMs: 5_000,
  keyPrefix: DEFAULT_KEY_PREFIX,
  redisHashTag: DEFAULT_REDIS_HASH_TAG,
  eventStreamKey: `${DEFAULT_KEY_PREFIX}:{${DEFAULT_REDIS_HASH_TAG}}:events`,
  eventStreamMaxLength: 100_000,
  requestContextResolver: (request: unknown) => {
    const req = request as {
      user?: { id?: string };
      service?: {
        businessId?: string;
        accountId?: string;
        id?: string;
        tenantId?: string;
        serviceId?: string;
      };
      requestId?: string;
    };
    return {
      subject: {
        accountId:
          req.user?.id ??
          req.service?.businessId ??
          req.service?.accountId ??
          req.service?.id ??
          '',
        tenantId: req.service?.tenantId,
        serviceId: req.service?.serviceId,
      },
      requestId: req.requestId,
    };
  },
};
