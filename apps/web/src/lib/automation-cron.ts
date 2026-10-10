import { CronExpressionParser } from "cron-parser";

/** The minute scheduler accepts deterministic five-field cron in UTC. */
export function normalizedAutomationCron(value: string): string | null {
	const expression = value.trim().replace(/\s+/gu, " ");
	if (
		expression.length > 200 ||
		expression.split(" ").length !== 5 ||
		!/^[\dA-Za-z*,/\- ]+$/u.test(expression) ||
		/[A-Za-z]/u.test(
			expression.replace(
				/(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|SUN|MON|TUE|WED|THU|FRI|SAT)/giu,
				"",
			),
		)
	)
		return null;
	try {
		CronExpressionParser.parse(expression, {
			currentDate: new Date("2024-01-01T00:00:00Z"),
			tz: "UTC",
		}).next();
		return expression;
	} catch {
		return null;
	}
}
