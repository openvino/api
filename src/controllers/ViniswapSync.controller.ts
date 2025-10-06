import { Request, Response } from "express";
import { syncViniswapPairHistory } from "../services/viniswapOnChainService";
import {
	ViniswapSyncOptions,
	ViniswapSyncProgress,
	ViniswapSwapEvent,
	ViniswapMintEvent,
	ViniswapBurnEvent,
	ViniswapSyncEvent,
	ViniswapTransferEvent,
} from "../interfaces";

const parseOptionalNumber = (value: unknown): number | undefined => {
	if (value === undefined || value === null || value === "") {
		return undefined;
	}

	const numericValue = Number(value);

	return Number.isFinite(numericValue) ? numericValue : undefined;
};

const parseRequiredNumber = (value: unknown, field: string): number => {
	const parsed = parseOptionalNumber(value);

	if (parsed === undefined) {
		throw new Error(`${field} must be a valid number`);
	}

	return parsed;
};

const parseBoolean = (value: unknown): boolean => {
	if (typeof value === "boolean") {
		return value;
	}

	if (typeof value === "number") {
		return value !== 0;
	}

	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["true", "1", "yes", "y"].includes(normalized)) {
			return true;
		}
		if (["false", "0", "no", "n"].includes(normalized)) {
			return false;
		}
	}

	return false;
};

const parseOptionalBoolean = (value: unknown): boolean | undefined => {
	if (value === undefined || value === null || value === "") {
		return undefined;
	}
	return parseBoolean(value);
};

export const syncViniswapPairController = async (
	req: Request,
	res: Response
): Promise<void> => {
	try {
		const { pairAddress } = req.params;

		if (!pairAddress) {
			res.status(400).json({ message: "pairAddress parameter is required" });
			return;
		}

		const {
			startBlock,
			endBlock,
			batchSize,
			verbose,
			batchDelayMs,
			maxRetries,
			useBlockscout,
			blockscoutPageSize,
			blockscoutDelayMs,
		} = req.body ?? {};

		let options: ViniswapSyncOptions;

		try {
				options = {
					startBlock: parseRequiredNumber(startBlock, "startBlock"),
					endBlock: parseOptionalNumber(endBlock),
					batchSize: parseOptionalNumber(batchSize),
					batchDelayMs: parseOptionalNumber(batchDelayMs),
					maxRetries: parseOptionalNumber(maxRetries),
					useBlockscout: parseOptionalBoolean(useBlockscout),
					blockscoutPageSize: parseOptionalNumber(blockscoutPageSize),
					blockscoutDelayMs: parseOptionalNumber(blockscoutDelayMs),
				};
		} catch (validationError) {
			res.status(400).json({
				message:
					validationError instanceof Error
						? validationError.message
						: "Invalid numeric parameter",
			});
			return;
		}

		const isVerbose = parseBoolean(verbose);

		let lastProgressMessage = "";
		const updateProgressLine = (message: string): void => {
			process.stdout.write(`\r${message}`);
			lastProgressMessage = message;
		};

		const clearProgressLine = (): void => {
			if (!lastProgressMessage) return;
			process.stdout.write(`\r${" ".repeat(lastProgressMessage.length)}\r`);
			lastProgressMessage = "";
		};

		const logProgress = (progress: ViniswapSyncProgress): void => {
			const message = `[ViniswapPairSync] ${progress.eventType.toUpperCase()} ${progress.fromBlock} -> ${progress.toBlock} (${progress.entriesFound} eventos)`;
			updateProgressLine(message);
		};

		const logReserves = (
			label: string,
			reserves?: { reserve0: string; reserve1: string; blockTimestampLast?: number }
		): void => {
			if (!reserves) {
				console.log(`${label}: reservas no disponibles`);
				return;
			}
			console.log(
				`${label}: reserve0=${reserves.reserve0} reserve1=${reserves.reserve1}` +
					(reserves.blockTimestampLast !== undefined
						? ` ts=${reserves.blockTimestampLast}`
						: "")
			);
		};

		const emitTimestamp = (
			event: { timestamp?: number; isoDate?: string; readableDate?: string }
		): string => {
			if (!event.isoDate && !event.timestamp && !event.readableDate) {
				return "";
			}
			const parts: string[] = [];
			if (event.readableDate) {
				parts.push(event.readableDate);
			}
			if (event.isoDate) {
				parts.push(event.isoDate);
			}
			if (event.timestamp) {
				parts.push(`ts=${event.timestamp}`);
			}
			return parts.length ? ` | ${parts.join(" ")}` : "";
		};

		const logEvent = (
			eventType: "swap" | "mint" | "burn" | "sync" | "transfer",
			event:
				| ViniswapSwapEvent
				| ViniswapMintEvent
				| ViniswapBurnEvent
				| ViniswapSyncEvent
				| ViniswapTransferEvent
		): void => {
			clearProgressLine();
			switch (eventType) {
				case "swap": {
					const swap = event as ViniswapSwapEvent;
					console.log(
						`[ViniswapPairSync] SWAP block=${swap.blockNumber} tx=${swap.transactionHash} sender=${swap.sender} -> ${swap.to}${emitTimestamp(swap)}`
					);
					console.log(
						`  amounts: in0=${swap.amount0In} in1=${swap.amount1In} out0=${swap.amount0Out} out1=${swap.amount1Out}`
					);
					logReserves("  reservas después", swap.reservesAfter);
					break;
				}
				case "mint": {
					const mint = event as ViniswapMintEvent;
					console.log(
						`[ViniswapPairSync] MINT block=${mint.blockNumber} tx=${mint.transactionHash} sender=${mint.sender}${emitTimestamp(mint)}`
					);
					console.log(
						`  liquidity: amount0=${mint.amount0} amount1=${mint.amount1}`
					);
					logReserves("  reservas después", mint.reservesAfter);
					break;
				}
				case "burn": {
					const burn = event as ViniswapBurnEvent;
					console.log(
						`[ViniswapPairSync] BURN block=${burn.blockNumber} tx=${burn.transactionHash} sender=${burn.sender} -> ${burn.to}${emitTimestamp(burn)}`
					);
					console.log(
						`  liquidity: amount0=${burn.amount0} amount1=${burn.amount1}`
					);
					logReserves("  reservas después", burn.reservesAfter);
					break;
				}
				case "sync": {
					const syncEvent = event as ViniswapSyncEvent;
					console.log(
						`[ViniswapPairSync] SYNC block=${syncEvent.blockNumber} tx=${syncEvent.transactionHash}${emitTimestamp(syncEvent)}`
					);
					logReserves("  reservas sincronizadas", {
						reserve0: syncEvent.reserve0,
						reserve1: syncEvent.reserve1,
						blockTimestampLast: syncEvent.timestamp,
					});
					break;
				}
				case "transfer": {
					const transfer = event as ViniswapTransferEvent;
					console.log(
						`[ViniswapPairSync] TRANSFER block=${transfer.blockNumber} tx=${transfer.transactionHash} from=${transfer.from} -> ${transfer.to}${emitTimestamp(transfer)}`
					);
					console.log(`  value=${transfer.value}`);
					logReserves("  reservas después", transfer.reservesAfter);
					break;
				}
			}
		};

		const result = await syncViniswapPairHistory(pairAddress, options, {
			onProgress: isVerbose ? logProgress : undefined,
			onEvent: isVerbose ? logEvent : undefined,
		});

		if (isVerbose) {
			clearProgressLine();
		}

		console.log(
			`[ViniswapPairSync] Completed ${pairAddress} blocks ${result.fromBlock} -> ${result.toBlock}`
		);
		if (isVerbose) {
			console.log(
				`[ViniswapPairSync] Resumen eventos: swaps=${result.events.swaps.length} mints=${result.events.mints.length} burns=${result.events.burns.length} syncs=${result.events.syncs.length} transfers=${result.events.transfers.length}`
			);
		}

		const buildTokenReserves = (
			reserves?: { reserve0?: string | null; reserve1?: string | null }
		) => ({
			token0: {
				...result.token0,
				reserveKey: "reserve0" as const,
				amount: reserves?.reserve0 ?? null,
			},
			token1: {
				...result.token1,
				reserveKey: "reserve1" as const,
				amount: reserves?.reserve1 ?? null,
			},
		});

		const enrich = <T>(
			events: T[],
			extractReserves: (event: T) => { reserve0?: string | null; reserve1?: string | null }
		): Array<T & { tokenReserves: ReturnType<typeof buildTokenReserves> }> =>
			events.map((event) => ({
				...event,
				tokenReserves: buildTokenReserves(extractReserves(event)),
			}));

		const enrichedEvents = {
			swaps: enrich(result.events.swaps, (event) => event.reservesAfter ?? {}),
			mints: enrich(result.events.mints, (event) => event.reservesAfter ?? {}),
			burns: enrich(result.events.burns, (event) => event.reservesAfter ?? {}),
			syncs: enrich(result.events.syncs, (event) => ({ reserve0: event.reserve0, reserve1: event.reserve1 })),
			transfers: enrich(result.events.transfers, (event) => event.reservesAfter ?? {}),
		};

		res.status(200).json({
			pair: {
				address: result.pairAddress,
				token0: {
					...result.token0,
					reserveLabel: "reserve0",
				},
				token1: {
					...result.token1,
					reserveLabel: "reserve1",
				},
				reserveMapping: {
					reserve0: {
						token: result.token0,
						description: "Liquidity reserve for token0",
					},
					reserve1: {
						token: result.token1,
						description: "Liquidity reserve for token1",
					},
				},
				currentReserves: result.currentReserves,
				totalSupply: result.totalSupply,
			},
			range: {
				fromBlock: result.fromBlock,
				toBlock: result.toBlock,
			},
			summary: result.summary,
			events: enrichedEvents,
		});
	} catch (error) {
		console.error("Failed to sync Viniswap pair history", error);

		res.status(500).json({
			message: "Failed to sync Viniswap pair history",
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}
};
