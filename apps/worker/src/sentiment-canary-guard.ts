import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const SHA256_HEX = /^[0-9a-f]{64}$/;

export class CanaryGuardError extends Error {
	constructor(
		readonly code:
			| "contract-sha256-format"
			| "contract-unreadable"
			| "contract-sha256-mismatch"
			| "contract-not-json"
			| "child-token",
	) {
		super(`canary guard refused: ${code}`);
		this.name = "CanaryGuardError";
	}
}

export function sha256Hex(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** The operator-supplied expected digest: 64 hex characters, any case. */
export function normalizeExpectedSha256(raw: string | undefined): string {
	const value = raw?.trim().toLowerCase() ?? "";
	if (!SHA256_HEX.test(value)) throw new CanaryGuardError("contract-sha256-format");
	return value;
}

/**
 * Read the contract file and accept it only when its raw bytes hash to the
 * digest the authorization named. Both the supervisor and the child call
 * this on their own, so a file edited between the two is caught by the child.
 */
export function readVerifiedContractFile(path: string, expectedSha256: string): { raw: unknown; sha256: string } {
	const expected = normalizeExpectedSha256(expectedSha256);
	let bytes: Buffer;
	try {
		bytes = readFileSync(path);
	} catch {
		throw new CanaryGuardError("contract-unreadable");
	}
	const actual = sha256Hex(bytes);
	if (!timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))) {
		throw new CanaryGuardError("contract-sha256-mismatch");
	}
	try {
		return { raw: JSON.parse(bytes.toString("utf8")), sha256: actual };
	} catch {
		throw new CanaryGuardError("contract-not-json");
	}
}

/**
 * One-time credential that ties a child invocation to the supervisor that
 * started it: the secret travels in the child's environment, its digest on
 * the command line, and the child runs only when the two match. A direct
 * child-mode invocation has neither and is refused before any work.
 */
export function issueChildToken(): { secret: string; proof: string } {
	const secret = randomBytes(32).toString("hex");
	return { secret, proof: sha256Hex(secret) };
}

export function verifyChildToken(secret: string | undefined, proof: string | undefined): boolean {
	if (!secret || !proof || !SHA256_HEX.test(proof) || !/^[0-9a-f]{64}$/.test(secret)) return false;
	return timingSafeEqual(Buffer.from(sha256Hex(secret), "hex"), Buffer.from(proof, "hex"));
}

/** Environment variable carrying the child secret; removed from the child's environment once checked. */
export const CHILD_SECRET_ENV = "SENTIMENT_CANARY_CHILD_SECRET";
