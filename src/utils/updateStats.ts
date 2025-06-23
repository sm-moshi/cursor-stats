import * as vscode from "vscode";
import { checkAndNotifySpending, checkAndNotifyUnpaidInvoice, checkAndNotifyUsage } from "../handlers/notifications";
import {
	createMarkdownTooltip,
	createSeparator,
	formatTooltipLine,
	getMaxLineWidth,
	getStatusBarColor,
} from "../handlers/statusBar";
import { getErrorMessage, isApiError, isAuthError } from "../interfaces/errors";
import { checkUsageBasedStatus, fetchCursorStats } from "../services/api";
import { getCursorTokenFromDB } from "../services/database";
import {
	getConsecutiveErrorCount,
	getCooldownStartTime,
	incrementConsecutiveErrorCount,
	resetConsecutiveErrorCount,
	setCooldownStartTime,
	startRefreshInterval,
} from "./cooldown";
import { convertAndFormatCurrency, getCurrentCurrency } from "./currency";
import { t } from "./i18n";
import { log } from "./logger";
import { logStructuredError } from "../interfaces/errors";

// Track unknown models to avoid repeated notifications
let unknownModelNotificationShown = false;
const detectedUnknownModels: Set<string> = new Set();

export async function updateStats(statusBarItem: vscode.StatusBarItem) {
	try {
		log(`[Stats] ${"=".repeat(100)}`);
		log("[Stats] Starting stats update...");
		const token = await getCursorTokenFromDB();

		if (!token) {
			log("[Critical] No valid token found", true);
			statusBarItem.text = `$(alert) ${t("statusBar.noTokenFound")}`;
			statusBarItem.color = new vscode.ThemeColor("statusBarItem.errorBackground");
			const tooltipLines = [t("statusBar.couldNotRetrieveToken")];
			statusBarItem.tooltip = await createMarkdownTooltip(tooltipLines, true);
			log("[Status Bar] Updated status bar with no token message");
			statusBarItem.show();
			log("[Status Bar] Status bar visibility updated after no token");
			return;
		}

		// Check usage-based status first
		const usageStatus = await checkUsageBasedStatus(token);
		log(`[Stats] Usage-based pricing status: ${JSON.stringify(usageStatus)}`);

		// Show status bar early to ensure visibility
		statusBarItem.show();

		const stats = await fetchCursorStats(token).catch(async (error: unknown) => {
			const errorMessage = getErrorMessage(error);

			// Define error handling strategies for cleaner logic
			const errorHandlers = [
				{
					condition: (err: unknown) =>
						isAuthError(err) || (isApiError(err) && (err.response?.status === 401 || err.response?.status === 403)),
					handler: async () => {
						log("[Auth] Token expired or invalid, attempting to refresh...", true);
						const newToken = await getCursorTokenFromDB();
						if (newToken) {
							log("[Auth] Successfully retrieved new token, retrying stats fetch...");
							return await fetchCursorStats(newToken);
						}
						throw error; // If no new token, re-throw original error
					},
				},
			];

			// Try to handle the error with available strategies
			const matchedHandler = errorHandlers.find((handler) => handler.condition(error));
			if (matchedHandler) {
				return await matchedHandler.handler();
			}

			// Default error logging and re-throw
			log(`[Critical] API error: ${errorMessage}`, true);

			// Use structured error detail logging
			const errorDetails = {
				api: isApiError(error)
					? {
							status: error.response?.status,
							statusText: error.response?.statusText,
							isAxiosError: error.isAxiosError,
							hasResponse: !!error.response,
							hasRequest: !!error.request,
						}
					: null,
				generic:
					error instanceof Error
						? {
								name: error.name,
								stack: error.stack,
							}
						: null,
			};

			if (errorDetails.api) {
				log(`[Critical] API error details: ${JSON.stringify(errorDetails.api)}`, true);
			} else if (errorDetails.generic) {
				log(`[Critical] Error details: ${JSON.stringify(errorDetails.generic)}`, true);
			}

			throw error; // Re-throw to be caught by outer catch
		});

		// Reset error count on successful fetch
		if (getConsecutiveErrorCount() > 0 || getCooldownStartTime()) {
			log("[Stats] API connection restored, resetting error state");
			resetConsecutiveErrorCount();
			if (getCooldownStartTime()) {
				setCooldownStartTime(null);
				startRefreshInterval();
			}
		}

		let costText = "";

		// Calculate usage percentages
		const premiumPercent = Math.round((stats.premiumRequests.current / stats.premiumRequests.limit) * 100);
		let usageBasedPercent = 0;
		let totalUsageText = "";
		let totalRequests = stats.premiumRequests.current;

		// Use current month if it has data, otherwise fall back to last month
		const activeMonthData =
			stats.currentMonth.usageBasedPricing.items.length > 0 ? stats.currentMonth : stats.lastMonth;

		log(
			`[Stats] Using ${activeMonthData === stats.currentMonth ? "current" : "last"} month data (${activeMonthData.month}/${activeMonthData.year})`,
		);

		if (activeMonthData.usageBasedPricing.items.length > 0) {
			const items = activeMonthData.usageBasedPricing.items;

			// Calculate actual total cost (sum of positive items only)
			const actualTotalCost = items.reduce((sum, item) => {
				const cost = Number.parseFloat(item.totalDollars.replace("$", ""));
				// Only add positive costs (ignore mid-month payment credits)
				return cost > 0 ? sum + cost : sum;
			}, 0);

			// Calculate total requests from usage-based pricing (needed for status bar text)
			const usageBasedRequests = items.reduce((sum, item) => {
				// Only count requests from positive cost items
				if (Number.parseFloat(item.totalDollars.replace("$", "")) > 0) {
					const match = item.calculation.match(/^\*\*(\d+)\*\*/);
					return sum + (match ? Number.parseInt(match[1]) : 0);
				}
				return sum;
			}, 0);
			totalRequests += usageBasedRequests;

			// Calculate usage percentage based on actual total cost (always in USD)
			if (usageStatus.isEnabled && usageStatus.limit) {
				usageBasedPercent = (actualTotalCost / usageStatus.limit) * 100;
			}

			// Convert actual cost currency for status bar display
			const formattedActualCost = await convertAndFormatCurrency(actualTotalCost);
			costText = ` $(credit-card) ${formattedActualCost}`;

			// Calculate total usage text if enabled
			const config = vscode.workspace.getConfiguration("cursorStats");
			const showTotalRequests = config.get<boolean>("showTotalRequests", false);

			if (showTotalRequests) {
				totalUsageText = ` ${totalRequests}/${stats.premiumRequests.limit}${costText}`;
			} else {
				totalUsageText = ` ${stats.premiumRequests.current}/${stats.premiumRequests.limit}${costText}`;
			}
		} else {
			totalUsageText = ` ${stats.premiumRequests.current}/${stats.premiumRequests.limit}`;
		}

		// Set status bar color based on usage type
		const usagePercent =
			premiumPercent < 100 ? premiumPercent : usageStatus.isEnabled ? usageBasedPercent : premiumPercent;
		statusBarItem.color = getStatusBarColor(usagePercent);

		// Build content first to determine width
		const title = t("statusBar.cursorUsageStats");
		const contentLines = [title, "", t("statusBar.premiumFastRequests")];

		// Format premium requests progress with fixed decimal places
		const premiumPercentFormatted = Math.round(premiumPercent);
		const startDate = new Date(stats.premiumRequests.startOfMonth);
		const endDate = new Date(startDate);
		endDate.setMonth(endDate.getMonth() + 1);

		const formatDateWithMonthName = (date: Date) => {
			const day = date.getDate();
			const monthNames = [
				t("statusBar.months.january"),
				t("statusBar.months.february"),
				t("statusBar.months.march"),
				t("statusBar.months.april"),
				t("statusBar.months.may"),
				t("statusBar.months.june"),
				t("statusBar.months.july"),
				t("statusBar.months.august"),
				t("statusBar.months.september"),
				t("statusBar.months.october"),
				t("statusBar.months.november"),
				t("statusBar.months.december"),
			];
			const monthName = monthNames[date.getMonth()];
			return `${day} ${monthName}`;
		};

		contentLines.push(
			formatTooltipLine(
				`   • ${stats.premiumRequests.current}/${stats.premiumRequests.limit} ${t("statusBar.requestsUsed")}`,
			),
			formatTooltipLine(`   📊 ${premiumPercentFormatted}% ${t("statusBar.utilized")}`),
			formatTooltipLine(
				`   ${t("statusBar.fastRequestsPeriod")}: ${formatDateWithMonthName(startDate)} - ${formatDateWithMonthName(endDate)}`,
			),
			"",
			t("statusBar.usageBasedPricing"),
		);

		if (activeMonthData.usageBasedPricing.items.length > 0) {
			const items = activeMonthData.usageBasedPricing.items;

			// Calculate actual total cost (sum of positive items only)
			const actualTotalCost = items.reduce((sum, item) => {
				const cost = Number.parseFloat(item.totalDollars.replace("$", ""));
				return cost > 0 ? sum + cost : sum;
			}, 0);

			// Calculate usage-based pricing period for the active month
			const billingDay = 3;
			const periodStart = new Date(activeMonthData.year, activeMonthData.month - 1, billingDay);
			const periodEnd = new Date(activeMonthData.year, activeMonthData.month, billingDay - 1);

			// Adjust year if period spans across year boundary
			if (periodEnd < periodStart) {
				periodEnd.setFullYear(periodEnd.getFullYear() + 1);
			}

			contentLines.push(
				formatTooltipLine(
					`   ${t("statusBar.usageBasedPeriod")}: ${formatDateWithMonthName(periodStart)} - ${formatDateWithMonthName(periodEnd)}`,
				),
			);

			// Calculate unpaid amount correctly
			const unpaidAmount = Math.max(0, actualTotalCost - activeMonthData.usageBasedPricing.midMonthPayment);

			// Calculate usage percentage based on actual total cost (always in USD)
			const usagePercentage = usageStatus.limit ? ((actualTotalCost / usageStatus.limit) * 100).toFixed(1) : "0.0";

			// Convert currency for tooltip
			const currencyCode = getCurrentCurrency();
			const formattedActualTotalCost = await convertAndFormatCurrency(actualTotalCost);
			const formattedUnpaidAmount = await convertAndFormatCurrency(unpaidAmount);
			const formattedLimit = await convertAndFormatCurrency(usageStatus.limit ?? 0);

			// Store original values for statusBar.ts to use, using actual total cost
			const originalUsageData = {
				usdTotalCost: actualTotalCost, // Use actual cost here
				usdLimit: usageStatus.limit ?? 0,
				percentage: usagePercentage,
			};

			if (activeMonthData.usageBasedPricing.midMonthPayment > 0) {
				contentLines.push(
					formatTooltipLine(
						`   ${t("statusBar.currentUsage")} (${t("statusBar.total")}: ${formattedActualTotalCost} - ${t("statusBar.unpaid")}: ${formattedUnpaidAmount})`,
					),
					formatTooltipLine(`   __USD_USAGE_DATA__:${JSON.stringify(originalUsageData)}`), // Hidden metadata line
					"",
				);
			} else {
				contentLines.push(
					formatTooltipLine(`   ${t("statusBar.currentUsage")} (${t("statusBar.total")}: ${formattedActualTotalCost})`),
					formatTooltipLine(`   __USD_USAGE_DATA__:${JSON.stringify(originalUsageData)}`), // Hidden metadata line
					"",
				);
			}

			// Determine the maximum length for formatted item costs for padding
			let maxFormattedItemCostLength = 0;
			for (const item of items) {
				if (item.description?.includes("Mid-month usage paid")) {
					continue;
				}
				const itemCost = Number.parseFloat(item.totalDollars.replace("$", ""));
				// We format with 2 decimal places for display
				const tempFormattedCost = itemCost.toFixed(2); // Format to string with 2 decimals
				if (tempFormattedCost.length > maxFormattedItemCostLength) {
					maxFormattedItemCostLength = tempFormattedCost.length;
				}
			}

			for (const item of items) {
				// Skip mid-month payment line item from the detailed list
				if (item.description?.includes("Mid-month usage paid")) {
					continue;
				}

				// If the item has a description, use it to provide better context
				if (item.description) {
					// Logic for populating detectedUnknownModels for the notification
					// This now uses modelNameForTooltip as a primary signal from api.ts
					if (item.modelNameForTooltip === "unknown-model" && item.description) {
						// api.ts couldn't determine a specific model.
						// Let's inspect the raw description for a hint for the notification.
						let extractedTermForNotification = "";

						// Try to extract model name from specific patterns first
						const tokenBasedDescMatch = item.description.match(/^(\d+) token-based usage calls to ([\w.-]+),/i);
						if (tokenBasedDescMatch?.[2]) {
							extractedTermForNotification = tokenBasedDescMatch[2].trim();
						} else {
							const extraFastMatch = item.description.match(/extra fast premium requests? \(([^)]+)\)/i);
							if (extraFastMatch?.[1]) {
								extractedTermForNotification = extraFastMatch[1].trim();
							} else {
								// General case: "N ACTUAL_MODEL_NAME_OR_PHRASE requests/calls"
								const fullDescMatch = item.description.match(
									/^(\d+)\s+(.+?)(?: request| calls)?(?: beyond|\*| per|$)/i,
								);
								if (fullDescMatch?.[2]) {
									extractedTermForNotification = fullDescMatch[2].trim();
									// If it's discounted and starts with "discounted ", remove prefix
									if (item.isDiscounted && extractedTermForNotification.toLowerCase().startsWith("discounted ")) {
										extractedTermForNotification = extractedTermForNotification.substring(11).trim();
									}
								} else {
									// Fallback: first word after number if other patterns fail (less likely to be useful)
									const simpleDescMatch = item.description.match(/^(\d+)\s+([\w.-]+)/i); // Changed to [\w.-]+
									if (simpleDescMatch?.[2]) {
										extractedTermForNotification = simpleDescMatch[2].trim();
									}
								}
							}
						}

						// General cleanup of suffixes
						extractedTermForNotification = extractedTermForNotification
							.replace(/requests?|calls?|beyond|\*|per|,$/gi, "")
							.trim();
						if (extractedTermForNotification.toLowerCase().endsWith(" usage")) {
							extractedTermForNotification = extractedTermForNotification
								.substring(0, extractedTermForNotification.length - 6)
								.trim();
						}
						// Ensure it's not an empty string after cleanup
						if (
							extractedTermForNotification &&
							extractedTermForNotification.length > 1 && // Meaningful length
							extractedTermForNotification.toLowerCase() !== "token-based" &&
							extractedTermForNotification.toLowerCase() !== "discounted"
						) {
							const veryGenericKeywords = [
								"usage",
								"calls",
								"request",
								"requests",
								"cents",
								"beyond",
								"month",
								"day",
								"january",
								"february",
								"march",
								"april",
								"may",
								"june",
								"july",
								"august",
								"september",
								"october",
								"november",
								"december",
								"premium",
								"extra",
								"tool",
								"fast",
								"thinking",
								// Model families like 'claude', 'gpt', 'gemini', 'o1' etc. are NOT here,
								// as "claude-x" should be flagged if "claude-x" is new.
							];

							const isVeryGeneric = veryGenericKeywords.includes(extractedTermForNotification.toLowerCase());

							if (!isVeryGeneric) {
								const alreadyPresent = Array.from(detectedUnknownModels).some(
									(d) =>
										d.toLowerCase().includes(extractedTermForNotification.toLowerCase()) ||
										extractedTermForNotification.toLowerCase().includes(d.toLowerCase()),
								);
								if (!alreadyPresent) {
									detectedUnknownModels.add(extractedTermForNotification);
									log(
										`[Stats] Adding to detectedUnknownModels (api.ts flagged as unknown-model, extracted term): '${extractedTermForNotification}' from "${item.description}"`,
									);
								}
							}
						}
					}

					// Convert item cost for display
					const itemCost = Number.parseFloat(item.totalDollars.replace("$", ""));
					let formattedItemCost = await convertAndFormatCurrency(itemCost);

					// Pad the numerical part of the formattedItemCost
					const currencySymbol = formattedItemCost.match(/^[^0-9-.\\,]*/)?.[0] ?? "";
					const numericalPart = formattedItemCost.substring(currencySymbol.length);
					const paddedNumericalPart = numericalPart.padStart(maxFormattedItemCostLength, "0");
					formattedItemCost = currencySymbol + paddedNumericalPart;

					let line = `   • ${item.calculation} ➜ &nbsp;&nbsp;**${formattedItemCost}**`;
					const modelName = item.modelNameForTooltip;
					let modelNameDisplay = ""; // Initialize for the model name part of the string

					if (modelName) {
						// Make sure modelName is there
						const isDiscounted = item.description?.toLowerCase().includes("discounted");
						const isUnknown = modelName === "unknown-model";

						if (isDiscounted) {
							modelNameDisplay = `(${t("statusBar.discounted")} | ${isUnknown ? t("statusBar.unknownModel") : modelName})`;
						} else if (isUnknown) {
							modelNameDisplay = `(${t("statusBar.unknownModel")})`;
						} else {
							modelNameDisplay = `(${modelName})`;
						}
					}
					// If modelName was undefined or null, modelNameDisplay remains empty.

					if (modelNameDisplay) {
						// Only add spacing and display string if it's not empty
						const desiredTotalWidth = 70; // Adjust as needed for good visual alignment
						const currentLineWidth = line.replace(/\*\*/g, "").replace(/&nbsp;/g, " ").length; // Approx length without markdown & html spaces
						const modelNameDisplayLength = modelNameDisplay.replace(/&nbsp;/g, " ").length;
						const spacesNeeded = Math.max(1, desiredTotalWidth - currentLineWidth - modelNameDisplayLength);
						line += `${" ".repeat(spacesNeeded)}&nbsp;&nbsp;&nbsp;&nbsp;${modelNameDisplay}`;
					}
					contentLines.push(formatTooltipLine(line));
				} else {
					// Fallback for items without a description (should be rare but handle it)
					const itemCost = Number.parseFloat(item.totalDollars.replace("$", ""));
					let formattedItemCost = await convertAndFormatCurrency(itemCost);

					// Pad the numerical part of the formattedItemCost
					const currencySymbol = formattedItemCost.match(/^[^0-9-.\\,]*/)?.[0] ?? "";
					const numericalPart = formattedItemCost.substring(currencySymbol.length);
					const paddedNumericalPart = numericalPart.padStart(maxFormattedItemCostLength, "0");
					formattedItemCost = currencySymbol + paddedNumericalPart;

					// Use a generic calculation string if item.calculation is also missing, or the original if available
					const calculationString = item.calculation || t("statusBar.unknownItem");
					contentLines.push(formatTooltipLine(`   • ${calculationString} ➜ &nbsp;&nbsp;**${formattedItemCost}**`));
				}
			}

			if (activeMonthData.usageBasedPricing.midMonthPayment > 0) {
				const formattedMidMonthPayment = await convertAndFormatCurrency(
					activeMonthData.usageBasedPricing.midMonthPayment,
				);
				contentLines.push("", formatTooltipLine(t("statusBar.youHavePaid", { amount: formattedMidMonthPayment })));
			}

			const formattedFinalCost = await convertAndFormatCurrency(actualTotalCost);
			contentLines.push("", formatTooltipLine(`💳 ${t("statusBar.totalCost")}: ${formattedFinalCost}`));

			// Update costText for status bar here, using actual total cost
			costText = ` $(credit-card) ${formattedFinalCost}`;

			// Add spending notification check
			if (usageStatus.isEnabled) {
				setTimeout(() => {
					checkAndNotifySpending(actualTotalCost); // Check spending based on actual total cost
				}, 1000);
			}
		} else {
			contentLines.push(`   ℹ️ ${t("statusBar.noUsageDataAvailable")}`);
		}

		// Calculate separator width based on content
		const maxWidth = getMaxLineWidth(contentLines);
		const separator = createSeparator(maxWidth);

		// Create final tooltip content with Last Updated at the bottom
		// Filter out the metadata line before creating the final tooltip
		const visibleContentLines = contentLines.filter((line) => !line.includes("__USD_USAGE_DATA__"));

		const tooltipLines = [
			title,
			separator,
			...visibleContentLines.slice(1),
			"",
			formatTooltipLine(`🕒 ${t("time.lastUpdated")}: ${new Date().toLocaleString()}`),
		];

		// Update usage based percent for notifications
		usageBasedPercent = usageStatus.isEnabled ? usageBasedPercent : 0;

		log("[Status Bar] Updating status bar with new stats...");
		statusBarItem.text = `$(graph)${totalUsageText}`;
		statusBarItem.tooltip = await createMarkdownTooltip(tooltipLines, false, contentLines);
		statusBarItem.show();
		log("[Stats] Stats update completed successfully");

		// Show notifications after ensuring status bar is visible
		if (usageStatus.isEnabled) {
			setTimeout(() => {
				// First check premium usage
				const premiumPercent = Math.round((stats.premiumRequests.current / stats.premiumRequests.limit) * 100);
				checkAndNotifyUsage({
					percentage: premiumPercent,
					type: "premium",
				});

				// Only check usage-based if premium is over limit
				if (premiumPercent >= 100) {
					checkAndNotifyUsage({
						percentage: usageBasedPercent,
						type: "usage-based",
						limit: usageStatus.limit,
						premiumPercentage: premiumPercent,
					});
				}

				if (activeMonthData.usageBasedPricing.hasUnpaidMidMonthInvoice) {
					checkAndNotifyUnpaidInvoice(token);
				}
			}, 1000);
		} else {
			setTimeout(() => {
				checkAndNotifyUsage({
					percentage: premiumPercent,
					type: "premium",
				});
			}, 1000);
		}

		// The main notification for unknown models is now based on the populated detectedUnknownModels set
		if (!unknownModelNotificationShown && detectedUnknownModels.size > 0) {
			unknownModelNotificationShown = true; // Show once per session globally
			const unknownModelsString = Array.from(detectedUnknownModels).join(", ");
			log(`[Stats] Showing notification for aggregated unknown models: ${unknownModelsString}`);

			vscode.window
				.showInformationMessage(
					t("notifications.unknownModelsDetected", { models: unknownModelsString }),
					t("commands.createReport"),
					t("commands.openGitHubIssues"),
				)
				.then((selection) => {
					if (selection === t("commands.createReport")) {
						vscode.commands.executeCommand("cursor-stats.createReport");
					} else if (selection === t("commands.openGitHubIssues")) {
						vscode.env.openExternal(vscode.Uri.parse("https://github.com/Dwtexe/cursor-stats/issues/new"));
					}
				});
		}
	} catch (error: unknown) {
		const errorCount = incrementConsecutiveErrorCount();

		// Use structured error logging utility
		logStructuredError(error, "[Critical]", "API error");

		log(`[Status Bar] Status bar visibility updated after error - Error count: ${errorCount}`);
	}
}
