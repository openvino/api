import { config } from "dotenv";
config();

export const PORT = process.env.PORT;
export const CLUSTER = process.env.CLUSTER_ENDPOINT;
export const API_KEY = process.env.API_KEY;
export const RPC_URL = process.env.RPC_URL;
export const BLOCKSCOUT_API_URL = process.env.BLOCKSCOUT_API_URL;
export const BLOCKSCOUT_API_KEY = process.env.BLOCKSCOUT_API_KEY;
console.log(PORT, CLUSTER, API_KEY, RPC_URL);
