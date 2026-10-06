// Currencies and payment methods the desk accepts. ISO 4217 codes with their minor-unit exponent.

export const CURRENCIES = {
  NGN: { name: 'Nigerian naira', exponent: 2 },
  USD: { name: 'US dollar', exponent: 2 },
  EUR: { name: 'Euro', exponent: 2 },
  GBP: { name: 'Pound sterling', exponent: 2 },
  KES: { name: 'Kenyan shilling', exponent: 2 },
  GHS: { name: 'Ghanaian cedi', exponent: 2 },
  ZAR: { name: 'South African rand', exponent: 2 },
  BRL: { name: 'Brazilian real', exponent: 2 },
  INR: { name: 'Indian rupee', exponent: 2 },
} as const;

export type Currency = keyof typeof CURRENCIES;

export const METHODS = {
  bank_transfer: 'Bank transfer',
  mobile_money: 'Mobile money',
  instant_payment: 'Instant payment (SEPA Instant, Pix, UPI, …)',
} as const;

export type Method = keyof typeof METHODS;

export const isCurrency = (c: unknown): c is Currency => typeof c === 'string' && Object.hasOwn(CURRENCIES, c);
export const isMethod = (m: unknown): m is Method => typeof m === 'string' && Object.hasOwn(METHODS, m);
export const currencyExponent = (c: string) => (isCurrency(c) ? CURRENCIES[c].exponent : 2);
