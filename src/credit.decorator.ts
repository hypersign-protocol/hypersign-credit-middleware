import { SetMetadata } from '@nestjs/common';

export const CREDIT_COST_METADATA = 'credit:cost';
export interface CreditCostOptions {
  amount: number;
  settlementMode?: 'IMMEDIATE' | 'DEFERRED';
  operation?: string;
}
export const CreditCost = (
  input: number | CreditCostOptions,
): MethodDecorator & ClassDecorator => {
  const options = typeof input === 'number'
    ? { amount: input, settlementMode: 'IMMEDIATE' as const }
    : { ...input, settlementMode: input.settlementMode ?? 'IMMEDIATE' };
  const { amount } = options;
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new TypeError('Credit cost must be a positive safe integer');
  }

  return SetMetadata(CREDIT_COST_METADATA, options);
};
