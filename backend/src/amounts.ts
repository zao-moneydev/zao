export const USDC_DECIMALS = 7n;

export function toStroops(amount: string | number): bigint {
  const [whole, frac = ""] = String(amount).split(".");
  const padded = (frac + "0000000").slice(0, 7);
  return BigInt(whole) * 10n ** USDC_DECIMALS + BigInt(padded);
}

export function fromStroops(amount: bigint | string | number): string {
  const value = BigInt(amount);
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const whole = abs / 10n ** USDC_DECIMALS;
  const frac = (abs % 10n ** USDC_DECIMALS).toString().padStart(7, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export function dueAmount(principal: bigint): bigint {
  return principal + principal / 10n;
}
