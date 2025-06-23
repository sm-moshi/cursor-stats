import * as jwt from "jsonwebtoken";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import initSqlJs from "sql.js";
import * as vscode from "vscode";
import { getErrorMessage, isNodeError, isParseError, logStructuredError } from "../interfaces/errors";
import { log } from "../utils/logger";

// use globalStorageUri to get the user directory path
// support Portable mode : https://code.visualstudio.com/docs/editor/portable
function getDefaultUserDirPath(): string {
	// Import getExtensionContext here to avoid circular dependency
	const { getExtensionContext } = require("../extension");
	const context = getExtensionContext();
	const extensionGlobalStoragePath = context.globalStorageUri.fsPath;
	const userDirPath = path.dirname(path.dirname(path.dirname(extensionGlobalStoragePath)));
	log(`[Database] Default user directory path: ${userDirPath}`);
	return userDirPath;
}

export function getCursorDBPath(): string {
	// Check for custom path in settings
	const config = vscode.workspace.getConfiguration("cursorStats");
	const customPath = config.get<string>("customDatabasePath");
	const userDirPath = getDefaultUserDirPath();

	if (customPath && customPath.trim() !== "") {
		log(`[Database] Using custom path: ${customPath}`);
		return customPath;
	}

	const folderName = vscode.env.appName;
	const defaultPath = path.join(userDirPath, "User", "globalStorage", "state.vscdb");

	switch (process.platform) {
		case "win32":
			return defaultPath;

		case "linux": {
			const isWSL = vscode.env.remoteName === "wsl";
			if (isWSL) {
				const windowsUsername = getWindowsUsername();
				if (windowsUsername) {
					return path.join(
						"/mnt/c/Users",
						windowsUsername,
						"AppData/Roaming",
						folderName,
						"User/globalStorage/state.vscdb",
					);
				}
			}
			return defaultPath;
		}

		case "darwin":
			return defaultPath;

		default:
			return defaultPath;
	}
}

export async function getCursorTokenFromDB(): Promise<string | undefined> {
	try {
		const dbPath = getCursorDBPath();
		log(`[Database] Attempting to open database at: ${dbPath}`);

		if (!fs.existsSync(dbPath)) {
			log("[Database] Database file does not exist", true);
			return undefined;
		}

		const dbBuffer = fs.readFileSync(dbPath);
		const SQL = await initSqlJs();
		const db = new SQL.Database(new Uint8Array(dbBuffer));

		const result = db.exec("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'");

		if (!result.length || !result[0].values.length) {
			log("[Database] No token found in database");
			db.close();
			return undefined;
		}

		const token = result[0].values[0][0] as string;
		log(`[Database] Token starts with: ${token.substring(0, 20)}...`);

		try {
			const decoded = jwt.decode(token, { complete: true });
			const sub = decoded?.payload?.sub;

			if (!sub || typeof decoded?.payload === "string" || typeof sub !== "string") {
				log(`[Database] Invalid JWT structure: ${JSON.stringify({ decoded })}`, true);
				db.close();
				return undefined;
			}
			const userId = sub.split("|")[1];
			const sessionToken = `${userId}%3A%3A${token}`;
			log(`[Database] Created session token, length: ${sessionToken.length}`);
			db.close();
			return sessionToken;
		} catch (error: unknown) {
			logStructuredError(error, "[Database]", "Error processing token");
			db.close();
			return undefined;
		}
	} catch (error: unknown) {
		logStructuredError(error, "[Database]", "Error opening database");
		return undefined;
	}
}
export function getWindowsUsername(): string | undefined {
	try {
		// Executes cmd.exe and echoes the %USERNAME% variable
		const result = execSync('cmd.exe /C "echo %USERNAME%"', { encoding: "utf8" });
		const username = result.trim();
		return username || undefined;
	} catch (error) {
		console.error("Error getting Windows username:", error);
		return undefined;
	}
}
