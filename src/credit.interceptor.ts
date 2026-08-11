import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, catchError, from, mergeMap, throwError } from 'rxjs';
import { CREDIT_COST_METADATA } from './credit.decorator';
import { CreditService } from './credit.service';

interface CreditRequest {
  user?: { id?: string };
  requestId?: string;
}

@Injectable()
export class CreditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CreditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly creditService: CreditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const amount = this.reflector.getAllAndOverride<number>(
      CREDIT_COST_METADATA,
      [context.getHandler(), context.getClass()],
    );

    if (amount === undefined) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<CreditRequest>();
    const accountId = request.user?.id;
    if (!accountId) {
      throw new UnauthorizedException('A user account is required for credit billing');
    }

    return from(
      this.creditService.reserve({
        accountId,
        requestId: request.requestId,
        serviceId: context.getHandler().name,
        amount,
      }),
    ).pipe(
      mergeMap(({ reservationId }) =>
        next.handle().pipe(
          mergeMap((value) =>
            from(this.creditService.commit(reservationId)).pipe(
              mergeMap(() => [value]),
            ),
          ),
          catchError((controllerError: unknown) => {
            const reason = controllerError instanceof Error
              ? controllerError.message
              : String(controllerError);
            this.logger.warn(
              `Controller failed; rolling back reservation ${reservationId} ` +
              `(account=${accountId}, amount=${amount}, reason=${reason})`,
            );

            return from(this.creditService.rollback(reservationId)).pipe(
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
                if (refunded) {
                  this.logger.log(
                    `Rolled back reservation ${reservationId}; refunded ${amount} ` +
                    `credits to account ${accountId}`,
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
        ),
      ),
    );
  }
}
