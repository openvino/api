import axios, { AxiosError } from "axios";
import { Log } from "ethers";
import { BLOCKSCOUT_API_KEY, BLOCKSCOUT_API_URL_BASE } from "../config";

const DEFAULT_BLOCKSCOUT_URL_BASE = "https://base.blockscout.com/api";

interface BlockscoutLogEntry {
	address?: string;
	blockNumber: string;
	blockHash?: string;
	data: string;
	timeStamp?: string;
	topics?: string[];
	topic0?: string;
	topic1?: string;
	topic2?: string;
	topic3?: string;
	transactionHash: string;
	transactionIndex?: string;
	logIndex?: string;
}

interface BlockscoutApiResponse {
	status: string;
	message: string;
	result: BlockscoutLogEntry[] | string | Record<string, unknown>;
}

interface FetchLogsParams {
	address: string;
	topic0: string;
	fromBlock: number;
	toBlock: number;
	pageSize: number;
	delayMs: number;
}

interface BlockscoutClientConfig {
	url?: string;
	apiKey?: string;
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
	if (value && typeof value === "object") {
		return value as Record<string, unknown>;
	}
	return undefined;
};

const asRecordArray = (value: unknown): Record<string, unknown>[] => {
	if (Array.isArray(value)) {
		return value
			.map((entry) => asRecord(entry))
			.filter((entry): entry is Record<string, unknown> => entry !== undefined);
	}
	return [];
};

type BlockscoutApiResult =
	| BlockscoutLogEntry[]
	| string
	| Record<string, unknown>
	| undefined;

const shouldRetryAxiosError = (error: unknown): boolean => {
	if (!error || typeof error !== "object") {
		return false;
	}

	const axiosError = error as AxiosError;
	const status = axiosError.response?.status;

	// Retry network errors (no status) and 5xx/429 responses.
	if (status === undefined) {
		return true;
	}

	if (status >= 500 || status === 429) {
		return true;
	}

	return false;
};

const executeWithRetries = async <T>(
	fn: () => Promise<T>,
	{
		maxRetries,
		delayMs,
		label,
	}: { maxRetries: number; delayMs: number; label: string }
): Promise<T> => {
	let attempt = 0;

	while (true) {
		try {
			return await fn();
		} catch (error) {
			attempt += 1;
			if (attempt > maxRetries || !shouldRetryAxiosError(error)) {
				throw error;
			}

			const backoff = delayMs > 0 ? delayMs * attempt : 500;
			console.warn(
				`[BlockscoutClient] retrying ${label} attempt ${attempt}/${maxRetries} in ${backoff}ms`,
				error instanceof Error ? error.message : error
			);
			await sleep(backoff);
		}
	}
};

const getTopicsArray = (entry: BlockscoutLogEntry): string[] => {
	const topics: string[] = [];

	const sourceTopics = entry.topics && Array.isArray(entry.topics)
		? entry.topics
		: [entry.topic0, entry.topic1, entry.topic2, entry.topic3];

	for (const topic of sourceTopics) {
		if (!topic) continue;
		const normalized = topic.trim();
		if (!normalized) continue;
		topics.push(normalized);
	}

	return topics;
};

const toEthersLog = (
	entry: BlockscoutLogEntry,
	fallbackAddress: string
): Log & { blockTimestamp?: number } => {
	const blockNumber = Number(entry.blockNumber);
	const logIndex = entry.logIndex !== undefined ? Number(entry.logIndex) : undefined;
	const txIndex = entry.transactionIndex !== undefined ? Number(entry.transactionIndex) : undefined;

	const basicLog = {
		address: entry.address ?? fallbackAddress,
		blockNumber,
		blockHash: entry.blockHash ?? "0x",
		transactionHash: entry.transactionHash,
		transactionIndex: txIndex ?? 0,
		index: logIndex ?? 0,
		removed: false,
		data: entry.data,
		topics: getTopicsArray(entry),
	};

	const log = basicLog as unknown as Log & { blockTimestamp?: number };

	if (entry.timeStamp) {
		const parsed = Number(entry.timeStamp);
		if (Number.isFinite(parsed)) {
			log.blockTimestamp = parsed;
		}
	}

	return log;
};

export const fetchLogsFromBlockscout = async (
	params: FetchLogsParams,
	config?: BlockscoutClientConfig
): Promise<Log[]> => {
	const baseURL =
		config?.url ?? BLOCKSCOUT_API_URL_BASE ?? DEFAULT_BLOCKSCOUT_URL_BASE;
	const logs: Log[] = [];
	let page = 1;

	while (true) {
		const query = {
			module: "logs",
			action: "getLogs",
			address: params.address,
			topic0: params.topic0,
			fromBlock: params.fromBlock,
			toBlock: params.toBlock,
			page,
			offset: params.pageSize,
			sort: "asc",
			apikey: config?.apiKey ?? BLOCKSCOUT_API_KEY,
		};

		const { data } = await axios.get<BlockscoutApiResponse>(baseURL, {
			params: query,
		});

		if (data.status === "0") {
			const message = data.message?.toLowerCase() ?? "";
			if (
				message.includes("no records") ||
				message.includes("no logs") ||
				message.includes("notok")
			) {
				break;
			}

			const errorDetail = Array.isArray(data.result)
				? JSON.stringify(data.result)
				: String(data.result ?? data.message);
			throw new Error(
				`Blockscout API error: ${data.message || "unknown"} (${errorDetail})`
			);
		}

		if (!Array.isArray(data.result)) {
			throw new Error(`Unexpected Blockscout response: ${JSON.stringify(data.result)}`);
		}

		const pageLogs = data.result.map((entry) => toEthersLog(entry, params.address));
		logs.push(...pageLogs);

		if (pageLogs.length < params.pageSize) {
			break;
		}

		page += 1;

		if (params.delayMs > 0) {
			await sleep(params.delayMs);
		}
	}

	return logs;
};

const normalizeBlockscoutBaseUrl = (url?: string): string => {
	if (!url) {
		return DEFAULT_BLOCKSCOUT_URL_BASE;
	}
	return url.endsWith("/") ? url.slice(0, -1) : url;
};

interface FetchTokenInfoResult {
	address?: string;
	name?: string;
	symbol?: string;
	decimals?: number;
	totalSupply?: string;
	totalTransfers?: number;
	holdersCount?: number;
	price?: {
		rate?: number;
		currency?: string;
		token?: string;
		usd?: number;
	};
	marketCap?: number;
	circulatingSupply?: string;
	raw: Record<string, unknown>;
}

const parseNumber = (value: unknown): number | undefined => {
	if (value === undefined || value === null || value === "") {
		return undefined;
	}
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : undefined;
};

export const fetchTokenInfoFromBlockscout = async (
	contractAddress: string,
	config?: BlockscoutClientConfig
): Promise<FetchTokenInfoResult | undefined> => {
	const baseURL = normalizeBlockscoutBaseUrl(
		config?.url ?? BLOCKSCOUT_API_URL_BASE
	);

	const { data } = await axios.get<BlockscoutApiResponse>(baseURL, {
		params: {
			module: "token",
			action: "tokeninfo",
			contractaddress: contractAddress,
			apikey: config?.apiKey ?? BLOCKSCOUT_API_KEY,
		},
	});

	if (data.status === "0") {
		const message = (data.message ?? "").toLowerCase();
		if (message.includes("no result") || message.includes("notok")) {
			return undefined;
		}
		const errorDetail =
			typeof data.result === "string"
				? data.result
				: JSON.stringify(data.result);
		throw new Error(
			`Blockscout tokeninfo error: ${data.message || "unknown"} (${errorDetail})`
		);
	}

	const rawResultArray = asRecordArray(data.result);
	const rawResult =
		rawResultArray.length > 0
			? rawResultArray[0]
			: asRecord(data.result);

	if (!rawResult) {
		return undefined;
	}

	const parseString = (key: string): string | undefined => {
		const value = rawResult[key];
		return typeof value === "string" && value.trim()
			? value.trim()
			: undefined;
	};

	const decimalsRaw = rawResult.decimals ?? rawResult.tokenDecimal;
	const holdersRaw =
		rawResult.holders ?? rawResult.holdersCount ?? rawResult.totalHolders;
	const transfersRaw =
		rawResult.totalTransfers ?? rawResult.transfersCount ?? rawResult.transfers;
	const totalSupplyRaw =
		parseString("totalSupply") ?? parseString("total_supply") ?? undefined;
	const circulatingSupplyRaw =
		parseString("circulatingSupply") ??
		parseString("circulating_supply") ??
		undefined;

	const priceRaw = rawResult.price;
	let price:
		| {
				rate?: number;
				currency?: string;
				token?: string;
				usd?: number;
		  }
		| undefined;

	if (priceRaw && typeof priceRaw === "object") {
		const priceRecord = priceRaw as Record<string, unknown>;
		price = {
			rate: parseNumber(priceRecord.rate ?? priceRecord.price),
			currency:
				typeof priceRecord.currency === "string"
					? priceRecord.currency
					: undefined,
			token:
				typeof priceRecord.token === "string" ? priceRecord.token : undefined,
			usd: parseNumber(priceRecord.usd ?? priceRecord.price_usd),
		};
	}

	const marketCapRaw =
		parseNumber(rawResult.marketCap ?? rawResult.market_cap) ?? undefined;

	return {
		address:
			parseString("contractAddress") ?? parseString("contract_address") ?? undefined,
		name: parseString("name"),
		symbol: parseString("symbol"),
		decimals: parseNumber(decimalsRaw),
		totalSupply: totalSupplyRaw,
		circulatingSupply: circulatingSupplyRaw,
		totalTransfers: parseNumber(transfersRaw),
		holdersCount: parseNumber(holdersRaw),
		price,
		marketCap: marketCapRaw,
		raw: rawResult,
	};
};

export interface FetchTokenTransfersOptions {
	startBlock?: number;
	endBlock?: number;
	pageSize: number;
	delayMs: number;
	maxPages?: number;
	maxRetries?: number;
	onPage?: (pageInfo: {
		page: number;
		items: BlockscoutTokenTransfer[];
		rawItems: Record<string, unknown>[];
	}) => void;
}

export interface BlockscoutTokenTransfer {
	blockNumber: number;
	timeStamp?: number;
	hash: string;
	from: string;
	to: string;
	value: string;
	tokenDecimal?: number;
	logIndex?: number;
	transactionIndex?: number;
}

const normalizeNumberString = (value: unknown, defaultValue = "0"): string => {
	if (value === undefined || value === null) {
		return defaultValue;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed : defaultValue;
	}
	if (typeof value === "number" || typeof value === "bigint") {
		return value.toString();
	}
	return defaultValue;
};

export const fetchTokenTransfersFromBlockscout = async (
	contractAddress: string,
	options: FetchTokenTransfersOptions,
	config?: BlockscoutClientConfig
): Promise<BlockscoutTokenTransfer[]> => {
	const baseURL = normalizeBlockscoutBaseUrl(
		config?.url ?? BLOCKSCOUT_API_URL_BASE
	);
	const transfers: BlockscoutTokenTransfer[] = [];
	let page = 1;
	const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
	const maxRetries = options.maxRetries ?? 3;

	while (page <= maxPages) {
		const params: Record<string, unknown> = {
			module: "account",
			action: "tokentx",
			contractaddress: contractAddress,
			page,
			offset: options.pageSize,
			sort: "asc",
			apikey: config?.apiKey ?? BLOCKSCOUT_API_KEY,
		};
		if (options.startBlock !== undefined) {
			params.startblock = options.startBlock;
		}
		if (options.endBlock !== undefined) {
			params.endblock = options.endBlock;
		}

		const data = await executeWithRetries(
			async () => {
				const response = await axios.get<BlockscoutApiResponse>(baseURL, {
					params,
				});
				return response.data;
			},
			{
				maxRetries,
				delayMs: options.delayMs,
				label: `tokentx page=${page}`,
			}
		);

		if (data.status === "0") {
			const message = (data.message ?? "").toLowerCase();
			if (
				message.includes("no") &&
				(message.includes("records") ||
					message.includes("transaction") ||
					message.includes("result") ||
					message.includes("transfer"))
			) {
				break;
			}
			const errorDetail =
				typeof data.result === "string"
					? data.result
					: JSON.stringify(data.result);
			throw new Error(
				`Blockscout tokentx error: ${data.message || "unknown"} (${errorDetail})`
			);
		}

		const pageItems = asRecordArray(data.result);

		if (!pageItems.length) {
			break;
		}

		const normalizedItems: BlockscoutTokenTransfer[] = [];

		for (const item of pageItems) {
			const blockNumber = parseNumber(item.blockNumber ?? item.block_number);
			const timestamp = parseNumber(item.timeStamp ?? item.timestamp);
			const hash = normalizeNumberString(item.hash ?? item.transactionHash, "");
			const from =
				typeof item.from === "string" ? item.from : normalizeNumberString(item.from);
			const to =
				typeof item.to === "string" ? item.to : normalizeNumberString(item.to);
			const value = normalizeNumberString(item.value);
			const tokenDecimal = parseNumber(
				item.tokenDecimal ?? item.tokenDecimals ?? item.decimals
			);
			const logIndex = parseNumber(item.logIndex ?? item.log_index);
			const transactionIndex = parseNumber(
				item.transactionIndex ?? item.transaction_index
			);

			if (!blockNumber || !hash) {
				continue;
			}

			const transfer: BlockscoutTokenTransfer = {
				blockNumber,
				timeStamp: timestamp,
				hash,
				from,
				to,
				value,
				tokenDecimal,
				logIndex,
				transactionIndex,
			};

			normalizedItems.push(transfer);
			transfers.push(transfer);
		}

		if (normalizedItems.length && options.onPage) {
			options.onPage({
				page,
				items: normalizedItems,
				rawItems: pageItems,
			});
		}

		if (pageItems.length < options.pageSize) {
			break;
		}

		page += 1;

		if (options.delayMs > 0) {
			await sleep(options.delayMs);
		}
	}

	return transfers;
};

export interface FetchTokenHoldersOptions {
	pageSize: number;
	delayMs: number;
	maxPages?: number;
	maxRetries?: number;
}

export interface BlockscoutTokenHolder {
	address: string;
	value: string;
	percentage?: number;
}

export const fetchTokenHoldersFromBlockscout = async (
	contractAddress: string,
	options: FetchTokenHoldersOptions,
	config?: BlockscoutClientConfig
): Promise<BlockscoutTokenHolder[]> => {
	const baseURL = normalizeBlockscoutBaseUrl(
		config?.url ?? BLOCKSCOUT_API_URL_BASE
	);
	const holders: BlockscoutTokenHolder[] = [];
	let page = 1;
	const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
	const maxRetries = options.maxRetries ?? 3;

	while (page <= maxPages) {
		const params: Record<string, unknown> = {
			module: "token",
			action: "tokenholderslist",
			contractaddress: contractAddress,
			page,
			offset: options.pageSize,
			apikey: config?.apiKey ?? BLOCKSCOUT_API_KEY,
		};

		const data = await executeWithRetries(
			async () => {
				const response = await axios.get<BlockscoutApiResponse>(baseURL, {
					params,
				});
				return response.data;
			},
			{
				maxRetries,
				delayMs: options.delayMs,
				label: `tokenholders page=${page}`,
			}
		);

		if (data.status === "0") {
			const message = (data.message ?? "").toLowerCase();
			if (
				message.includes("no") &&
				(message.includes("records") ||
					message.includes("holders") ||
					message.includes("result"))
			) {
				break;
			}
			const errorDetail =
				typeof data.result === "string"
					? data.result
					: JSON.stringify(data.result);
			throw new Error(
				`Blockscout tokenholderslist error: ${data.message || "unknown"} (${errorDetail})`
			);
		}

		const pageItems = asRecordArray(data.result);

		if (!pageItems.length) {
			break;
		}

		for (const item of pageItems) {
			const address =
				(typeof item.holderAddress === "string" && item.holderAddress) ||
				(typeof item.HolderAddress === "string" && item.HolderAddress) ||
				(typeof item.address === "string" && item.address) ||
				(typeof item.Address === "string" && item.Address);
			if (!address) {
				continue;
			}

			const balance =
				(typeof item.tokenBalance === "string" && item.tokenBalance) ||
				(typeof item.TokenBalance === "string" && item.TokenBalance) ||
				(typeof item.balance === "string" && item.balance) ||
				(typeof item.Balance === "string" && item.Balance) ||
				"0";

			const percentage = parseNumber(
				item.percentage ??
					item.Percentage ??
					item.share ??
					item.Share ??
					item.holderPercentage ??
					item.holder_percentage
			);

			holders.push({
				address,
				value: balance.trim(),
				percentage,
			});
		}

		if (pageItems.length < options.pageSize) {
			break;
		}

		page += 1;

		if (options.delayMs > 0) {
			await sleep(options.delayMs);
		}
	}

	return holders;
};

export const fetchTokenInfoWithRetries = async (
	contractAddress: string,
	config: BlockscoutClientConfig | undefined,
	{
		maxRetries,
		delayMs,
	}: { maxRetries: number; delayMs: number }
): Promise<FetchTokenInfoResult | undefined> =>
	executeWithRetries(
		() => fetchTokenInfoFromBlockscout(contractAddress, config),
		{
			maxRetries,
			delayMs,
			label: "tokeninfo",
		}
	);
