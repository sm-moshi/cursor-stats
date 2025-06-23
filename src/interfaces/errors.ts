/**
 * Comprehensive error type definitions for Cursor Stats extension
 * This file centralizes all error types to replace 'any' usage in catch blocks
 */

/**
 * Base error interface that extends the standard Error
 */
export interface BaseAppError extends Error {
	code?: string;
	context?: string;
	timestamp?: Date;
}

/**
 * HTTP/API related errors (Axios, fetch, etc.)
 */
export interface ApiError extends BaseAppError {
	response?: {
		status?: number;
		statusText?: string;
		data?: unknown;
		headers?: Record<string, string>;
	};
	request?: unknown;
	config?: unknown;
	isAxiosError?: boolean;
}

/**
 * Database related errors (SQLite, file system, etc.)
 */
export interface DatabaseError extends BaseAppError {
	errno?: number;
	sqlState?: string;
	query?: string;
	parameters?: unknown[];
}

/**
 * VS Code API related errors
 */
export interface VSCodeError extends BaseAppError {
	command?: string;
	uri?: string;
	workspaceFolder?: string;
}

/**
 * Node.js system errors (file system, network, etc.)
 */
export interface NodeError extends BaseAppError {
	errno?: number;
	syscall?: string;
	path?: string;
	address?: string;
	port?: number;
}

/**
 * JSON parsing and serialization errors
 */
export interface ParseError extends BaseAppError {
	input?: string;
	position?: number;
	expectedType?: string;
}

/**
 * Network and connectivity errors
 */
export interface NetworkError extends BaseAppError {
	host?: string;
	port?: number;
	timeout?: number;
	retryCount?: number;
}

/**
 * Authentication and authorization errors
 */
export interface AuthError extends BaseAppError {
	tokenExpired?: boolean;
	statusCode?: number;
	authMethod?: string;
}

/**
 * Configuration and settings errors
 */
export interface ConfigError extends BaseAppError {
	setting?: string;
	expectedValue?: unknown;
	actualValue?: unknown;
}

/**
 * Union type of all possible error types in the application
 */
export type AppError =
	| BaseAppError
	| ApiError
	| DatabaseError
	| VSCodeError
	| NodeError
	| ParseError
	| NetworkError
	| AuthError
	| ConfigError
	| Error; // Include standard Error as fallback

/**
 * Type guard to check if an error is an API error
 */
export function isApiError(error: unknown): error is ApiError {
	return (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		("response" in error || "isAxiosError" in error)
	);
}

/**
 * Type guard to check if an error is a Database error
 */
export function isDatabaseError(error: unknown): error is DatabaseError {
	return typeof error === "object" && error !== null && "message" in error && ("errno" in error || "sqlState" in error);
}

/**
 * Type guard to check if an error is a VS Code error
 */
export function isVSCodeError(error: unknown): error is VSCodeError {
	return typeof error === "object" && error !== null && "message" in error && ("command" in error || "uri" in error);
}

/**
 * Type guard to check if an error is a Node.js system error
 */
export function isNodeError(error: unknown): error is NodeError {
	return typeof error === "object" && error !== null && "message" in error && ("errno" in error || "syscall" in error);
}

/**
 * Type guard to check if an error is a Parse error
 */
export function isParseError(error: unknown): error is ParseError {
	return typeof error === "object" && error !== null && "message" in error && ("input" in error || "position" in error);
}

/**
 * Type guard to check if an error is a Network error
 */
export function isNetworkError(error: unknown): error is NetworkError {
	return typeof error === "object" && error !== null && "message" in error && ("host" in error || "timeout" in error);
}

/**
 * Type guard to check if an error is an Auth error
 */
export function isAuthError(error: unknown): error is AuthError {
	return (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		("tokenExpired" in error || "authMethod" in error)
	);
}

/**
 * Type guard to check if an error is a Config error
 */
export function isConfigError(error: unknown): error is ConfigError {
	return typeof error === "object" && error !== null && "message" in error && "setting" in error;
}

/**
 * Utility function to safely extract error message from unknown error
 */
export function getErrorMessage(error: unknown): string {
	// Use early returns instead of nested if/else for cleaner logic
	if (error instanceof Error) {
		return error.message;
	}

	if (typeof error === "string") {
		return error;
	}

	if (typeof error === "object" && error !== null && "message" in error) {
		return String(error.message);
	}

	return "Unknown error occurred";
}

/**
 * Utility function to safely extract error code from unknown error
 */
export function getErrorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) {
		return String(error.code);
	}
	return undefined;
}

/**
 * Structured error logging utility to eliminate repetitive error handling patterns
 * @param error The error to log
 * @param context Context string for the log message (e.g., "[Database]", "[API]")
 * @param operation Operation that was being performed when error occurred
 * @param logError Whether to treat this as an error log (default: true)
 */
export function logStructuredError(error: unknown, context: string, operation: string, logError = true): void {
	const errorMessage = getErrorMessage(error);
	const { log } = require("../utils/logger");

	log(`${context} ${operation}: ${errorMessage}`, undefined, logError);

	// Use structured error detail logging based on error type
	const errorDetailsHandlers = [
		{
			condition: (err: unknown) => isApiError(err),
			handler: (err: ApiError) => {
				log(
					`${context} API error details`,
					{
						status: err.response?.status,
						data: err.response?.data,
						statusText: err.response?.statusText,
						isAxiosError: err.isAxiosError,
					},
					logError,
				);
			},
		},
		{
			condition: (err: unknown) => isNodeError(err),
			handler: (err: NodeError) => {
				log(
					`${context} File system error details`,
					{
						errno: err.errno,
						path: err.path,
						syscall: err.syscall,
					},
					logError,
				);
			},
		},
		{
			condition: (err: unknown) => isParseError(err),
			handler: (err: ParseError) => {
				log(
					`${context} Parse error details`,
					{
						position: err.position,
						input: err.input?.substring(0, 100),
					},
					logError,
				);
			},
		},
		{
			condition: (err: unknown) => isVSCodeError(err),
			handler: (err: VSCodeError) => {
				log(
					`${context} VS Code error details`,
					{
						command: err.command,
						code: err.code,
						uri: err.uri,
					},
					logError,
				);
			},
		},
		{
			condition: (err: unknown) => err instanceof Error,
			handler: (err: Error) => {
				log(
					`${context} Error details`,
					{
						name: err.name,
						stack: err.stack,
					},
					logError,
				);
			},
		},
	];

	// Find and execute the appropriate error handler
	const matchedHandler = errorDetailsHandlers.find((handler) => handler.condition(error));
	if (matchedHandler) {
		// Type assertion is safe here because we've already checked the condition
		matchedHandler.handler(error as ApiError | NodeError | ParseError | VSCodeError | Error);
	}
}

/**
 * Utility function to create a standardized error object
 */
export function createAppError(
	message: string,
	code?: string,
	context?: string,
	originalError?: unknown,
): BaseAppError {
	const error: BaseAppError = new Error(message);
	error.name = "AppError";
	error.code = code;
	error.context = context;
	error.timestamp = new Date();

	// Preserve stack trace if available
	if (originalError instanceof Error && originalError.stack) {
		error.stack = originalError.stack;
	}

	return error;
}

/**
 * Common error codes used throughout the application
 */
export const ERROR_CODES = {
	// API Errors
	NETWORK_ERROR: "NETWORK_ERROR",
	API_TIMEOUT: "API_TIMEOUT",
	API_UNAUTHORIZED: "API_UNAUTHORIZED",
	API_FORBIDDEN: "API_FORBIDDEN",
	API_NOT_FOUND: "API_NOT_FOUND",
	API_SERVER_ERROR: "API_SERVER_ERROR",

	// Database Errors
	DB_CONNECTION_FAILED: "DB_CONNECTION_FAILED",
	DB_QUERY_FAILED: "DB_QUERY_FAILED",
	DB_TRANSACTION_FAILED: "DB_TRANSACTION_FAILED",

	// VS Code Errors
	VSCODE_COMMAND_FAILED: "VSCODE_COMMAND_FAILED",
	VSCODE_SETTINGS_ERROR: "VSCODE_SETTINGS_ERROR",
	VSCODE_EXTENSION_ERROR: "VSCODE_EXTENSION_ERROR",

	// File System Errors
	FILE_NOT_FOUND: "FILE_NOT_FOUND",
	FILE_PERMISSION_DENIED: "FILE_PERMISSION_DENIED",
	FILE_READ_ERROR: "FILE_READ_ERROR",
	FILE_WRITE_ERROR: "FILE_WRITE_ERROR",

	// Parse Errors
	JSON_PARSE_ERROR: "JSON_PARSE_ERROR",
	INVALID_FORMAT: "INVALID_FORMAT",

	// Auth Errors
	TOKEN_EXPIRED: "TOKEN_EXPIRED",
	INVALID_TOKEN: "INVALID_TOKEN",
	AUTH_REQUIRED: "AUTH_REQUIRED",

	// General Errors
	UNKNOWN_ERROR: "UNKNOWN_ERROR",
	VALIDATION_ERROR: "VALIDATION_ERROR",
	CONFIGURATION_ERROR: "CONFIGURATION_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
