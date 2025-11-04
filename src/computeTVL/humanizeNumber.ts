export function humanizeNumber(amount: number): string {
  if (amount < 0) return '-' + humanizeNumber(-amount);

  const quantifiers = [
    [10 ** 12, "T"],
    [10 ** 9, "B"],
    [10 ** 6, "M"],
    [10 ** 3, "k"],
  ] as [number, string][];
  for (const [denominator, letter] of quantifiers) {
    if (amount > denominator) {
      return `${(amount / denominator).toFixed(2)} ${letter}`;
    }
  }
  return Number(amount).toFixed(2);
}
