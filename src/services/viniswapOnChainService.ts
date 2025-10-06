import { Contract, Interface, Log, getAddress } from "ethers";
import { provider } from "../config";
import { VINISWAP_PAIR_ABI, ERC20_ABI } from "../abi";
import { fetchLogsFromBlockscout } from "./blockscoutClient";
import {
	TokenMetadata,
	ReserveSnapshot,
	SwapEvent,
	MintEvent,
	BurnEvent,
	SyncEvent,
	TransferEvent,
	SyncEventType,
	ViniswapSyncOptions,
	ViniswapSyncResult,
	ViniswapSyncProgress,
	ViniswapSyncCallbacks,
	BaseEvent,
} from "../interfaces";
import {
	formatBigint,
	formatIsoDate,
	formatReadableDate,
	sleep,
	toNumber,
} from "../utils";

const pairInterface = new Interface(VINISWAP_PAIR_ABI);

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

const fetchTokenMetadata = async (
	tokenAddress: string
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

	return serialized.toLowerCase().includes("too many requests");
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

const paginateBlocks = async <T extends BaseEvent>(
	pairAddress: string,
	topic: string,
	fromBlock: number,
	toBlock: number,
	batchSize: number,
	parser: (log: Log) => Promise<T>,
	eventType: SyncEventType,
	callbacks: ViniswapSyncCallbacks | undefined,
	options: {
		batchDelayMs: number;
		maxRetries: number;
		useBlockscout: boolean;
		blockscout: { pageSize: number; delayMs: number };
	},
	fetchReserves?: (blockNumber: number) => Promise<ReserveSnapshot | undefined>
): Promise<T[]> => {
	const results: T[] = [];

	for (let current = fromBlock; current <= toBlock; current += batchSize) {
		const batchEnd = Math.min(current + batchSize - 1, toBlock);
		let logs: Log[] = [];
		if (options.useBlockscout) {
			logs = await fetchLogsFromBlockscout({
				address: pairAddress,
				topic0: topic,
				fromBlock: current,
				toBlock: batchEnd,
				pageSize: options.blockscout.pageSize,
				delayMs: options.blockscout.delayMs,
			});
		} else {
			let attempt = 0;
			while (true) {
				try {
					logs = await provider.getLogs({
						address: pairAddress,
						topics: [topic],
						fromBlock: current,
						toBlock: batchEnd,
					});
					break;
				} catch (error) {
					attempt += 1;

					if (!shouldRetryRequest(error) || attempt > options.maxRetries) {
						throw error;
					}

					const backoff = options.batchDelayMs * attempt;
					console.warn(
						`[ViniswapPairSync] retrying ${eventType} ${current} -> ${batchEnd} (attempt ${attempt}/${options.maxRetries}) in ${backoff}ms`
					);
					await sleep(backoff);
				}
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
			callbacks.onProgress({
				eventType,
				fromBlock: current,
				toBlock: batchEnd,
				entriesFound: logs.length,
			});
		}

		if (options.batchDelayMs > 0 && batchEnd < toBlock) {
			await sleep(options.batchDelayMs);
		}
	}

	return results;
};

const enrichWithTimestamp = async <T extends BaseEvent>(
	events: T[]
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

	await Promise.all(
		uniqueBlocks.map(async (blockNumber) => {
			const block = await provider.getBlock(blockNumber);
			timestampCache.set(blockNumber, block ? Number(block.timestamp) : 0);
		})
	);

	eventsNeedingTimestamp.forEach((event) => {
		const ts = timestampCache.get(event.blockNumber) ?? 0;
		event.timestamp = ts;
		event.isoDate = ts ? formatIsoDate(ts) : undefined;
		event.readableDate = ts ? formatReadableDate(ts) : undefined;
	});
};

export const syncViniswapPairHistory = async (
	pairAddress: string,
	options: ViniswapSyncOptions,
	callbacks: ViniswapSyncCallbacks = {}
): Promise<ViniswapSyncResult> => {
	if (!pairAddress) {
		throw new Error("pairAddress is required");
	}

	if (options.startBlock === undefined || Number.isNaN(options.startBlock)) {
		throw new Error("startBlock is required in options");
	}

	const normalizedAddress = getAddress(pairAddress);

	const pairContract = new Contract(
		normalizedAddress,
		VINISWAP_PAIR_ABI,
		provider
	);

	const latestBlock = await provider.getBlockNumber();

	const fromBlock = Math.max(0, Math.trunc(options.startBlock));
	const toBlock = options.endBlock ? Math.trunc(options.endBlock) : latestBlock;

	if (fromBlock > toBlock) {
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
	const useBlockscout = options.useBlockscout ?? true;
	const blockRangeSize = toBlock - fromBlock + 1;
	const batchSize = useBlockscout
		? blockRangeSize
		: options.batchSize && options.batchSize > 0
		? Math.trunc(options.batchSize)
		: 5_000;
	const blockscoutPageSize =
		options.blockscoutPageSize && options.blockscoutPageSize > 0
			? Math.trunc(options.blockscoutPageSize)
			: 100;
	const blockscoutDelayMs =
		options.blockscoutDelayMs !== undefined && options.blockscoutDelayMs >= 0
			? Math.trunc(options.blockscoutDelayMs)
			: 250;

	const paginationOptions = {
		batchDelayMs,
		maxRetries,
		useBlockscout,
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

		try {
			const reservesTuple = await pairContract.getReserves({
				blockTag: blockNumber,
			});

			const [reserve0Raw, reserve1Raw, blockTimestampRaw] =
				reservesTuple as unknown as [bigint, bigint, bigint];

			const snapshot = formatReservesSnapshot(
				reserve0Raw,
				reserve1Raw,
				blockTimestampRaw
			);

			reserveCache.set(blockNumber, snapshot);
			return snapshot;
		} catch (error) {
			console.warn(
				`[ViniswapPairSync] Failed to fetch reserves at block ${blockNumber}`,
				error instanceof Error ? error.message : error
			);
			reserveCache.set(blockNumber, null);
			return undefined;
		}
	};

	const [token0Address, token1Address, reserves, totalSupplyRaw] =
		await Promise.all([
			pairContract.token0(),
			pairContract.token1(),
			pairContract.getReserves(),
			pairContract.totalSupply(),
		]);

	const [token0, token1] = await Promise.all([
		fetchTokenMetadata(token0Address),
		fetchTokenMetadata(token1Address),
	]);

	const swaps = await paginateBlocks<SwapEvent>(
		normalizedAddress,
		SWAP_TOPIC,
		fromBlock,
		toBlock,
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
		getReservesSnapshot
	);

	const mints = await paginateBlocks<MintEvent>(
		normalizedAddress,
		MINT_TOPIC,
		fromBlock,
		toBlock,
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
		getReservesSnapshot
	);

	const burns = await paginateBlocks<BurnEvent>(
		normalizedAddress,
		BURN_TOPIC,
		fromBlock,
		toBlock,
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
		getReservesSnapshot
	);

	const transfers = await paginateBlocks<TransferEvent>(
		normalizedAddress,
		TRANSFER_TOPIC,
		fromBlock,
		toBlock,
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
		getReservesSnapshot
	);

	const syncs = await paginateBlocks<SyncEvent>(
		normalizedAddress,
		SYNC_TOPIC,
		fromBlock,
		toBlock,
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
		paginationOptions
	);

	await Promise.all([
		enrichWithTimestamp(swaps),
		enrichWithTimestamp(mints),
		enrichWithTimestamp(burns),
		enrichWithTimestamp(syncs),
		enrichWithTimestamp(transfers),
	]);

	return {
		pairAddress: normalizedAddress,
		fromBlock,
		toBlock,
		token0,
		token1,
		currentReserves: {
			reserve0: formatBigint(reserves[0]),
			reserve1: formatBigint(reserves[1]),
			blockTimestampLast: toNumber(reserves[2]),
		},
		totalSupply: formatBigint(totalSupplyRaw),
		events: {
			swaps,
			mints,
			burns,
			syncs,
			transfers,
		},
		summary: {
			swapCount: swaps.length,
			mintCount: mints.length,
			burnCount: burns.length,
			syncCount: syncs.length,
			transferCount: transfers.length,
		},
	};
};

export type {
	SwapEvent as ViniswapSwapEvent,
	MintEvent as ViniswapMintEvent,
	BurnEvent as ViniswapBurnEvent,
	SyncEvent as ViniswapSyncEvent,
	TransferEvent as ViniswapTransferEvent,
};
