import * as fs from "node:fs";
import axios from "axios";
import { getExtensionContext } from "../extension";
import { getErrorMessage, isApiError, logStructuredError } from "../interfaces/errors";
import type {
	CursorStats,
	CursorUsageResponse,
	MonthlyInvoiceApiResponse,
	UsageItem,
	UsageLimitResponse,
} from "../interfaces/types";
import { t } from "../utils/i18n";
import { log } from "../utils/logger";
import { checkTeamMembership, extractUserUsage, getTeamUsage } from "./team";

export async function getCurrentUsageLimit(token: string): Promise<UsageLimitResponse> {
	try {
		const response = await axios.post(
			"https://www.cursor.com/api/dashboard/get-hard-limit",
			{}, // empty JSON body
			{
				headers: {
					Cookie: `WorkosCursorSessionToken=${token}`,
				},
			},
		);
		return response.data;
	} catch (error: unknown) {
		const errorMessage = getErrorMessage(error);
		log(`[API] Error fetching usage limit: ${errorMessage}`, true);

		if (isApiError(error)) {
			log(
				`[API] API error details: ${JSON.stringify({ status: error.response?.status, data: error.response?.data })}`,
				true,
			);
		}
		throw error;
	}
}

export async function setUsageLimit(token: string, hardLimit: number, noUsageBasedAllowed: boolean): Promise<void> {
	try {
		await axios.post(
			"https://www.cursor.com/api/dashboard/set-hard-limit",
			{
				hardLimit,
				noUsageBasedAllowed,
			},
			{
				headers: {
					Cookie: `WorkosCursorSessionToken=${token}`,
				},
			},
		);
		log(
			`[API] Successfully ${noUsageBasedAllowed ? "disabled" : "enabled"} usage-based pricing with limit: $${hardLimit}`,
		);
	} catch (error: unknown) {
		const errorMessage = getErrorMessage(error);
		log(`[API] Error setting usage limit: ${errorMessage}`, true);

		if (isApiError(error)) {
			log(
				`[API] API error details: ${JSON.stringify({ status: error.response?.status, data: error.response?.data })}`,
				true,
			);
		}
		throw error;
	}
}

export async function checkUsageBasedStatus(token: string): Promise<{ isEnabled: boolean; limit?: number }> {
	try {
		const response = await getCurrentUsageLimit(token);
		return {
			isEnabled: !response.noUsageBasedAllowed,
			limit: response.hardLimit,
		};
	} catch (error: unknown) {
		const errorMessage = getErrorMessage(error);
		log(`[API] Error checking usage-based status: ${errorMessage}`, true);
		return {
			isEnabled: false,
		};
	}
}

/**
 * Processes mid-month payment items and updates the running total
 * @param item Invoice item to process
 * @param currentMidMonthTotal Current running total of mid-month payments
 * @returns Object containing updated total and usage item, or null if not a mid-month payment
 */
function processMidMonthPayment(
	item: { description: string; cents?: number },
	currentMidMonthTotal: number,
): { updatedTotal: number; usageItem: UsageItem } | null {
	// Check if this is a mid-month payment
	if (!item.description.includes("Mid-month usage paid")) {
		return null;
	}

	// Skip if cents is undefined
	if (typeof item.cents === "undefined") {
		return null;
	}

	// Calculate the payment amount (convert from cents to dollars)
	const paymentAmount = Math.abs(item.cents) / 100;
	const updatedTotal = currentMidMonthTotal + paymentAmount;

	log(`[API] Added mid-month payment of $${paymentAmount.toFixed(2)}, total now: $${updatedTotal.toFixed(2)}`);

	// Create a special usage item for mid-month payment that statusBar.ts can parse
	const usageItem: UsageItem = {
		calculation: `${t("api.midMonthPayment")}: $${updatedTotal.toFixed(2)}`,
		totalDollars: `-$${updatedTotal.toFixed(2)}`,
		description: item.description,
	};

	return { updatedTotal, usageItem };
}

/**
 * Fetches raw monthly invoice data from the API or dev file
 * @param token Authentication token
 * @param month Month to fetch (1-12)
 * @param year Year to fetch
 * @returns Raw monthly invoice response data
 */
async function fetchMonthlyInvoiceData(token: string, month: number, year: number): Promise<MonthlyInvoiceApiResponse> {
	log(`[API] Fetching raw invoice data for ${month}/${year}`);

	// Path to local dev data file, leave empty for production
	const devDataPath: string = "";

	if (devDataPath) {
		try {
			log(`[API] Dev mode enabled, reading from: ${devDataPath}`);
			const rawData = fs.readFileSync(devDataPath, "utf8");
			const parsedData = JSON.parse(rawData);
			log("[API] Successfully loaded dev data");
			return parsedData;
		} catch (devError: unknown) {
			logStructuredError(devError, "[API]", "Error reading dev data");
			throw devError;
		}
	}

	// Production API call
	const response = await axios.post<MonthlyInvoiceApiResponse>(
		"https://www.cursor.com/api/dashboard/get-monthly-invoice",
		{
			month,
			year,
			includeUsageEvents: false,
		},
		{
			headers: {
				Cookie: `WorkosCursorSessionToken=${token}`,
			},
		},
	);

	return response.data;
}

/**
 * Calculates padding widths for formatting usage items consistently
 * @param items Array of invoice items to analyze
 * @returns Object containing padding widths for request counts and costs
 */
function calculatePaddingWidths(items: { description: string; cents?: number }[]): {
	paddingWidth: number;
	costPaddingWidth: number;
} {
	let maxRequestCount = 0;
	let maxCostCentsForPadding = 0;

	// First pass: find the maximum request count and cost per request among valid items
	for (const item of items) {
		// Skip items without cents value or mid-month payments
		if (
			!Object.hasOwn(item, "cents") ||
			typeof item.cents === "undefined" ||
			item.description.includes("Mid-month usage paid")
		) {
			continue;
		}

		let currentItemRequestCount = 0;
		const tokenBasedMatch = item.description.match(/^(\d+) token-based usage calls to/);
		if (tokenBasedMatch?.[1]) {
			currentItemRequestCount = Number.parseInt(tokenBasedMatch[1]);
		} else {
			const originalMatch = item.description.match(/^(\d+)/); // Match digits at the beginning
			if (originalMatch?.[1]) {
				currentItemRequestCount = Number.parseInt(originalMatch[1]);
			}
		}

		if (currentItemRequestCount > 0) {
			maxRequestCount = Math.max(maxRequestCount, currentItemRequestCount);

			// Calculate cost per request for this item to find maximum
			const costPerRequestCents = item.cents / currentItemRequestCount;
			maxCostCentsForPadding = Math.max(maxCostCentsForPadding, costPerRequestCents);
		}
	}

	// Calculate the padding width based on the maximum request count
	const paddingWidth = maxRequestCount > 0 ? maxRequestCount.toString().length : 1; // Ensure paddingWidth is at least 1

	// Calculate the padding width for cost per request (format to 3 decimal places and find max width)
	const maxCostPerRequestForPaddingFormatted = (maxCostCentsForPadding / 100).toFixed(3);
	const costPaddingWidth = maxCostPerRequestForPaddingFormatted.length;

	return { paddingWidth, costPaddingWidth };
}

async function fetchMonthData(
	token: string,
	month: number,
	year: number,
): Promise<{ items: UsageItem[]; hasUnpaidMidMonthInvoice: boolean; midMonthPayment: number }> {
	log(`[API] Processing monthly data for ${month}/${year}`);
	try {
		// Fetch raw data using dedicated function
		const invoiceData = await fetchMonthlyInvoiceData(token, month, year);

		const usageItems: UsageItem[] = [];
		let midMonthPayment = 0;
		const items = invoiceData.items ?? [];

		if (items.length > 0) {
			// Calculate padding widths for consistent formatting
			const { paddingWidth, costPaddingWidth } = calculatePaddingWidths(items);

			for (const item of items) {
				// Skip items without cents value
				if (!Object.hasOwn(item, "cents")) {
					log(`[API] Skipping item without cents value: ${item.description}`);
					continue;
				}

				// Check and process mid-month payments using dedicated function
				const midMonthResult = processMidMonthPayment(item, midMonthPayment);
				if (midMonthResult) {
					midMonthPayment = midMonthResult.updatedTotal;
					usageItems.push(midMonthResult.usageItem);
					continue; // Skip adding this to regular usage items
				}

				// Logic to parse different item description formats
				const cents = item.cents;

				if (typeof cents === "undefined") {
					log(`[API] Skipping item with undefined cents value: ${item.description}`);
					continue;
				}

				let requestCount: number;
				let parsedModelName: string; // Renamed from modelInfo for clarity
				let isToolCall = false;

				const tokenBasedMatch = item.description.match(
					/^(\d+) token-based usage calls to ([\w.-]+), totalling: \$(?:[\d.]+)/,
				);
				if (tokenBasedMatch) {
					requestCount = Number.parseInt(tokenBasedMatch[1]);
					parsedModelName = tokenBasedMatch[2];
				} else {
					const originalMatch = item.description.match(/^(\d+)\s+(.+?)(?: request| calls)?(?: beyond|\*| per|$)/i);
					if (originalMatch) {
						requestCount = Number.parseInt(originalMatch[1]);
						const extractedDescription = originalMatch[2].trim();

						// Updated pattern to handle "discounted" prefix and include claude-4-sonnet
						const genericModelPattern =
							/\b(?:discounted\s+)?(claude-(?:3-(?:opus|sonnet|haiku)|3\.[57]-sonnet(?:-[\w-]+)?(?:-max)?|4-sonnet(?:-thinking)?)|gpt-(?:4(?:\.\d+|o-128k|-preview)?|3\.5-turbo)|gemini-(?:1\.5-flash-500k|2[.-]5-pro-(?:exp-\d{2}-\d{2}|preview-\d{2}-\d{2}|exp-max))|o[134](?:-mini)?)\b/i;
						const specificModelMatch = item.description.match(genericModelPattern);

						// Model parsing strategy - use lookup table approach for cleaner logic
						const modelParsingStrategies = [
							{
								condition: () => item.description.includes("tool calls"),
								parser: () => ({ modelName: t("api.toolCalls"), isToolCall: true }),
							},
							{
								condition: () => !!specificModelMatch,
								parser: () => ({
									modelName: specificModelMatch ? specificModelMatch[1] : t("statusBar.unknownModel"),
									isToolCall: false,
								}),
							},
							{
								condition: () => item.description.includes("extra fast premium request"),
								parser: () => {
									const extraFastModelMatch = item.description.match(/extra fast premium requests? \(([^)]+)\)/i);
									return {
										modelName: extraFastModelMatch?.[1] || t("api.fastPremium"),
										isToolCall: false,
									};
								},
							},
						];

						// Find the first matching strategy and apply it
						const matchedStrategy = modelParsingStrategies.find((strategy) => strategy.condition());
						if (matchedStrategy) {
							const parseResult = matchedStrategy.parser();
							parsedModelName = parseResult.modelName;
							isToolCall = parseResult.isToolCall;
						} else {
							// Fallback for unknown model structure
							parsedModelName = t("statusBar.unknownModel");
							log(
								`[API] Could not determine specific model for (original format): "${item.description}". Using "${parsedModelName}".`,
							);
						}
					} else {
						log(`[API] Could not extract request count or model info from: ${item.description}`);
						parsedModelName = t("statusBar.unknownModel"); // Ensure it's set for items we can't parse fully
						// Try to get at least a request count if possible, even if model is unknown
						const fallbackCountMatch = item.description.match(/^(\d+)/);
						if (fallbackCountMatch) {
							requestCount = Number.parseInt(fallbackCountMatch[1]);
						} else {
							continue; // Truly unparsable
						}
					}
				}

				// Skip items with 0 requests to avoid division by zero
				if (requestCount === 0) {
					log(`[API] Skipping item with 0 requests: ${item.description}`);
					continue;
				}

				const costPerRequestCents = cents / requestCount;
				const totalDollars = cents / 100;

				const paddedRequestCount = requestCount.toString().padStart(paddingWidth, "0");
				const costPerRequestDollarsFormatted = (costPerRequestCents / 100).toFixed(3).padStart(costPaddingWidth, "0");

				const isTotallingItem = !!tokenBasedMatch;
				const tilde = isTotallingItem ? "~" : "&nbsp;&nbsp;";
				const itemUnit = t("api.requestUnit"); // Always use "req" as the unit

				// Simplified calculation string, model name is now separate
				const calculationString = `**${paddedRequestCount}** ${itemUnit} @ **$${costPerRequestDollarsFormatted}${tilde}**`;

				usageItems.push({
					calculation: calculationString,
					totalDollars: `$${totalDollars.toFixed(2)}`,
					description: item.description,
					modelNameForTooltip: parsedModelName, // Store the determined model name here
					isDiscounted: item.description.toLowerCase().includes("discounted"), // Add a flag for discounted items
				});
			}
		}

		return {
			items: usageItems,
			hasUnpaidMidMonthInvoice: invoiceData.hasUnpaidMidMonthInvoice ?? false,
			midMonthPayment,
		};
	} catch (error: unknown) {
		const errorMessage = getErrorMessage(error);
		log(`[API] Error fetching monthly data for ${month}/${year}: ${errorMessage}`, true);

		if (isApiError(error)) {
			log(
				"[API] API error details: " +
					JSON.stringify({
						status: error.response?.status,
						data: error.response?.data,
						message: errorMessage,
					}),
				true,
			);
		}
		throw error;
	}
}

export async function fetchCursorStats(token: string): Promise<CursorStats> {
	// Extract user ID from token
	const userId = token.split("%3A%3A")[0];

	try {
		// Check if user is a team member
		const context = getExtensionContext();
		const teamInfo = await checkTeamMembership(token, context);

		let premiumRequests: {
			current: number;
			limit: number;
			startOfMonth: string;
		};
		if (teamInfo.isTeamMember && teamInfo.teamId && teamInfo.userId) {
			// Fetch team usage for team members
			log("[API] Fetching team usage data...");
			const teamUsage = await getTeamUsage(token, teamInfo.teamId);
			const userUsage = extractUserUsage(teamUsage, teamInfo.userId);

			premiumRequests = {
				current: userUsage.numRequests,
				limit: userUsage.maxRequestUsage,
				startOfMonth: teamInfo.startOfMonth,
			};
			log("[API] Successfully extracted team member usage data");
		} else {
			const premiumResponse = await axios.get<CursorUsageResponse>("https://www.cursor.com/api/usage", {
				params: { user: userId },
				headers: {
					Cookie: `WorkosCursorSessionToken=${token}`,
				},
			});

			premiumRequests = {
				current: premiumResponse.data["gpt-4"].numRequests,
				limit: premiumResponse.data["gpt-4"].maxRequestUsage,
				startOfMonth: premiumResponse.data.startOfMonth,
			};
		}

		// Get current date for usage-based pricing (which renews on 2nd/3rd of each month)
		const currentDate = new Date();
		const usageBasedBillingDay = 3; // Assuming it's the 3rd day of the month
		let usageBasedCurrentMonth = currentDate.getMonth() + 1;
		let usageBasedCurrentYear = currentDate.getFullYear();

		// If we're in the first few days of the month (before billing date),
		// consider the previous month as the current billing period
		if (currentDate.getDate() < usageBasedBillingDay) {
			usageBasedCurrentMonth = usageBasedCurrentMonth === 1 ? 12 : usageBasedCurrentMonth - 1;
			if (usageBasedCurrentMonth === 12) {
				usageBasedCurrentYear--;
			}
		}

		// Calculate previous month for usage-based pricing
		const usageBasedLastMonth = usageBasedCurrentMonth === 1 ? 12 : usageBasedCurrentMonth - 1;
		const usageBasedLastYear = usageBasedCurrentMonth === 1 ? usageBasedCurrentYear - 1 : usageBasedCurrentYear;

		const currentMonthData = await fetchMonthData(token, usageBasedCurrentMonth, usageBasedCurrentYear);
		const lastMonthData = await fetchMonthData(token, usageBasedLastMonth, usageBasedLastYear);

		return {
			currentMonth: {
				month: usageBasedCurrentMonth,
				year: usageBasedCurrentYear,
				usageBasedPricing: currentMonthData,
			},
			lastMonth: {
				month: usageBasedLastMonth,
				year: usageBasedLastYear,
				usageBasedPricing: lastMonthData,
			},
			premiumRequests,
		};
	} catch (error: unknown) {
		const errorMessage = getErrorMessage(error);
		log(`[API] Error fetching premium requests: ${errorMessage}`, true);

		if (isApiError(error)) {
			log(
				"[API] API error details: " +
					JSON.stringify({
						status: error.response?.status,
						data: error.response?.data,
						message: errorMessage,
					}),
				true,
			);
		}
		throw error;
	}
}

export async function getStripeSessionUrl(token: string): Promise<string> {
	try {
		const response = await axios.get("https://www.cursor.com/api/stripeSession", {
			headers: {
				Cookie: `WorkosCursorSessionToken=${token}`,
			},
		});
		// Remove quotes from the response string
		return response.data.replace(/"/g, "");
	} catch (error: unknown) {
		const errorMessage = getErrorMessage(error);
		log(`[API] Error getting Stripe session URL: ${errorMessage}`, true);

		if (isApiError(error)) {
			log(
				`[API] Stripe API error: ${JSON.stringify({ status: error.response?.status, data: error.response?.data })}`,
				true,
			);
		}
		throw error;
	}
}
