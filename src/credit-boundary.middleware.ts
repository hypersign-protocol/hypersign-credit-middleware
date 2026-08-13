import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CreditService } from './credit.service';
import {
  CREDIT_OPTIONS,
  EarlyCreditPolicy,
  ResolvedCreditOptions,
} from './credit.types';

export const CREDIT_BOUNDARY_STATE = Symbol('CREDIT_BOUNDARY_STATE');

export interface CreditBoundaryState {
  reservationId: string;
  scopeId: string;
  requestId: string;
  policy: EarlyCreditPolicy;
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

/** Optional early credit boundary; register it before application middleware. */
@Injectable()
export class CreditBoundaryMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CreditBoundaryMiddleware.name);

  constructor(
    private readonly credits: CreditService,
    @Inject(CREDIT_OPTIONS) private readonly options: ResolvedCreditOptions,
  ) {}

  async use(
    request: BoundaryRequest,
    response: BoundaryResponse,
    next: () => void,
  ): Promise<void> {
    const policy = this.findPolicy(request);
    if (!policy) return next();

    const context = this.options.requestContextResolver(request);
    if (!context.subject?.accountId) {
      throw new UnauthorizedException('A billing subject is required');
    }
    if (!Number.isSafeInteger(policy.amount) || policy.amount <= 0) {
      throw new BadRequestException('Early credit policy amount is invalid');
    }
    const requestId = context.requestId ?? randomUUID();
    const result = await this.credits.reserve({
      subject: context.subject,
      requestId,
      amount: policy.amount,
      settlementMode: policy.settlementMode ?? 'IMMEDIATE',
      operation: policy.operation,
    });
    if (result.existing) {
      throw new ConflictException(
        'This credit requestId already has a reservation',
      );
    }
    const state: CreditBoundaryState = {
      reservationId: result.reservationId,
      scopeId: result.scopeId,
      requestId,
      policy,
      claimedByInterceptor: false,
      finalized: false,
    };
    request[CREDIT_BOUNDARY_STATE] = state;

    const releaseIfUnclaimed = () => {
      if (state.claimedByInterceptor || state.finalized) return;
      state.finalized = true;
      void this.credits.rollback(
        state.reservationId,
        'response_ended_before_credit_interceptor',
      ).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to roll back unclaimed reservation ${state.reservationId}: ${message}`,
          error instanceof Error ? error.stack : undefined,
        );
      });
    };
    response.once('finish', releaseIfUnclaimed);
    response.once('close', releaseIfUnclaimed);
    next();
  }

  private findPolicy(request: BoundaryRequest): EarlyCreditPolicy | undefined {
    const pathname = (request.originalUrl ?? request.url ?? '').split('?')[0];
    return this.options.earlyPolicies.find((policy) =>
      policy.method.toUpperCase() === request.method.toUpperCase() &&
      this.matches(policy.path, pathname),
    );
  }

  private matches(template: string, pathname: string): boolean {
    const parts = template.split('/').map((part) =>
      part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    );
    return new RegExp(`^${parts.join('/')}/?$`).test(pathname);
  }
}
