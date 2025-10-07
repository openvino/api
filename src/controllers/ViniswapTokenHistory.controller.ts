import { Request, Response } from "express";
import { formatUnits } from "ethers";
import {
	getBlockscoutConfigForNetwork,
	getProviderForNetwork,
	normalizeNetworkKey,
} from "../config";
import { fetchViniswapTokenHistory } from "../services/viniswapOnChainService";
import { ViniswapTokenHistoryOptions } from "../interfaces";

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

const formatAmount = (
	value: string | null | undefined,
	decimals: number
): string | null => {
	if (value === undefined || value === null) {
		return null;
	}
	try {
		return formatUnits(BigInt(value), decimals);
	} catch {
		return null;
	}
};

export const getViniswapTokenHistoryController = async (
	req: Request,
	res: Response
): Promise<void> => {
	try {
		const { tokenAddress } = req.params;
		if (!tokenAddress) {
			res.status(400).json({ message: "tokenAddress parameter is required" });
			return;
		}

		const {
			startBlock,
			endBlock,
			batchDelayMs,
			maxRetries,
			blockscoutPageSize,
			blockscoutDelayMs,
			cacheKey,
			network: rawNetwork,
			verbose,
			holderPageLimit,
		} = req.body ?? {};

		let options: ViniswapTokenHistoryOptions;

		try {
			options = {
				startBlock: parseRequiredNumber(startBlock, "startBlock"),
				endBlock: parseOptionalNumber(endBlock),
				batchDelayMs: parseOptionalNumber(batchDelayMs),
				maxRetries: parseOptionalNumber(maxRetries),
				blockscoutPageSize: parseOptionalNumber(blockscoutPageSize),
				blockscoutDelayMs: parseOptionalNumber(blockscoutDelayMs),
				cacheKey:
					typeof cacheKey === "string" && cacheKey.trim() ? cacheKey : undefined,
				holderPageLimit: parseOptionalNumber(holderPageLimit),
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

		const network =
			typeof rawNetwork === "string" && rawNetwork.trim()
				? rawNetwork.trim()
				: undefined;
		const networkKey = normalizeNetworkKey(network);

		let provider;
		try {
			provider = getProviderForNetwork(network);
		} catch (providerError) {
			res.status(400).json({
				message:
					providerError instanceof Error
						? providerError.message
						: "Invalid network configuration",
			});
			return;
		}

		const blockscoutConfig = getBlockscoutConfigForNetwork(network);
		if (!blockscoutConfig.url) {
			res.status(500).json({
				message: `Blockscout API URL not configured for network "${network ?? "default"}"`,
			});
			return;
		}

		const isVerbose = parseBoolean(verbose);

		const result = await fetchViniswapTokenHistory(
			tokenAddress,
			options,
			{
				provider,
				blockscout: blockscoutConfig,
				networkKey,
			},
			isVerbose
		);

		const decimals =
			result.token.metadata.decimals ?? result.token.decimals ?? 18;

		const formattedHolders = result.holders.map((holder) => ({
			...holder,
			formattedBalance: formatAmount(holder.balance, decimals),
		}));

		const formattedSummary = {
			...result.summary,
			redeemAmountFormatted: formatAmount(result.summary.redeemAmount, decimals),
			mintAmountFormatted: formatAmount(result.summary.mintAmount, decimals),
			totalVolumeFormatted: formatAmount(result.summary.totalVolume, decimals),
		};

		const formattedEvents = result.events.map((event) => ({
			...event,
			valueFormatted: formatAmount(event.value, decimals),
		}));

		res.status(200).json({
			token: {
				address: result.token.address,
				symbol: result.token.metadata.symbol ?? null,
				name: result.token.metadata.name ?? null,
				decimals,
				totalSupply: result.token.totalSupply ?? null,
				totalSupplyFormatted: formatAmount(result.token.totalSupply, decimals),
				circulatingSupply: result.token.circulatingSupply ?? null,
				circulatingSupplyFormatted: formatAmount(
					result.token.circulatingSupply,
					decimals
				),
				holdersCount: result.token.holdersCount ?? null,
				totalTransfers: result.token.totalTransfers ?? result.summary.transferCount,
				price: result.token.price ?? null,
				marketCap: result.token.marketCap ?? null,
			},
			network: network ?? "default",
			range: result.range,
			summary: formattedSummary,
			holders: formattedHolders,
			events: formattedEvents,
		});
	} catch (error) {
		console.error("Failed to sync Viniswap token history", error);
		res.status(500).json({
			message: "Failed to sync Viniswap token history",
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}
};
