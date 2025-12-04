import path from "path";
import { promises as fs } from "fs";
import { JsonRpcProvider } from "ethers";

type VerificationCachePayload = {
	network: string;
	address: string;
	contractName: string;
	compilerVersion: string;
	constructorArgs?: string;
	optimizationUsed?: "0" | "1";
	runs?: string;
	tokenName?: string;
	tokenSymbol?: string;
	sourceCode: string;
	explorerResponse?: { status: string; message: string; result: string };
	errorMessage?: string;
};

const VERIFICATION_CACHE_DIR = path.join(
	process.cwd(),
	"uploads",
	"cache",
	"verification"
);

const sanitize = (value: string): string => {
	const normalized = value.toLowerCase().trim().replace(/[^a-z0-9_-]/g, "-");
	return normalized || "unknown";
};

const resolveRpcUrl = (network?: string): string | undefined => {
	const normalized = (network ?? "").toLowerCase();

	if (["mainnet", "eth", "ethereum"].includes(normalized)) {
		return (
			process.env.RPC_URL_MAINNET ??
			process.env.RPC_URL_ETHEREUM ??
			process.env.RPC_URL
		);
	}

	if (normalized === "sepolia") {
		return (
			process.env.RPC_URL_SEPOLIA ??
			process.env.RPC_URL_TESTNET ??
			process.env.RPC_URL
		);
	}

	if (normalized === "base") {
		return process.env.RPC_URL_BASE ?? process.env.RPC_URL;
	}

	if (normalized === "basesepolia" || normalized === "base-sepolia") {
		return (
			process.env.RPC_URL_BASE_SEPOLIA ??
			process.env.RPC_URL_BASE_SEP ??
			process.env.RPC_URL
		);
	}

	return process.env.RPC_URL_BASE ?? process.env.RPC_URL;
};

const fetchDeployedBytecode = async (
	network: string,
	address: string
): Promise<{ bytecode?: string; error?: string }> => {
	try {
		const rpcUrl = resolveRpcUrl(network);
		if (!rpcUrl) {
			return { error: "No RPC URL configured for this network" };
		}

		const provider = new JsonRpcProvider(rpcUrl);
		const code = await provider.getCode(address);
		return { bytecode: code };
	} catch (error) {
		return {
			error:
				error instanceof Error ? error.message : "Unknown error fetching bytecode",
		};
	}
};

export const saveVerificationDebugPayload = async (
	payload: VerificationCachePayload
): Promise<string | undefined> => {
	const {
		network,
		address,
		contractName,
		tokenName,
		tokenSymbol,
		compilerVersion,
		constructorArgs = "",
		optimizationUsed = "1",
		runs = "200",
		sourceCode,
		explorerResponse,
		errorMessage,
	} = payload;

	const { bytecode, error: bytecodeError } = await fetchDeployedBytecode(
		network,
		address
	);

	const networkSegment = sanitize(network || "base");
	const label =
		tokenSymbol ||
		tokenName ||
		(contractName ? contractName.split(":").pop() : undefined) ||
		contractName;
	const fileName = `${sanitize(label ?? "contract")}-${sanitize(
		address
	)}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
	const cachePath = path.join(VERIFICATION_CACHE_DIR, networkSegment, fileName);

	const standardJsonInput = (() => {
		try {
			return JSON.parse(sourceCode);
		} catch {
			return sourceCode;
		}
	})();

	const debugPayload = {
		timestamp: new Date().toISOString(),
		network,
		address,
		contractName,
		compilerVersion,
		optimizationUsed,
		runs,
		constructorArgs,
		sourceCodeFormat: "solidity-standard-json-input",
	standardJsonInput,
	deployedBytecode: bytecode,
	bytecodeError,
	explorerResponse,
	errorMessage,
	standardJsonInputPath: undefined as string | undefined,
	};

	if (standardJsonInput && typeof standardJsonInput === "object") {
		try {
			const standardPath = cachePath.replace(/\.json$/, ".standard.json");
			await fs.writeFile(
				standardPath,
				JSON.stringify(standardJsonInput, null, 2),
				"utf8"
			);
			debugPayload.standardJsonInputPath = standardPath;
		} catch (error) {
			console.warn(
				`[VerificationCache] Failed to write standard json input at ${cachePath}`,
				error instanceof Error ? error.message : error
			);
		}
	}

	try {
		await fs.mkdir(path.dirname(cachePath), { recursive: true });
		await fs.writeFile(cachePath, JSON.stringify(debugPayload, null, 2), "utf8");
		return cachePath;
	} catch (error) {
		console.warn(
			`[VerificationCache] Failed to persist debug payload at ${cachePath}`,
			error instanceof Error ? error.message : error
		);
		return undefined;
	}
};
