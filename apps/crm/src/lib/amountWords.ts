/**
 * Money written out in words, for confirmations.
 *
 * A cheque is written twice — figures and words — because the two fail
 * differently. `$14,900.00` and `$149.00` look alike at a glance on a phone at
 * a front desk; "fourteen thousand nine hundred dollars" and "one hundred and
 * forty-nine dollars" do not. This is the control that catches the decimal slip
 * the ceiling cannot: the ceiling only knows an amount is implausible, the
 * words tell a human it is wrong.
 */

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

function underThousand(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)];
    const r = n % 10;
    return r ? `${t}-${ONES[r]}` : t;
  }
  const h = `${ONES[Math.floor(n / 100)]} hundred`;
  const r = n % 100;
  return r ? `${h} and ${underThousand(r)}` : h;
}

/** 0 – 999,999 in words. Above that, callers should not be charging a card. */
export function numberToWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  const whole = Math.floor(n);
  if (whole === 0) return "zero";
  if (whole >= 1_000_000) return "";
  const thousands = Math.floor(whole / 1000);
  const rest = whole % 1000;
  if (!thousands) return underThousand(rest);
  const head = `${underThousand(thousands)} thousand`;
  if (!rest) return head;
  // "four thousand and ninety" reads right; "four thousand, one hundred" needs
  // the comma rather than the and.
  return rest < 100 ? `${head} and ${underThousand(rest)}` : `${head} ${underThousand(rest)}`;
}

/**
 * "one hundred and forty-nine dollars and 50 cents" — the phrase a person reads
 * back before money moves. Cents stay as digits: nobody misreads "50 cents",
 * and spelling them out makes the sentence harder to scan, not easier.
 */
export function amountInWords(cents: number): string {
  if (!Number.isFinite(cents) || cents < 0) return "";
  const rounded = Math.round(cents);
  const dollars = Math.floor(rounded / 100);
  const remainder = rounded % 100;
  const words = numberToWords(dollars);
  if (!words) return "";
  const dollarPart = `${words} dollar${dollars === 1 ? "" : "s"}`;
  if (!remainder) return dollarPart;
  return `${dollarPart} and ${remainder} cent${remainder === 1 ? "" : "s"}`;
}
