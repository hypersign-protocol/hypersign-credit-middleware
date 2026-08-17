import {
  Inject,
  Injectable,
  Logger,
  NestMiddleware,
} from '@nestjs/common';
import { CreditCatalogService, ResolvedCreditCatalogRoute } from './credit.catalog';
import {
  AppliedCreditReservation,
  CreditPolicyExecutor,
} from './credit-policy.executor';
import { CREDIT_OPTIONS, ResolvedCreditOptions } from './credit.types';

export const CREDIT_BOUNDARY_STATE = Symbol('CREDIT_BOUNDARY_STATE');

export interface CreditBoundaryState {
  route: ResolvedCreditCatalogRoute;
  reservations: AppliedCreditReservation[];
  claimedByInterceptor: boolean;
  finalized: boolean;
}

interface BoundaryRequest {
  method: string;
  originalUrl?: string;
  url?: string;
  [CREDIT_BOUNDARY_STATE]?: CreditBoundaryState;
}

interface BoundaryResponse {
  once(event: 'finish' | 'close', listener: () => void): unknown;
}

/** Optional early boundary driven from catalog routes marked `boundary: true`. */
@Injectable()
export class CreditBoundaryMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CreditBoundaryMiddleware.name);

  constructor(
    private readonly catalog: CreditCatalogService,
    private readonly executor: CreditPolicyExecutor,
    @Inject(CREDIT_OPTIONS) private readonly options: ResolvedCreditOptions,
  ) {}

  async use(
    request: BoundaryRequest,
    response: BoundaryResponse,
    next: () => void,
  ): Promise<void> {
    const route = this.catalog.find(
      request.method,
      request.originalUrl ?? request.url ?? '',
    );
    if (!route || !route.boundary || route.charges.length === 0) return next();

    const reservations = await this.executor.reserve(
      route,
      this.options.requestContextResolver(request),
    );
    const state: CreditBoundaryState = {
      route,
      reservations,
      claimedByInterceptor: false,
      finalized: false,
    };
    request[CREDIT_BOUNDARY_STATE] = state;

    const releaseIfUnclaimed = () => {
      if (state.claimedByInterceptor || state.finalized) return;
      state.finalized = true;
      void this.executor.rollbackAll(
        state.reservations,
        'response_ended_before_credit_interceptor',
      ).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to roll back unclaimed reservations: ${message}`);
      });
    };
    response.once('finish', releaseIfUnclaimed);
    response.once('close', releaseIfUnclaimed);
    next();
  }
}
