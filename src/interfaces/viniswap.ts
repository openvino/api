export interface TokenMetadata {
	address: string;
	symbol?: string;
	name?: string;
	decimals?: number;
}

export interface BaseEvent {
	blockNumber: number;
	transactionHash: string;
	logIndex: number;
	timestamp?: number;
	isoDate?: string;
	readableDate?: string;
}

export interface ReserveSnapshot {
	reserve0: string;
	reserve1: string;
	blockTimestampLast: number;
}

export interface SwapEvent extends BaseEvent {
	sender: string;
	to: string;
	amount0In: string;
	amount1In: string;
	amount0Out: string;
	amount1Out: string;
	reservesAfter?: ReserveSnapshot;
}

export interface MintEvent extends BaseEvent {
	sender: string;
	amount0: string;
	amount1: string;
	reservesAfter?: ReserveSnapshot;
}

export interface BurnEvent extends BaseEvent {
	sender: string;
	to: string;
	amount0: string;
	amount1: string;
	reservesAfter?: ReserveSnapshot;
}

export interface SyncEvent extends BaseEvent {
	reserve0: string;
	reserve1: string;
}

export interface TransferEvent extends BaseEvent {
	from: string;
	to: string;
	value: string;
	reservesAfter?: ReserveSnapshot;
}

export type SyncEventType = "swap" | "mint" | "burn" | "sync" | "transfer";

export type TokenTransferEvent = TransferEvent & {
	eventCategory?: "mint" | "redeem" | "transfer";
};

export interface TokenHolderSnapshot {
	address: string;
	balance: string;
	percentage?: number;
}

export interface ViniswapTokenHistoryOptions extends ViniswapHistoryOptions {
	cacheKey?: string;
	holderPageLimit?: number;
	blockBatchSize?: number;
}

export interface ViniswapTokenHistoryCache {
	version: number;
	network: string;
	tokenAddress: string;
	startBlock: number;
	lastSyncedBlock: number;
	lastSyncedTimestamp?: number;
	events: TokenTransferEvent[];
	holders: TokenHolderSnapshot[];
	totals: {
		transferCount: number;
		redeemAmount: string;
		mintCount: number;
		mintAmount: string;
		totalVolume: string;
	};
}

export interface ViniswapTokenHistoryResult {
	token: {
		address: string;
		metadata: TokenMetadata;
		decimals?: number;
		totalSupply?: string;
		circulatingSupply?: string;
		holdersCount?: number;
		totalTransfers?: number;
		price?: {
			rate?: number;
			currency?: string;
			usd?: number;
		};
		marketCap?: number;
	};
	range: {
		fromBlock: number;
		toBlock: number;
	};
	summary: {
		firstBlock: number;
		firstTimestamp?: number;
		firstIsoDate?: string;
		lastBlock: number;
		lastTimestamp?: number;
		lastIsoDate?: string;
		holderCount: number;
		uniqueAddresses: number;
		transferCount: number;
		redeemAmount: string;
		mintCount: number;
		mintAmount: string;
		totalVolume: string;
	};
	holders: Array<
		TokenHolderSnapshot & {
			formattedBalance?: string | null;
		}
	>;
	events: TokenTransferEvent[];
}

export interface ViniswapHistoryOptions {
	startBlock: number;
	endBlock?: number;
	batchDelayMs?: number;
	maxRetries?: number;
	blockscoutPageSize?: number;
	blockscoutDelayMs?: number;
}

export interface ViniswapHistoryResult {
	pairAddress: string;
	fromBlock: number;
	toBlock: number;
	token0: TokenMetadata;
	token1: TokenMetadata;
	currentReserves: {
		reserve0: string;
		reserve1: string;
		blockTimestampLast: number;
	};
	totalSupply: string;
	events: {
		swaps: SwapEvent[];
		mints: MintEvent[];
		burns: BurnEvent[];
		syncs: SyncEvent[];
		transfers: TransferEvent[];
	};
	summary: {
		swapCount: number;
		mintCount: number;
		burnCount: number;
		syncCount: number;
		transferCount: number;
		currentReserves: {
			reserve0: string;
			reserve1: string;
			blockTimestampLast: number;
			isoDate?: string;
			readableDate?: string;
		};
		reservesByYearEnd: Array<{
			year: number;
			blockNumber: number;
			targetTimestamp: number;
			blockTimestamp: number;
			isoDate?: string;
			readableDate?: string;
			reserves?: ReserveSnapshot;
			isCurrent?: boolean;
		}>;
		latestBlock?: number;
		latestBlockTimestamp?: number;
		latestIsoDate?: string;
		latestReadableDate?: string;
	};
}

export interface ViniswapHistoryProgress {
	eventType: SyncEventType;
	fromBlock: number;
	toBlock: number;
	entriesFound: number;
}

export interface ViniswapHistoryCallbacks {
	onProgress?: (progress: ViniswapHistoryProgress) => void;
	onEvent?: (
		eventType: SyncEventType,
		event: SwapEvent | MintEvent | BurnEvent | SyncEvent | TransferEvent
	) => void;
}

export type ViniswapSwapEvent = SwapEvent;
export type ViniswapMintEvent = MintEvent;
export type ViniswapBurnEvent = BurnEvent;
export type ViniswapPairSyncEvent = SyncEvent;
export type ViniswapTransferEvent = TransferEvent;
