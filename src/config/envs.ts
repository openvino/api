import { config } from "dotenv";
config();

export const PORT = process.env.PORT;
export const CLUSTER = process.env.CLUSTER_ENDPOINT;
export const API_KEY = process.env.API_KEY;

export const RPC_URL_BASE = process.env.RPC_URL_BASE ?? process.env.RPC_URL;
export const RPC_URL_MAINNET =
	process.env.RPC_URL_MAINNET ?? process.env.RPC_URL_ETHEREUM;
export const RPC_URL_OPTIMISM = process.env.RPC_URL_OPTIMISM;

export const BLOCKSCOUT_API_URL_BASE =
	process.env.BLOCKSCOUT_API_URL_BASE ?? process.env.BLOCKSCOUT_API_URL;
export const BLOCKSCOUT_API_URL_MAINNET =
	process.env.BLOCKSCOUT_API_URL_MAINNET;
export const BLOCKSCOUT_API_URL_OPTIMISM =
	process.env.BLOCKSCOUT_API_URL_OPTIMISM;

export const BLOCKSCOUT_API_KEY =
	process.env.BLOCKSCOUT_API_KEY ??
	process.env.BLOCKSCOUT_API_KEY_BASE ??
	process.env.BLOCKSCOUT_API_KEY_MAINNET ??
	process.env.BLOCKSCOUT_API_KEY_OPTIMISM;

console.log(PORT, CLUSTER, API_KEY, RPC_URL_BASE);
