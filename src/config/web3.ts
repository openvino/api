import { JsonRpcProvider } from "ethers";
import { RPC_URL } from "./envs";

if (!RPC_URL) {
	throw new Error("Missing provider");
}

export const provider = new JsonRpcProvider(RPC_URL);
