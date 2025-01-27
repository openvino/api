import { config } from "dotenv";
config();

export const PORT = process.env.PORT;
export const CLUSTER = process.env.CLUSTER_ENDPOINT;
export const API_KEY = process.env.API_KEY;
