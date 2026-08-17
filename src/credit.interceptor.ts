import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  EMPTY,
  Observable,
  catchError,
  concatWith,
  defer,
  from,
  mergeMap,
  throwError,
} from 'rxjs';
import {
  CreditCatalogMismatchException,
  CreditCatalogService,
  ResolvedCreditCatalogRoute,
} from './credit.catalog';
import {
  CREDIT_BOUNDARY_STATE,
  CreditBoundaryState,
} from './credit-boundary.middleware';
import {
  AppliedCreditReservation,
  CreditPolicyExecutor,
} from './credit-policy.executor';
import { CreditService } from './credit.service';
import {
  CREDIT_OPTIONS,
  CreditRequestContext,
  ResolvedCreditOptions,
} from './credit.types';

export const CREDIT_REQUEST_STATE = Symbol('CREDIT_REQUEST_STATE');

export interface CreditRequestState {
  route: { method: string; path: string; operation: string };
  reservations: AppliedCreditReservation[];
}

interface CreditRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  [CREDIT_BOUNDARY_STATE]?: CreditBoundaryState;
  [CREDIT_REQUEST_STATE]?: CreditRequestState;
}

/** Applies the selected service catalog to every Nest HTTP route. */
@Injectable()
export class CreditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CreditInterceptor.name);

  constructor(
    private readonly catalog: CreditCatalogService,
    private readonly executor: CreditPolicyExecutor,
    private readonly credits: CreditService,
    @Inject(CREDIT_OPTIONS) private readonly options: ResolvedCreditOptions,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<CreditRequest>();
    const method = request.method ?? '';
    const path = request.originalUrl ?? request.url ?? '';
    const route = this.catalog.find(method, path);
    if (!route) {
      throw new CreditCatalogMismatchException(`${method} ${path} is not cataloged`);
    }
    if (route.charges.length === 0) return next.handle();

    const requestContext = this.options.requestContextResolver(request);
    const boundary = request[CREDIT_BOUNDARY_STATE];
    const reservationPromise = boundary
      ? this.claimBoundary(route, requestContext, boundary)
      : this.executor.reserve(route, requestContext);

    return from(reservationPromise).pipe(
      mergeMap((reservations) => {
        request[CREDIT_REQUEST_STATE] = {
          route: { method: route.method, path: route.path, operation: route.operation },
          reservations,
        };
        const controllerResult = defer(() => next.handle());
        return controllerResult.pipe(
          concatWith(defer(() => this.commitImmediate(reservations, boundary))),
          catchError((error: unknown) => this.rollbackAndRethrow(
            reservations,
            boundary,
            error,
          )),
        );
      }),
    );
  }

  private async claimBoundary(
    route: ResolvedCreditCatalogRoute,
    requestContext: CreditRequestContext,
    boundary: CreditBoundaryState,
  ): Promise<AppliedCreditReservation[]> {
    if (boundary.route.method !== route.method || boundary.route.path !== route.path) {
      throw new CreditCatalogMismatchException('early boundary route changed before interceptor');
    }
    const reservations = await this.executor.claim(
      route,
      requestContext,
      boundary.reservations,
    );
    boundary.claimedByInterceptor = true;
    return reservations;
  }

  private commitImmediate(
    reservations: AppliedCreditReservation[],
    boundary?: CreditBoundaryState,
  ): Observable<never> {
    return from(this.commitSequentially(reservations)).pipe(
      mergeMap(() => {
        if (boundary) boundary.finalized = true;
        return EMPTY;
      }),
    );
  }

  private async commitSequentially(reservations: AppliedCreditReservation[]): Promise<void> {
    for (const { charge, reservation } of reservations) {
      if (charge.settlementMode !== 'IMMEDIATE') continue;
      if (!await this.credits.commit(reservation.reservationId)) {
        throw new ServiceUnavailableException(
          `Credit reservation ${reservation.reservationId} could not be committed`,
        );
      }
    }
  }

  private rollbackAndRethrow(
    reservations: AppliedCreditReservation[],
    boundary: CreditBoundaryState | undefined,
    error: unknown,
  ): Observable<never> {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(
      `Request execution or credit settlement failed; rolling back ` +
      `${reservations.length} reservation(s) (reason=${reason})`,
    );
    return from(this.executor.rollbackAll(reservations, reason)).pipe(
      catchError((rollbackError: unknown) => {
        const message = rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);
        this.logger.error(`One or more credit rollbacks failed: ${message}`);
        return [undefined];
      }),
      mergeMap(() => {
        if (boundary) boundary.finalized = true;
        return throwError(() => error);
      }),
    );
  }
}

export function getCreditRequestState(request: unknown): CreditRequestState | undefined {
  return (request as CreditRequest | undefined)?.[CREDIT_REQUEST_STATE];
}
