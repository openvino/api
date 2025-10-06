import { JsonRpcProvider } from "ethers";
import {
	RPC_URL_BASE,
	RPC_URL_MAINNET,
	RPC_URL_OPTIMISM,
	BLOCKSCOUT_API_URL_BASE,
	BLOCKSCOUT_API_URL_MAINNET,
	BLOCKSCOUT_API_URL_OPTIMISM,
	BLOCKSCOUT_API_KEY,
} from "./envs";

const providerCache = new Map<string, JsonRpcProvider>();

const networkRpcUrls: Record<string, string | undefined> = {
	default: RPC_URL_BASE,
	base: RPC_URL_BASE,
	ethereum: RPC_URL_MAINNET ?? undefined,
	mainnet: RPC_URL_MAINNET ?? undefined,
	optimism: RPC_URL_OPTIMISM,
};

const DEFAULT_BLOCKSCOUT_URL_MAINNET = "https://eth.blockscout.com/api";
const DEFAULT_BLOCKSCOUT_URL_OPTIMISM = "https://optimism.blockscout.com/api";

type BlockscoutConfig = {
	url?: string;
	apiKey?: string;
};

const blockscoutConfig: Record<string, BlockscoutConfig> = {
	default: { url: BLOCKSCOUT_API_URL_BASE, apiKey: BLOCKSCOUT_API_KEY },
	base: { url: BLOCKSCOUT_API_URL_BASE, apiKey: BLOCKSCOUT_API_KEY },
	ethereum: {
		url: BLOCKSCOUT_API_URL_MAINNET ?? DEFAULT_BLOCKSCOUT_URL_MAINNET,
		apiKey: BLOCKSCOUT_API_KEY ?? undefined,
	},
	mainnet: {
		url: BLOCKSCOUT_API_URL_MAINNET ?? DEFAULT_BLOCKSCOUT_URL_MAINNET,
		apiKey: BLOCKSCOUT_API_KEY ?? undefined,
	},
	optimism: {
		url: BLOCKSCOUT_API_URL_OPTIMISM ?? DEFAULT_BLOCKSCOUT_URL_OPTIMISM,
		apiKey: BLOCKSCOUT_API_KEY ?? undefined,
	},
};

const normalizeNetworkKey = (network?: string): string => {
	if (!network) {
		return "default";
	}

	const normalized = network.toLowerCase().trim();

	if (normalized === "eth" || normalized === "ethereum" || normalized === "mainnet") {
		return "mainnet";
	}

	if (normalized === "base") {
		return "base";
	}

	if (normalized === "optimism" || normalized === "op") {
		return "optimism";
	}

	return "default";
};

export const getProviderForNetwork = (network?: string): JsonRpcProvider => {
	const key = normalizeNetworkKey(network);

	if (providerCache.has(key)) {
		return providerCache.get(key)!;
	}

	const rpcUrl = networkRpcUrls[key];
	if (!rpcUrl) {
		throw new Error(
			`No RPC URL configured for network "${network ?? "default"}"`
		);
	}

	const instance = new JsonRpcProvider(rpcUrl);
	providerCache.set(key, instance);
	return instance;
};

export const getBlockscoutConfigForNetwork = (
	network?: string
): BlockscoutConfig => {
	const key = normalizeNetworkKey(network);
	return blockscoutConfig[key] ?? blockscoutConfig.default;
};
