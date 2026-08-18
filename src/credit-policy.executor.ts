import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CreditCatalogService,
  ResolvedCreditCatalogCharge,
  ResolvedCreditCatalogRoute,
} from './credit.catalog';
import { CreditService } from './credit.service';
import {
  CreditRequestContext,
  CreditSubject,
  ReserveCreditResult,
} from './credit.types';

export interface AppliedCreditReservation {
  charge: ResolvedCreditCatalogCharge;
  reservation: ReserveCreditResult;
}

/** Shared catalog execution used by the HTTP interceptor and early boundary. */
@Injectable()
export class CreditPolicyExecutor {
  constructor(
    private readonly credits: CreditService,
    private readonly catalog: CreditCatalogService,
  ) {}

  async reserve(
    route: ResolvedCreditCatalogRoute,
    context: CreditRequestContext,
  ): Promise<AppliedCreditReservation[]> {
    if (!context.subject?.appId) {
      throw new UnauthorizedException('A billing subject is required');
    }
    const requestId = context.requestId?.trim() || randomUUID();
    const applied: AppliedCreditReservation[] = [];
    try {
      for (const charge of route.charges) {
        const reservation = await this.credits.reserve({
          subject: this.subject(context.subject, charge.creditType),
          requestId: `${requestId}:${charge.id}`,
          amount: charge.amount,
          settlementMode: charge.settlementMode,
          operation: route.operation,
          autoRecover: charge.autoRecover,
        });
        applied.push({ charge, reservation });
      }
      if (applied.some(({ reservation }) => reservation.existing)) {
        throw new ConflictException('This credit requestId already has a reservation');
      }
      return applied;
    } catch (error) {
      await this.rollbackNew(applied, 'catalog_reservation_failed');
      throw error;
    }
  }

  async claim(
    route: ResolvedCreditCatalogRoute,
    context: CreditRequestContext,
    applied: AppliedCreditReservation[],
  ): Promise<AppliedCreditReservation[]> {
    if (applied.length !== route.charges.length) {
      throw new BadRequestException('Early credit reservation count does not match catalog');
    }
    for (let index = 0; index < route.charges.length; index++) {
      const expected = route.charges[index];
      const value = applied[index];
      const stored = await this.credits.getReservation(value.reservation.reservationId);
      const subject = this.subject(context.subject, expected.creditType);
      if (!stored || stored.status !== 'RESERVED' ||
          stored.amount !== expected.amount ||
          stored.settlementMode !== expected.settlementMode ||
          stored.autoRecover !== expected.autoRecover ||
          stored.operation !== route.operation ||
          !sameSubject(stored.subject, subject)) {
        throw new BadRequestException(
          `Early credit reservation does not match catalog charge ${expected.id}`,
        );
      }
    }
    return applied;
  }

  async rollbackAll(applied: AppliedCreditReservation[], reason: string): Promise<void> {
    await Promise.all(applied.map(({ reservation }) =>
      this.credits.rollback(reservation.reservationId, reason),
    ));
  }

  private async rollbackNew(
    applied: AppliedCreditReservation[],
    reason: string,
  ): Promise<void> {
    await Promise.all(applied
      .filter(({ reservation }) => !reservation.existing)
      .map(({ reservation }) => this.credits.rollback(reservation.reservationId, reason)));
  }

  private subject(base: CreditSubject, creditType: string): CreditSubject {
    return { ...base, creditType };
  }
}

function sameSubject(left: CreditSubject, right: CreditSubject): boolean {
  const value = (input?: string): string => input?.trim() ?? '';
  return value(left.appId) === value(right.appId) &&
    value(left.tenantId) === value(right.tenantId) &&
    value(left.appType) === value(right.appType) &&
    value(left.creditType) === value(right.creditType);
}
