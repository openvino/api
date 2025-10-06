import axios from "axios";
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
	result: BlockscoutLogEntry[] | string;
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
