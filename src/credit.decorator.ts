import { SetMetadata } from '@nestjs/common';

export const CREDIT_COST_METADATA = 'credit:cost';
export const CreditCost = (amount: number): MethodDecorator & ClassDecorator => {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new TypeError('Credit cost must be a positive safe integer');
  }

  return SetMetadata(CREDIT_COST_METADATA, amount);
};
