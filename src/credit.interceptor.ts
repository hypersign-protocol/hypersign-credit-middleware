import {
  CallHandler,
  BadRequestException,
  ConflictException,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  ServiceUnavailableException,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
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
import { CREDIT_COST_METADATA, CreditCostOptions } from './credit.decorator';
import { CreditService } from './credit.service';
import { CREDIT_BOUNDARY_STATE, CreditBoundaryState } from './credit-boundary.middleware';
import { CREDIT_OPTIONS, ResolvedCreditOptions } from './credit.types';
import { CreditSubject } from './credit.types';

interface CreditRequest {
  [CREDIT_BOUNDARY_STATE]?: CreditBoundaryState;
}

@Injectable()
export class CreditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CreditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly creditService: CreditService,
    @Inject(CREDIT_OPTIONS) private readonly options: ResolvedCreditOptions,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<CreditCostOptions>(
      CREDIT_COST_METADATA,
      [context.getHandler(), context.getClass()],
    );

    if (options === undefined) {
      return next.handle();
    }
    const amount = options.amount;

    const request = context.switchToHttp().getRequest<CreditRequest>();
    const requestContext = this.options.requestContextResolver(request);
    const subject = requestContext.subject;
    if (!subject?.accountId) {
      throw new UnauthorizedException('A billing subject is required');
    }

    const boundary = request[CREDIT_BOUNDARY_STATE];
    const reservation = boundary
      ? this.claimBoundaryReservation(
          boundary,
          options,
          subject,
          requestContext.requestId,
        )
      : this.creditService.reserve({
          subject,
          requestId: requestContext.requestId,
          amount,
          settlementMode: options.settlementMode,
          operation: options.operation ?? context.getHandler().name,
        });

    return from(reservation).pipe(
      mergeMap(({ reservationId, settlementMode, existing }) => {
        if (existing && !boundary) {
          return throwError(() => new ConflictException(
            'This credit requestId already has a reservation',
          ));
        }
        // `defer` converts both a normal Observable and a synchronous throw
        // from a downstream handler into the same rollback path.
        const controllerResult = defer(() => next.handle());
        const resultWithSettlement = settlementMode === 'IMMEDIATE'
          ? controllerResult.pipe(
              concatWith(defer(() => this.commitOrThrow(
                reservationId,
                boundary,
              ))),
            )
          : controllerResult;

        return resultWithSettlement.pipe(
          catchError((controllerError: unknown) => {
            const reason = controllerError instanceof Error
              ? controllerError.message
              : String(controllerError);
            this.logger.warn(
              `Request execution or credit settlement failed; rolling back ` +
              `reservation ${reservationId} ` +
              `(account=${subject.accountId}, amount=${amount}, reason=${reason})`,
            );

            return from(this.creditService.rollback(reservationId, reason)).pipe(
              catchError((rollbackError: unknown) => {
                const message = rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError);
                this.logger.error(
                  `Rollback failed for reservation ${reservationId}: ${message}`,
                );
                return [false];
              }),
              mergeMap((refunded) => {
                if (boundary) boundary.finalized = true;
                if (refunded) {
                  this.logger.log(
                    `Rolled back reservation ${reservationId}; refunded ${amount} ` +
                    `credits to account ${subject.accountId}`,
                  );
                } else {
                  this.logger.warn(
                    `Reservation ${reservationId} was already finalized; no refund applied`,
                  );
                }
                return throwError(() => controllerError);
              }),
            );
          }),
        );
      }),
    );
  }

  private commitOrThrow(
    reservationId: string,
    boundary?: CreditBoundaryState,
  ): Observable<never> {
    return from(this.creditService.commit(reservationId)).pipe(
      mergeMap((committed) => {
        if (!committed) {
          return throwError(() => new ServiceUnavailableException(
            `Credit reservation ${reservationId} could not be committed`,
          ));
        }
        if (boundary) boundary.finalized = true;
        return EMPTY;
      }),
    );
  }

  private async claimBoundaryReservation(
    boundary: CreditBoundaryState,
    options: CreditCostOptions,
    subject: CreditSubject,
    requestId?: string,
  ) {
    const reservation = await this.creditService.getReservation(
      boundary.reservationId,
    );
    const settlementMode = options.settlementMode ?? 'IMMEDIATE';
    if (
      !reservation ||
      reservation.status !== 'RESERVED' ||
      reservation.scopeId !== boundary.scopeId ||
      !this.sameSubject(reservation.subject, subject) ||
      reservation.amount !== options.amount ||
      reservation.settlementMode !== settlementMode ||
      (requestId && reservation.requestId !== requestId) ||
      (options.operation && reservation.operation !== options.operation)
    ) {
      throw new BadRequestException(
        'Early credit reservation does not match route credit metadata',
      );
    }
    boundary.claimedByInterceptor = true;
    return {
      reservationId: reservation.reservationId,
      remainingBalance: reservation.remainingBalance,
      expiresAt: reservation.expiresAt,
      autoRecover: reservation.autoRecover,
      existing: true,
      settlementMode: reservation.settlementMode,
    };
  }

  private sameSubject(left: CreditSubject, right: CreditSubject): boolean {
    const value = (input?: string): string => input?.trim() ?? '';
    return value(left.accountId) === value(right.accountId) &&
      value(left.tenantId) === value(right.tenantId) &&
      value(left.accountType) === value(right.accountType) &&
      value(left.serviceId) === value(right.serviceId) &&
      value(left.creditType) === value(right.creditType);
  }
}
