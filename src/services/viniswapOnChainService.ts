import path from "path";
import { promises as fs } from "fs";
import {
	Contract,
	Interface,
	Log,
	JsonRpcProvider,
	getAddress,
	ZeroAddress,
} from "ethers";
import { VINISWAP_PAIR_ABI, ERC20_ABI } from "../abi";
import {
	fetchLogsFromBlockscout,
	fetchBlockTimestampFromBlockscout,
	fetchTokenInfoWithRetries,
	fetchTokenTransfersFromBlockscout,
	fetchTokenHoldersFromBlockscout,
} from "./blockscoutClient";
import {
	TokenMetadata,
	ReserveSnapshot,
	SwapEvent,
	MintEvent,
	BurnEvent,
	SyncEvent,
	TransferEvent,
	SyncEventType,
	ViniswapHistoryOptions,
	ViniswapHistoryResult,
	ViniswapHistoryProgress,
	ViniswapHistoryCallbacks,
	BaseEvent,
	TokenTransferEvent,
	ViniswapTokenHistoryOptions,
	ViniswapTokenHistoryCache,
	ViniswapTokenHistoryResult,
	TokenHolderSnapshot,
} from "../interfaces";
import {
	formatBigint,
	formatIsoDate,
	formatReadableDate,
	sleep,
	toNumber,
} from "../utils";
import { normalizeNetworkKey } from "../config";

const pairInterface = new Interface(VINISWAP_PAIR_ABI);
const erc20Interface = new Interface(ERC20_ABI);

const TOKEN_HISTORY_CACHE_VERSION = 3;
const TOKEN_HISTORY_CACHE_DIR = path.join(
	process.cwd(),
	"uploads",
	"cache",
	"viniswap-token"
);
const PAIR_HISTORY_CACHE_DIR = path.join(
	process.cwd(),
	"uploads",
	"cache",
	"viniswap-pair"
);

const sanitizeCacheSegment = (value: string): string => {
	const normalized = value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9_-]/g, "-");
	return normalized || "default";
};

const getTokenCachePath = (
	network: string,
	tokenAddress: string,
	cacheKey?: string
): string => {
	const networkSegment = sanitizeCacheSegment(network || "default");
	const fileName = cacheKey
		? `${sanitizeCacheSegment(cacheKey)}.json`
		: `${tokenAddress.toLowerCase()}.json`;
	return path.join(TOKEN_HISTORY_CACHE_DIR, networkSegment, fileName);
};

const getViniswapPairCachePath = (
	network: string,
	pairAddress: string,
	cacheKey?: string
): string => {
	const networkSegment = sanitizeCacheSegment(network || "default");
	const fileName = cacheKey
		? `${sanitizeCacheSegment(cacheKey)}.json`
		: `${pairAddress.toLowerCase()}.json`;
	return path.join(PAIR_HISTORY_CACHE_DIR, networkSegment, fileName);
};

const loadTokenHistoryCache = async (
	cachePath: string
): Promise<ViniswapTokenHistoryCache | undefined> => {
	try {
		const raw = await fs.readFile(cachePath, "utf8");
		const parsed = JSON.parse(raw) as ViniswapTokenHistoryCache;
		if (parsed.version !== TOKEN_HISTORY_CACHE_VERSION) {
			return undefined;
		}
		return parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		console.warn(
			`[ViniswapTokenHistory] Failed to read cache at ${cachePath}`,
			error instanceof Error ? error.message : error
		);
		return undefined;
	}
};

const saveTokenHistoryCache = async (
	cachePath: string,
	cache: ViniswapTokenHistoryCache | ViniswapPairHistoryCache
): Promise<void> => {
	try {
		await fs.mkdir(path.dirname(cachePath), { recursive: true });
		await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), "utf8");
	} catch (error) {
		console.warn(
			`[ViniswapTokenHistory] Failed to write cache at ${cachePath}`,
			error instanceof Error ? error.message : error
		);
	}
};

interface ViniswapPairHistoryCache {
	version: number;
	network: string;
	pairAddress: string;
	startBlock: number;
	lastSyncedBlock: number;
	lastSyncedTimestamp?: number;
	events: {
		swaps: SwapEvent[];
		mints: MintEvent[];
		burns: BurnEvent[];
		syncs: SyncEvent[];
		transfers: TransferEvent[];
	};
}

const loadViniswapPairHistoryCache = async (
	cachePath: string
): Promise<ViniswapPairHistoryCache | undefined> => {
	try {
		const raw = await fs.readFile(cachePath, "utf8");
		const parsed = JSON.parse(raw) as ViniswapPairHistoryCache;
		if (parsed.version !== TOKEN_HISTORY_CACHE_VERSION) {
			return undefined;
		}
		return parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		console.warn(
			`[ViniswapPairHistory] Failed to read cache at ${cachePath}`,
			error instanceof Error ? error.message : error
		);
		return undefined;
	}
};

const saveViniswapPairHistoryCache = saveTokenHistoryCache;

export interface ViniswapHistoryContext {
	provider: JsonRpcProvider;
	blockscout?: { url?: string; apiKey?: string };
	networkKey?: string;
}

const getEventTopic = (eventName: string): string => {
	const fragment = pairInterface.getEvent(eventName);
	if (!fragment) {
		throw new Error(`Event ${eventName} not found in pair ABI`);
	}
	return fragment.topicHash;
};

const SWAP_TOPIC = getEventTopic("Swap");
const MINT_TOPIC = getEventTopic("Mint");
const BURN_TOPIC = getEventTopic("Burn");
const SYNC_TOPIC = getEventTopic("Sync");
const TRANSFER_TOPIC = getEventTopic("Transfer");
const ERC20_TRANSFER_TOPIC = (() => {
	const fragment = erc20Interface.getEvent("Transfer");
	if (!fragment) {
		throw new Error("Transfer event not found in ERC20 ABI");
	}
	return fragment.topicHash;
})();

const fetchTokenMetadata = async (
	tokenAddress: string,
	provider: JsonRpcProvider
): Promise<TokenMetadata> => {
	const tokenContract = new Contract(tokenAddress, ERC20_ABI, provider);

	try {
		const [symbol, name, decimals] = await Promise.all([
			tokenContract.symbol().catch(() => undefined),
			tokenContract.name().catch(() => undefined),
			tokenContract.decimals().catch(() => undefined),
		]);

		return {
			address: tokenAddress,
			symbol,
			name,
			decimals: typeof decimals === "bigint" ? Number(decimals) : decimals,
		};
	} catch (error) {
		console.warn(
			`Failed to fetch token metadata for ${tokenAddress}:`,
			error instanceof Error ? error.message : error
		);

		return { address: tokenAddress };
	}
};

const shouldRetryRequest = (error: unknown): boolean => {
	if (!error || typeof error !== "object") {
		return false;
	}

	const { code, message, shortMessage, value, info } = error as Record<
		string,
		unknown
	>;

	if (code === "TIMEOUT") {
		return true;
	}

	const serialized = JSON.stringify({ message, shortMessage, value, info });
	const lowerCaseError = serialized.toLowerCase();

	return (
		lowerCaseError.includes("too many requests") ||
		lowerCaseError.includes("header not found") ||
		lowerCaseError.includes("missing trie node") ||
		lowerCaseError.includes("rate limit")
	);
};

const withRetries = async <T>(
	action: () => Promise<T>,
	options: { maxRetries: number; delayMs: number; name?: string }
): Promise<T> => {
	let attempt = 0;
	for (;;) {
		try {
			return await action();
		} catch (error) {
			attempt += 1;
			if (attempt > options.maxRetries || !shouldRetryRequest(error)) {
				throw error;
			}
			const backoff = options.delayMs * attempt;
			console.warn(
				`[ViniswapOnChainService] Retrying ${
					options.name ?? "operation"
				} after error (attempt ${attempt}/${
					options.maxRetries
				}) in ${backoff}ms. Error: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
			await sleep(backoff);
		}
	}
};

const formatReservesSnapshot = (
	reserve0: bigint | number | string,
	reserve1: bigint | number | string,
	blockTimestamp: bigint | number
): ReserveSnapshot => ({
	reserve0: formatBigint(reserve0),
	reserve1: formatBigint(reserve1),
	blockTimestampLast: toNumber(blockTimestamp),
});

const sortTokenEvents = (events: TokenTransferEvent[]): TokenTransferEvent[] =>
	events.sort((a, b) => {
		if (a.blockNumber === b.blockNumber) {
			return (a.logIndex ?? 0) - (b.logIndex ?? 0);
		}
		return a.blockNumber - b.blockNumber;
	});

const normalizeChecksumAddress = (address: string): string => {
	try {
		return getAddress(address);
	} catch {
		return address;
	}
};

const ZERO_ADDRESS_LOWER = ZeroAddress.toLowerCase();

const categorizeTransfer = (
	from?: string | null,
	to?: string | null
): "mint" | "redeem" | "transfer" => {
	const fromLower = from?.toLowerCase?.();
	const toLower = to?.toLowerCase?.();
	if (fromLower === ZERO_ADDRESS_LOWER) {
		return "mint";
	}
	if (toLower === ZERO_ADDRESS_LOWER) {
		return "redeem";
	}
	return "transfer";
};

const updateBalance = (
	balances: Map<string, bigint>,
	address: string,
	delta: bigint
): void => {
	const current = balances.get(address) ?? BigInt(0);
	const next = current + delta;
	if (next === BigInt(0)) {
		balances.delete(address);
	} else {
		balances.set(address, next);
	}
};

const aggregateTokenTransfers = (
	events: TokenTransferEvent[],
	fallbackStartBlock: number,
	fallbackEndBlock: number
): {
	holders: TokenHolderSnapshot[];
	summary: ViniswapTokenHistoryResult["summary"];
} => {
	if (!events.length) {
		return {
			holders: [],
			summary: {
				firstBlock: fallbackStartBlock,
				firstTimestamp: undefined,
				firstIsoDate: undefined,
				lastBlock: fallbackEndBlock,
				lastTimestamp: undefined,
				lastIsoDate: undefined,
				holderCount: 0,
				uniqueAddresses: 0,
				transferCount: 0,
				redeemAmount: "0",
				mintCount: 0,
				mintAmount: "0",
				totalVolume: "0",
			},
		};
	}

	const balances = new Map<string, bigint>();
	const uniqueAddresses = new Set<string>();
	let mintCount = 0;
	let redeemAmount = BigInt(0);
	let mintAmount = BigInt(0);
	let totalVolume = BigInt(0);

	for (const event of events) {
		const fromLower = event.from?.toLowerCase?.() ?? "";
		const toLower = event.to?.toLowerCase?.() ?? "";
		let value: bigint;
		try {
			value = BigInt(event.value ?? "0");
		} catch {
			value = BigInt(0);
		}

		if (fromLower && fromLower !== ZERO_ADDRESS_LOWER) {
			uniqueAddresses.add(fromLower);
			if (value) {
				updateBalance(balances, fromLower, -value);
			}
		} else if (fromLower === ZERO_ADDRESS_LOWER) {
			mintCount += 1;
			mintAmount += value;
		}

		if (toLower && toLower !== ZERO_ADDRESS_LOWER) {
			uniqueAddresses.add(toLower);
			if (value) {
				updateBalance(balances, toLower, value);
			}
		} else if (toLower === ZERO_ADDRESS_LOWER) {
			redeemAmount += value;
		}

		if (value) {
			totalVolume += value;
		}
	}

	const holders = Array.from(balances.entries())
		.filter(([, balance]) => balance !== BigInt(0))
		.map(([address, balance]) => ({
			address: normalizeChecksumAddress(address),
			balance: balance.toString(),
		}))
		.sort((a, b) => {
			const aValue = BigInt(a.balance);
			const bValue = BigInt(b.balance);
			if (aValue === bValue) {
				return a.address.localeCompare(b.address);
			}
			return bValue > aValue ? 1 : -1;
		});

	const firstEvent = events[0];
	const lastEvent = events[events.length - 1];

	return {
		holders,
		summary: {
			firstBlock: firstEvent?.blockNumber ?? fallbackStartBlock,
			firstTimestamp: firstEvent?.timestamp,
			firstIsoDate: firstEvent?.isoDate,
			lastBlock: lastEvent?.blockNumber ?? fallbackEndBlock,
			lastTimestamp: lastEvent?.timestamp,
			lastIsoDate: lastEvent?.isoDate,
			holderCount: holders.length,
			uniqueAddresses: uniqueAddresses.size,
			transferCount: events.length,
			redeemAmount: redeemAmount.toString(),
			mintCount,
			mintAmount: mintAmount.toString(),
			totalVolume: totalVolume.toString(),
		},
	};
};

const paginateBlocks = async <T extends BaseEvent>(
	pairAddress: string,
	topic: string,
	fromBlock: number,
	toBlock: number,
	batchSize: number,
	parser: (log: Log) => Promise<T>,
	eventType: SyncEventType,
	callbacks: ViniswapHistoryCallbacks | undefined,
	options: {
		batchDelayMs: number;
		maxRetries: number;
		blockscout: { pageSize: number; delayMs: number };
	},
	context: {
		provider: JsonRpcProvider;
		blockscout?: { url?: string; apiKey?: string };
	},
	fetchReserves?: (blockNumber: number) => Promise<ReserveSnapshot | undefined>
): Promise<T[]> => {
	const results: T[] = [];
	if (!context.blockscout?.url) {
		throw new Error("Blockscout configuration is required for pagination");
	}

	for (let current = fromBlock; current <= toBlock; current += batchSize) {
		const batchEnd = Math.min(current + batchSize - 1, toBlock);
		let logs: Log[] = [];
		let attempt = 0;
		while (true) {
			try {
				logs = await fetchLogsFromBlockscout(
					{
						address: pairAddress,
						topic0: topic,
						fromBlock: current,
						toBlock: batchEnd,
						pageSize: options.blockscout.pageSize,
						delayMs: options.blockscout.delayMs,
					},
					context.blockscout
				);
				break;
			} catch (error) {
				attempt += 1;

				if (attempt > options.maxRetries || !shouldRetryRequest(error)) {
					throw error;
				}

				const backoff = options.batchDelayMs * attempt;
				console.warn(
					`[ViniswapPairHistory] retrying Blockscout ${eventType} ${current} -> ${batchEnd} (attempt ${attempt}/${options.maxRetries}) in ${backoff}ms`
				);
				await sleep(backoff);
			}
		}

		for (const log of logs) {
			const parsed = await parser(log);
			if (fetchReserves) {
				const reserves = await fetchReserves(Number(log.blockNumber));
				if (reserves && typeof parsed === "object" && parsed !== null) {
					Object.assign(parsed as Record<string, unknown>, {
						reservesAfter: reserves,
					});
				}
			}

			const rawTimestamp = (log as { blockTimestamp?: number }).blockTimestamp;
			if (
				rawTimestamp !== undefined &&
				typeof parsed === "object" &&
				parsed !== null
			) {
				Object.assign(parsed as Record<string, unknown>, {
					timestamp: rawTimestamp,
					isoDate: Number.isFinite(rawTimestamp)
						? formatIsoDate(rawTimestamp as number)
						: undefined,
					readableDate: Number.isFinite(rawTimestamp)
						? formatReadableDate(rawTimestamp as number)
						: undefined,
				});
			}

			if (callbacks?.onEvent) {
				callbacks.onEvent(
					eventType,
					parsed as unknown as
						| SwapEvent
						| MintEvent
						| BurnEvent
						| SyncEvent
						| TransferEvent
				);
			}
			results.push(parsed);
		}

		if (callbacks?.onProgress) {
			const progress: ViniswapHistoryProgress = {
				eventType,
				fromBlock: current,
				toBlock: batchEnd,
				entriesFound: logs.length,
			};
			callbacks.onProgress(progress);
		}

		if (options.batchDelayMs > 0 && batchEnd < toBlock) {
			await sleep(options.batchDelayMs);
		}
	}

	return results;
};

const findBlockAtOrBeforeTimestamp = async (
	context: ViniswapHistoryContext,
	targetTimestamp: number,
	latestBlockNumber: number
): Promise<{ blockNumber: number; blockTimestamp: number } | undefined> => {
	if (targetTimestamp <= 0) {
		return undefined;
	}

	let left = 0;
	let right = latestBlockNumber;
	let best:
		| {
				blockNumber: number;
				blockTimestamp: number;
		  }
		| undefined;
	const timestampCache = new Map<number, number>();

	while (left <= right) {
		const mid = Math.floor((left + right) / 2);
		let timestamp = timestampCache.get(mid);
		if (timestamp === undefined) {
			const fetched = await getBlockTimestamp(mid, context);
			timestamp = fetched ?? 0;
			timestampCache.set(mid, timestamp);
		}

		if (!timestamp) {
			right = mid - 1;
			continue;
		}

		if (timestamp <= targetTimestamp) {
			best = { blockNumber: mid, blockTimestamp: timestamp };
			left = mid + 1;
		} else {
			right = mid - 1;
		}
	}

	return best;
};

const getBlockTimestamp = async (
	blockNumber: number,
	context: ViniswapHistoryContext,
	{
		blockscoutMaxRetries = 3,
		blockscoutDelayMs = 500,
		providerMaxRetries = 5,
		providerDelayMs = 500,
	}: {
		blockscoutMaxRetries?: number;
		blockscoutDelayMs?: number;
		providerMaxRetries?: number;
		providerDelayMs?: number;
	} = {}
): Promise<number | undefined> => {
	const { provider, blockscout } = context;

	if (blockscout && (blockscout.url || blockscout.apiKey)) {
		try {
			const timestamp = await fetchBlockTimestampFromBlockscout(
				blockNumber,
				{
					maxRetries: blockscoutMaxRetries,
					delayMs: blockscoutDelayMs,
				},
				blockscout
			);

			if (timestamp !== undefined) {
				return timestamp;
			}
		} catch (error) {
			console.warn(
				`[ViniswapPairHistory] Blockscout timestamp lookup failed for block ${blockNumber}`,
				error instanceof Error ? error.message : error
			);
		}
	}

	let attempt = 0;
	for (;;) {
		try {
			const block = await provider.getBlock(blockNumber);
			return block ? Number(block.timestamp) : undefined;
		} catch (error) {
			attempt += 1;

			if (attempt > providerMaxRetries || !shouldRetryRequest(error)) {
				throw error;
			}

			const backoff = providerDelayMs * attempt;
			console.warn(
				`[ViniswapPairHistory] retrying provider block ${blockNumber} (attempt ${attempt}/${providerMaxRetries}) in ${backoff}ms`
			);
			await sleep(backoff);
		}
	}
};

const enrichWithTimestamp = async <T extends BaseEvent>(
	events: T[],
	context: ViniswapHistoryContext
): Promise<void> => {
	const eventsNeedingTimestamp = events.filter(
		(event) => event.timestamp === undefined
	);

	if (!eventsNeedingTimestamp.length) {
		return;
	}

	const uniqueBlocks = Array.from(
		new Set(eventsNeedingTimestamp.map((event) => event.blockNumber))
	);

	const timestampCache = new Map<number, number>();

	for (const blockNumber of uniqueBlocks) {
		const timestamp = await getBlockTimestamp(blockNumber, context, {
			blockscoutMaxRetries: 5,
			blockscoutDelayMs: 750,
			providerMaxRetries: 8,
			providerDelayMs: 750,
		});
		timestampCache.set(blockNumber, timestamp ?? 0);
	}

	eventsNeedingTimestamp.forEach((event) => {
		const ts = timestampCache.get(event.blockNumber) ?? 0;
		event.timestamp = ts;
		event.isoDate = ts ? formatIsoDate(ts) : undefined;
		event.readableDate = ts ? formatReadableDate(ts) : undefined;
	});
};

export const fetchViniswapPairHistory = async (
	pairAddress: string,
	options: ViniswapHistoryOptions,
	callbacks: ViniswapHistoryCallbacks = {},
	context: ViniswapHistoryContext
): Promise<ViniswapHistoryResult> => {
	if (!pairAddress) {
		throw new Error("pairAddress is required");
	}

	if (options.startBlock === undefined || Number.isNaN(options.startBlock)) {
		throw new Error("startBlock is required in options");
	}

	const normalizedAddress = getAddress(pairAddress);
	const { provider, blockscout } = context;

	const pairContract = new Contract(
		normalizedAddress,
		VINISWAP_PAIR_ABI,
		provider
	);

	const latestBlock = await provider.getBlockNumber();
	const latestBlockTimestamp =
		(await getBlockTimestamp(latestBlock, context, {
			providerDelayMs: 500,
		})) ?? Math.floor(Date.now() / 1000);

	const requestedStartBlock = Math.max(0, Math.trunc(options.startBlock));
	const requestedEndBlock = options.endBlock
		? Math.trunc(options.endBlock)
		: latestBlock;

	if (requestedStartBlock > requestedEndBlock) {
		throw new Error("startBlock cannot be greater than endBlock");
	}

	const networkKey = normalizeNetworkKey(context.networkKey);
	const cachePath = getViniswapPairCachePath(
		networkKey,
		normalizedAddress,
		(options as ViniswapTokenHistoryOptions).cacheKey
	);

	const cached = await loadViniswapPairHistoryCache(cachePath);

	let fromBlock = requestedStartBlock;
	let existingEvents: ViniswapPairHistoryCache["events"] = {
		swaps: [],
		mints: [],
		burns: [],
		syncs: [],
		transfers: [],
	};
	let lastSyncedBlock = fromBlock - 1;

	if (cached) {
		fromBlock = Math.min(fromBlock, cached.startBlock);
		existingEvents = cached.events ?? existingEvents;
		lastSyncedBlock = cached.lastSyncedBlock ?? fromBlock - 1;
	}

	const scanFromBlock = Math.max(fromBlock, lastSyncedBlock + 1);
	const scanToBlock = requestedEndBlock;

	const batchDelayMs = options.batchDelayMs ?? 250;
	const maxRetries =
		options.maxRetries !== undefined && options.maxRetries >= 0
			? Math.trunc(options.maxRetries)
			: 5;
	if (!blockscout?.url) {
		throw new Error(
			"Blockscout configuration is required to sync Viniswap history"
		);
	}

	const retryOptions = {
		maxRetries,
		delayMs: batchDelayMs,
	};

	const blockRangeSize = scanToBlock - scanFromBlock + 1;
	const batchSize = blockRangeSize;
	const blockscoutPageSize = options.blockscoutPageSize ?? 100;
	const blockscoutDelayMs = options.blockscoutDelayMs ?? 250;

	const paginationOptions = {
		batchDelayMs,
		maxRetries,
		blockscout: {
			pageSize: blockscoutPageSize,
			delayMs: blockscoutDelayMs,
		},
	};
	const reserveCache = new Map<number, ReserveSnapshot | null>();

	const getReservesSnapshot = async (
		blockNumber: number
	): Promise<ReserveSnapshot | undefined> => {
		if (reserveCache.has(blockNumber)) {
			return reserveCache.get(blockNumber) ?? undefined;
		}

		const tryFetch = async (bn: number): Promise<ReserveSnapshot | null> => {
			try {
				const reservesTuple = await withRetries(
					() => pairContract.getReserves({ blockTag: bn }),
					{
						...retryOptions,
						maxRetries: 3, // Use a smaller number of retries for this specific case
						name: `pair.getReserves:${bn}`,
					}
				);
				const [reserve0Raw, reserve1Raw, blockTimestampRaw] =
					reservesTuple as unknown as [bigint, bigint, bigint];
				return {
					reserve0: formatBigint(reserve0Raw),
					reserve1: formatBigint(reserve1Raw),
					blockTimestampLast: toNumber(blockTimestampRaw),
				};
			} catch (error) {
				// If retries fail, return null to maintain original logic
				return null;
			}
		};

		let snapshot = await tryFetch(blockNumber);
		if (snapshot) {
			reserveCache.set(blockNumber, snapshot);
			return snapshot;
		}

		const MAX_DISTANCE = 20000;
		const STEPS = [
			1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000,
		];
		for (const step of STEPS) {
			const candidates: number[] = [];
			const prev = blockNumber - step;
			const next = blockNumber + step;
			if (prev > 0) candidates.push(prev);
			if (next <= latestBlock) candidates.push(next);

			for (const bn of candidates) {
				if (reserveCache.has(bn)) {
					const cached = reserveCache.get(bn) ?? undefined;
					if (cached) return cached;
					continue;
				}
				snapshot = await tryFetch(bn);
				if (snapshot) {
					reserveCache.set(bn, snapshot);
					return snapshot;
				}
			}

			if (step >= MAX_DISTANCE) break;
		}

		reserveCache.set(blockNumber, null);
		return undefined;
	};

	const getNearestReservesSnapshot = async (
		blockNumber: number
	): Promise<ReserveSnapshot | undefined> => {
		let snapshot = await getReservesSnapshot(blockNumber);
		if (snapshot) return snapshot;

		const BACK_MAX = 40000;
		const FWD_MAX = 10000;
		const STEPS = [
			1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000, 40000,
		];

		for (const step of STEPS) {
			const prev = blockNumber - step;
			if (prev > 0) {
				snapshot = await getReservesSnapshot(prev);
				if (snapshot) return snapshot;
			}
			if (step <= FWD_MAX) {
				const next = blockNumber + step;
				if (next <= latestBlock) {
					snapshot = await getReservesSnapshot(next);
					if (snapshot) return snapshot;
				}
			}
			if (step >= BACK_MAX) break;
		}
		return undefined;
	};

	const [token0Address, token1Address, reserves, totalSupplyRaw] =
		await Promise.all([
			withRetries(() => pairContract.token0(), {
				...retryOptions,
				name: "pair.token0",
			}),
			withRetries(() => pairContract.token1(), {
				...retryOptions,
				name: "pair.token1",
			}),
			withRetries(() => pairContract.getReserves(), {
				...retryOptions,
				name: "pair.getReserves",
			}),
			withRetries(() => pairContract.totalSupply(), {
				...retryOptions,
				name: "pair.totalSupply",
			}),
		]);

	const [token0, token1] = await Promise.all([
		withRetries(() => fetchTokenMetadata(token0Address, provider), {
			...retryOptions,
			name: `fetchTokenMetadata.${token0Address}`,
		}),
		withRetries(() => fetchTokenMetadata(token1Address, provider), {
			...retryOptions,
			name: `fetchTokenMetadata.${token1Address}`,
		}),
	]);

	const currentReservesSnapshot = {
		reserve0: formatBigint(reserves[0]),
		reserve1: formatBigint(reserves[1]),
		blockTimestampLast: toNumber(reserves[2]),
	};

	const currentReservesSummary = {
		...currentReservesSnapshot,
		isoDate: formatIsoDate(currentReservesSnapshot.blockTimestampLast),
		readableDate: formatReadableDate(
			currentReservesSnapshot.blockTimestampLast
		),
	};

	const newSwaps = await paginateBlocks<SwapEvent>(
		normalizedAddress,
		SWAP_TOPIC,
		scanFromBlock,
		scanToBlock,
		batchSize,
		async (log) => {
			const parsed = pairInterface.parseLog(log);
			if (!parsed) {
				throw new Error("Failed to parse Swap log");
			}
			const args = parsed.args as unknown as {
				sender: string;
				amount0In: bigint;
				amount1In: bigint;
				amount0Out: bigint;
				amount1Out: bigint;
				to: string;
			};

			return {
				blockNumber: Number(log.blockNumber),
				transactionHash: log.transactionHash,
				logIndex: Number(log.index ?? 0),
				sender: args.sender,
				to: args.to,
				amount0In: formatBigint(args.amount0In),
				amount1In: formatBigint(args.amount1In),
				amount0Out: formatBigint(args.amount0Out),
				amount1Out: formatBigint(args.amount1Out),
			};
		},
		"swap",
		callbacks,
		paginationOptions,
		{ provider, blockscout },
		getReservesSnapshot
	);

	const newMints = await paginateBlocks<MintEvent>(
		normalizedAddress,
		MINT_TOPIC,
		scanFromBlock,
		scanToBlock,
		batchSize,
		async (log) => {
			const parsed = pairInterface.parseLog(log);
			if (!parsed) {
				throw new Error("Failed to parse Mint log");
			}
			const args = parsed.args as unknown as {
				sender: string;
				amount0: bigint;
				amount1: bigint;
			};

			return {
				blockNumber: Number(log.blockNumber),
				transactionHash: log.transactionHash,
				logIndex: Number(log.index ?? 0),
				sender: args.sender,
				amount0: formatBigint(args.amount0),
				amount1: formatBigint(args.amount1),
			};
		},
		"mint",
		callbacks,
		paginationOptions,
		{ provider, blockscout },
		getReservesSnapshot
	);

	const newBurns = await paginateBlocks<BurnEvent>(
		normalizedAddress,
		BURN_TOPIC,
		scanFromBlock,
		scanToBlock,
		batchSize,
		async (log) => {
			const parsed = pairInterface.parseLog(log);
			if (!parsed) {
				throw new Error("Failed to parse Burn log");
			}
			const args = parsed.args as unknown as {
				sender: string;
				amount0: bigint;
				amount1: bigint;
				to: string;
			};

			return {
				blockNumber: Number(log.blockNumber),
				transactionHash: log.transactionHash,
				logIndex: Number(log.index ?? 0),
				sender: args.sender,
				to: args.to,
				amount0: formatBigint(args.amount0),
				amount1: formatBigint(args.amount1),
			};
		},
		"burn",
		callbacks,
		paginationOptions,
		{ provider, blockscout },
		getReservesSnapshot
	);

	const newTransfers = await paginateBlocks<TransferEvent>(
		normalizedAddress,
		TRANSFER_TOPIC,
		scanFromBlock,
		scanToBlock,
		batchSize,
		async (log) => {
			const parsed = pairInterface.parseLog(log);
			if (!parsed) {
				throw new Error("Failed to parse Transfer log");
			}
			const args = parsed.args as unknown as {
				from: string;
				to: string;
				value: bigint;
			};

			return {
				blockNumber: Number(log.blockNumber),
				transactionHash: log.transactionHash,
				logIndex: Number(log.index ?? 0),
				from: args.from,
				to: args.to,
				value: formatBigint(args.value),
			};
		},
		"transfer",
		callbacks,
		paginationOptions,
		{ provider, blockscout },
		getReservesSnapshot
	);

	const newSyncs = await paginateBlocks<SyncEvent>(
		normalizedAddress,
		SYNC_TOPIC,
		scanFromBlock,
		scanToBlock,
		batchSize,
		async (log) => {
			const parsed = pairInterface.parseLog(log);
			if (!parsed) {
				throw new Error("Failed to parse Sync log");
			}
			const args = parsed.args as unknown as {
				reserve0: bigint;
				reserve1: bigint;
			};

			return {
				blockNumber: Number(log.blockNumber),
				transactionHash: log.transactionHash,
				logIndex: Number(log.index ?? 0),
				reserve0: formatBigint(args.reserve0),
				reserve1: formatBigint(args.reserve1),
			};
		},
		"sync",
		callbacks,
		paginationOptions,
		{ provider, blockscout }
	);

	const allEvents = {
		swaps: [...existingEvents.swaps, ...newSwaps],
		mints: [...existingEvents.mints, ...newMints],
		burns: [...existingEvents.burns, ...newBurns],
		syncs: [...existingEvents.syncs, ...newSyncs],
		transfers: [...existingEvents.transfers, ...newTransfers],
	};

	// Deduplicate and sort
	for (const key of Object.keys(allEvents) as Array<keyof typeof allEvents>) {
		const map = new Map(
			allEvents[key].map((e) => [`${e.blockNumber}-${e.logIndex}`, e])
		);
		allEvents[key] = Array.from(map.values()).sort(
			(a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex
		) as any;
	}

	await Promise.all([
		enrichWithTimestamp(allEvents.swaps, context),
		enrichWithTimestamp(allEvents.mints, context),
		enrichWithTimestamp(allEvents.burns, context),
		enrichWithTimestamp(allEvents.syncs, context),
		enrichWithTimestamp(allEvents.transfers, context),
	]);

	const earliestEventTimestamp = (() => {
		const candidates = [
			allEvents.swaps[0]?.timestamp,
			allEvents.mints[0]?.timestamp,
			allEvents.burns[0]?.timestamp,
			allEvents.syncs[0]?.timestamp,
			allEvents.transfers[0]?.timestamp,
			currentReservesSummary.blockTimestampLast,
		].filter(
			(value): value is number => typeof value === "number" && value > 0
		);

		if (!candidates.length) {
			return currentReservesSummary.blockTimestampLast || latestBlockTimestamp;
		}

		return Math.min(...candidates);
	})();

	const earliestYear = new Date(earliestEventTimestamp * 1000).getUTCFullYear();
	const currentUtcYear = new Date(latestBlockTimestamp * 1000).getUTCFullYear();
	const startYear = Math.max(earliestYear, 1970);

	const reservesByYearEnd: Array<{
		year: number;
		blockNumber: number;
		targetTimestamp: number;
		blockTimestamp: number;
		isoDate?: string;
		readableDate?: string;
		reserves?: ReserveSnapshot;
		isCurrent?: boolean;
	}> = [];

	for (let year = startYear; year <= currentUtcYear; year += 1) {
		const targetTimestamp = Math.floor(
			Date.UTC(year, 11, 31, 23, 59, 59) / 1000
		);

		if (targetTimestamp > latestBlockTimestamp) {
			continue;
		}

		const blockInfo = await findBlockAtOrBeforeTimestamp(
			context,
			targetTimestamp,
			latestBlock
		);

		if (!blockInfo) {
			continue;
		}

		const snapshot = await getNearestReservesSnapshot(blockInfo.blockNumber);

		reservesByYearEnd.push({
			year,
			blockNumber: blockInfo.blockNumber,
			targetTimestamp,
			blockTimestamp: blockInfo.blockTimestamp,
			isoDate: formatIsoDate(blockInfo.blockTimestamp),
			readableDate: formatReadableDate(blockInfo.blockTimestamp),
			reserves: snapshot,
		});
	}

	reservesByYearEnd.push({
		year: currentUtcYear,
		blockNumber: latestBlock,
		targetTimestamp: latestBlockTimestamp,
		blockTimestamp: latestBlockTimestamp,
		isoDate: formatIsoDate(latestBlockTimestamp),
		readableDate: formatReadableDate(latestBlockTimestamp),
		reserves: currentReservesSnapshot,
		isCurrent: true,
	});

	const cacheToSave: ViniswapPairHistoryCache = {
		version: TOKEN_HISTORY_CACHE_VERSION,
		network: networkKey,
		pairAddress: normalizedAddress,
		startBlock: fromBlock,
		lastSyncedBlock: scanToBlock,
		lastSyncedTimestamp: latestBlockTimestamp,
		events: allEvents,
	};

	await saveViniswapPairHistoryCache(cachePath, cacheToSave);

	const latestIsoDate = formatIsoDate(latestBlockTimestamp);
	const latestReadableDate = formatReadableDate(latestBlockTimestamp);

	return {
		pairAddress: normalizedAddress,
		fromBlock,
		toBlock: scanToBlock,
		token0,
		token1,
		currentReserves: currentReservesSnapshot,
		totalSupply: formatBigint(totalSupplyRaw),
		events: {
			swaps: allEvents.swaps,
			mints: allEvents.mints,
			burns: allEvents.burns,
			syncs: allEvents.syncs,
			transfers: allEvents.transfers,
		},
		summary: {
			swapCount: allEvents.swaps.length,
			mintCount: allEvents.mints.length,
			burnCount: allEvents.burns.length,
			syncCount: allEvents.syncs.length,
			transferCount: allEvents.transfers.length,
			currentReserves: currentReservesSummary,
			reservesByYearEnd,

			latestBlock,
			latestBlockTimestamp,
			latestIsoDate,
			latestReadableDate,
		},
	};
};

export const fetchViniswapTokenHistory = async (
	tokenAddress: string,
	options: ViniswapTokenHistoryOptions,
	context: ViniswapHistoryContext,
	verbose = false
): Promise<ViniswapTokenHistoryResult> => {
	if (!tokenAddress) {
		throw new Error("tokenAddress is required");
	}

	if (options.startBlock === undefined || Number.isNaN(options.startBlock)) {
		throw new Error("startBlock is required in options");
	}

	const normalizedAddress = getAddress(tokenAddress);
	const { provider, blockscout } = context;

	if (!blockscout?.url) {
		throw new Error(
			"Blockscout configuration is required to sync token history"
		);
	}

	const startBlock = Math.max(0, Math.trunc(options.startBlock));
	const latestBlock = options.endBlock
		? Math.trunc(options.endBlock)
		: await provider.getBlockNumber();

	if (startBlock > latestBlock) {
		throw new Error("startBlock cannot be greater than endBlock");
	}

	const batchDelayMs =
		options.batchDelayMs !== undefined && options.batchDelayMs >= 0
			? Math.trunc(options.batchDelayMs)
			: 250;
	const maxRetries =
		options.maxRetries !== undefined && options.maxRetries >= 0
			? Math.trunc(options.maxRetries)
			: 5;
	const blockscoutPageSize =
		options.blockscoutPageSize && options.blockscoutPageSize > 0
			? Math.trunc(options.blockscoutPageSize)
			: 100;
	const blockscoutDelayMs =
		options.blockscoutDelayMs !== undefined && options.blockscoutDelayMs >= 0
			? Math.trunc(options.blockscoutDelayMs)
			: 250;

	const networkKey = normalizeNetworkKey(context.networkKey);

	const cachePath = getTokenCachePath(
		networkKey,
		normalizedAddress,
		options.cacheKey
	);

	const cached = await loadTokenHistoryCache(cachePath);

	let cachedStartBlock = startBlock;
	let existingEvents: TokenTransferEvent[] = [];
	let lastSyncedBlock = startBlock - 1;

	if (cached) {
		if (cached.startBlock <= startBlock) {
			cachedStartBlock = cached.startBlock;
			existingEvents = cached.events ?? [];
			lastSyncedBlock =
				cached.lastSyncedBlock !== undefined
					? cached.lastSyncedBlock
					: cachedStartBlock - 1;
		} else {
			cachedStartBlock = startBlock;
			existingEvents = [];
			lastSyncedBlock = startBlock - 1;
		}
	}

	const scanFromBlock = Math.max(cachedStartBlock, lastSyncedBlock + 1);
	const scanToBlock = latestBlock;

	if (verbose) {
		console.log(
			`[ViniswapTokenHistory] Escaneando ${normalizedAddress} desde ${scanFromBlock} hasta ${scanToBlock}`
		);
	}

	let newEvents: TokenTransferEvent[] = [];

	if (scanFromBlock <= scanToBlock) {
		const loggingCallbacks = verbose
			? {
					onProgress: (progress: ViniswapHistoryProgress) => {
						console.log(
							`[ViniswapTokenHistory] TRANSFER ${progress.fromBlock} -> ${progress.toBlock} (${progress.entriesFound} eventos)`
						);
					},
					onEvent: (
						eventType: SyncEventType,
						event: SwapEvent | MintEvent | BurnEvent | SyncEvent | TransferEvent
					) => {
						if (eventType !== "transfer") return;
						const transfer = event as TransferEvent;
						const tsPart =
							transfer.readableDate || transfer.isoDate
								? ` ${transfer.readableDate ?? transfer.isoDate}`
								: "";
						console.log(
							`[ViniswapTokenHistory] TRANSFER block=${transfer.blockNumber} tx=${transfer.transactionHash} from=${transfer.from} -> ${transfer.to} value=${transfer.value}${tsPart}`
						);
					},
			  }
			: undefined;

		const transfers = await fetchTokenTransfersFromBlockscout(
			normalizedAddress,
			{
				startBlock: scanFromBlock,
				endBlock: scanToBlock,
				pageSize: blockscoutPageSize,
				delayMs: blockscoutDelayMs,
				maxRetries,
				onPage: verbose
					? ({ page, items }) => {
							const firstBlock = items[0]?.blockNumber ?? scanFromBlock;
							const lastBlock =
								items[items.length - 1]?.blockNumber ?? firstBlock;
							console.log(
								`[ViniswapTokenHistory] Blockscout página ${page} (${items.length} eventos) bloques ${firstBlock} -> ${lastBlock}`
							);
					  }
					: undefined,
			},
			blockscout
		);

		newEvents = transfers.map((transfer, index) => {
			const timestamp = transfer.timeStamp ?? 0;
			const from = transfer.from
				? normalizeChecksumAddress(transfer.from)
				: transfer.from;
			const to = transfer.to
				? normalizeChecksumAddress(transfer.to)
				: transfer.to;
			return {
				blockNumber: transfer.blockNumber,
				transactionHash: transfer.hash,
				logIndex: transfer.logIndex ?? transfer.transactionIndex ?? index,
				from: from ?? "",
				to: to ?? "",
				value: transfer.value,
				timestamp,
				isoDate: timestamp ? formatIsoDate(timestamp) : undefined,
				readableDate: timestamp ? formatReadableDate(timestamp) : undefined,
				eventCategory: categorizeTransfer(from, to),
			};
		});

		if (verbose) {
			for (const transfer of newEvents) {
				const tsPart =
					transfer.readableDate || transfer.isoDate
						? ` ${transfer.readableDate ?? transfer.isoDate}`
						: "";
				console.log(
					`[ViniswapTokenHistory] ${
						transfer.eventCategory?.toUpperCase?.() ?? "TRANSFER"
					} block=${transfer.blockNumber} tx=${transfer.transactionHash} from=${
						transfer.from
					} -> ${transfer.to} value=${transfer.value}${tsPart}`
				);
			}
		}
	}

	const allEventsMap = new Map<string, TokenTransferEvent>();
	for (const event of [...existingEvents, ...newEvents]) {
		const key = `${event.blockNumber}:${event.logIndex ?? 0}:${
			event.transactionHash
		}`;
		if (!allEventsMap.has(key)) {
			allEventsMap.set(key, {
				...event,
				from: event.from ? normalizeChecksumAddress(event.from) : event.from,
				to: event.to ? normalizeChecksumAddress(event.to) : event.to,
				eventCategory:
					event.eventCategory ?? categorizeTransfer(event.from, event.to),
			});
		}
	}

	const combinedEvents = sortTokenEvents(Array.from(allEventsMap.values()));

	const { holders: aggregatedHolders, summary } = aggregateTokenTransfers(
		combinedEvents,
		cachedStartBlock,
		scanToBlock
	);

	const tokenInfo = await fetchTokenInfoWithRetries(
		normalizedAddress,
		blockscout,
		{ maxRetries, delayMs: blockscoutDelayMs }
	).catch((error) => {
		console.warn(
			`[ViniswapTokenHistory] Failed to fetch token info ${normalizedAddress}`,
			error instanceof Error ? error.message : error
		);
		return undefined;
	});

	let blockscoutHolders: TokenHolderSnapshot[] = [];
	try {
		const holdersFromApi = await fetchTokenHoldersFromBlockscout(
			normalizedAddress,
			{
				pageSize: blockscoutPageSize,
				delayMs: blockscoutDelayMs,
				maxPages:
					options.holderPageLimit !== undefined && options.holderPageLimit > 0
						? Math.trunc(options.holderPageLimit)
						: 50,
				maxRetries,
			},
			blockscout
		);

		blockscoutHolders = holdersFromApi.map((holder) => ({
			address: normalizeChecksumAddress(holder.address),
			balance: holder.value,
			percentage: holder.percentage,
		}));

		blockscoutHolders.sort((a, b) => {
			try {
				const diff = BigInt(b.balance ?? "0") - BigInt(a.balance ?? "0");
				if (diff > BigInt(0)) return 1;
				if (diff < BigInt(0)) return -1;
			} catch {
				// ignore parse errors
			}
			return a.address.localeCompare(b.address);
		});
	} catch (error) {
		console.warn(
			`[ViniswapTokenHistory] Failed to fetch holders ${normalizedAddress}`,
			error instanceof Error ? error.message : error
		);
	}

	const resolvedHolders = blockscoutHolders.length
		? blockscoutHolders
		: aggregatedHolders;

	const tokenContract = new Contract(normalizedAddress, ERC20_ABI, provider);
	const [metadata, totalSupplyRaw] = await Promise.all([
		fetchTokenMetadata(tokenAddress, provider),
		tokenContract.totalSupply().catch(() => undefined),
	]);

	if (metadata.decimals === undefined && tokenInfo?.decimals !== undefined) {
		metadata.decimals = tokenInfo.decimals;
	}
	const decimals = metadata.decimals;

	const mintedTotal = combinedEvents.reduce((acc: bigint, item) => {
		if (item.eventCategory === "mint" && item.value) {
			try {
				return acc + BigInt(item.value);
			} catch {
				return acc;
			}
		}
		return acc;
	}, BigInt(0));

	const summaryWithStats = {
		...summary,
		holderCount:
			tokenInfo?.holdersCount !== undefined
				? tokenInfo.holdersCount
				: resolvedHolders.length,
		transferCount:
			tokenInfo?.totalTransfers !== undefined
				? tokenInfo.totalTransfers
				: combinedEvents.length,
	};

	const resolvedTotalSupply = (() => {
		if (totalSupplyRaw !== undefined) {
			try {
				return BigInt(totalSupplyRaw);
			} catch {
				/* ignore */
			}
		}
		const holderSum = resolvedHolders.reduce((acc, holder) => {
			if (!holder.balance) return acc;
			try {
				const value = BigInt(holder.balance);
				return value > BigInt(0) ? acc + value : acc;
			} catch {
				return acc;
			}
		}, BigInt(0));
		return holderSum;
	})();

	const computedRedeemAmount =
		mintedTotal > resolvedTotalSupply
			? mintedTotal - resolvedTotalSupply
			: BigInt(0);

	if (computedRedeemAmount > BigInt(0)) {
		summaryWithStats.redeemAmount = computedRedeemAmount.toString();
	}

	const result: ViniswapTokenHistoryResult = {
		token: {
			address: normalizedAddress,
			metadata,
			decimals,
			totalSupply: tokenInfo?.totalSupply,
			circulatingSupply: tokenInfo?.circulatingSupply,
			holdersCount: tokenInfo?.holdersCount ?? resolvedHolders.length,
			totalTransfers: tokenInfo?.totalTransfers ?? combinedEvents.length,
			price: tokenInfo?.price,
			marketCap: tokenInfo?.marketCap,
		},
		range: {
			fromBlock: cachedStartBlock,
			toBlock: scanToBlock,
		},
		summary: summaryWithStats,
		holders: resolvedHolders,
		events: combinedEvents,
	};

	if (verbose) {
		console.log(
			`[ViniswapTokenHistory] Completado ${normalizedAddress} bloques ${cachedStartBlock} -> ${scanToBlock} transfers=${summaryWithStats.transferCount} holders=${summaryWithStats.holderCount}`
		);
	}

	const cachePayload: ViniswapTokenHistoryCache = {
		version: TOKEN_HISTORY_CACHE_VERSION,
		network: networkKey,
		tokenAddress: normalizedAddress,
		startBlock: cachedStartBlock,
		lastSyncedBlock: scanToBlock,
		lastSyncedTimestamp: summaryWithStats.lastTimestamp,
		events: combinedEvents,
		holders: resolvedHolders,
		totals: {
			transferCount: summary.transferCount,
			redeemAmount: summaryWithStats.redeemAmount,
			mintCount: summary.mintCount,
			mintAmount: summary.mintAmount,
			totalVolume: summary.totalVolume,
		},
	};

	await saveTokenHistoryCache(cachePath, cachePayload);

	return result;
};

export type {
	SwapEvent as ViniswapSwapEvent,
	MintEvent as ViniswapMintEvent,
	BurnEvent as ViniswapBurnEvent,
	SyncEvent as ViniswapPairSyncEvent,
	TransferEvent as ViniswapTransferEvent,
};
