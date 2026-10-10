import * as z from "zod";

export const automationDateSchema = z
  .string()
  .refine((value) => {
    if (!/^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/u.test(value)) return false;
    const date = value.slice(0, 10);
    const [year, month, day] = date.split("-").map(Number);
    const parsed = new Date(Date.UTC(year as number, (month as number) - 1, day));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === (month as number) - 1 &&
      parsed.getUTCDate() === day
    );
  })
  .transform((value) => value.slice(0, 10));
