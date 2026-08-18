export const EXAMPLE_ACCOUNT_ID = 'user_123';
export const EXAMPLE_SUBJECT = {
  appId: EXAMPLE_ACCOUNT_ID,
  appType: 'USER',
  creditType: 'API_CREDIT',
} as const;

export const BLOCKCHAIN_TRANSACTION_SUBJECT = {
  ...EXAMPLE_SUBJECT,
  creditType: 'BLOCKCHAIN_TXN_CREDIT',
} as const;

export const EXAMPLE_COST = {
  CHEAP: 10,
  EXPENSIVE: 70,
  FAILING: 20,
  BLOCKCHAIN_API: 5,
  BLOCKCHAIN_TRANSACTION: 25,
} as const;
