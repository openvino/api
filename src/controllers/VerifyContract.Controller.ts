import { Request, Response } from "express";
import axios from "axios";
import qs from "qs";

export const verifyContract = async (
	req: Request,
	res: Response
): Promise<void> => {
	console.log("verifyContract");

	try {
		const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
		const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY;
		if (!ETHERSCAN_API_KEY || !BASESCAN_API_KEY) {
			res
				.status(500)
				.json({ error: "Missing ETHERSCAN_API_KEY or BASESCAN_API_KEY" });
			return;
		}

		const {
			network = "sepolia",
			address,
			contractName,
			sourceCode,
			compilerVersion,
			constructorArgs = "",
			optimizationUsed = "1",
			runs = "200",
		} = req.body as {
			network?: string;
			address: string;
			contractName: string;
			sourceCode: string;
			compilerVersion: string;
			constructorArgs?: string;
			optimizationUsed?: "0" | "1";
			runs?: string;
		};

		if (!address || !contractName || !sourceCode || !compilerVersion) {
			res.status(400).json({
				error:
					"Missing fields: address, contractName, sourceCode or compilerVersion",
			});
			return;
		}

		let apiBase: string;
		let apiKey: string;
		console.log(network);
		switch (network) {
			case "mainnet":
				apiBase = "https://api.etherscan.io/api";
				apiKey = ETHERSCAN_API_KEY;
				break;

			case "sepolia":
				apiBase = "https://api-sepolia.etherscan.io/api";
				apiKey = ETHERSCAN_API_KEY;
				break;
			case "base":
				apiBase = "https://api.basescan.org/api";
				apiKey = BASESCAN_API_KEY;
				break;
			case "baseSepolia":
				apiBase = "https://api-sepolia.basescan.org/api";
				apiKey = BASESCAN_API_KEY;
				break;
			default:
				res.status(400).json({
					error: `Unknown network: "${network}". Supported networks: mainnet/sepolia/base mainnet/sepolia/base/base-sepolia.`,
				});
				return;
		}
		console.log("verivying in network", network, "endpoint:", apiBase);

		const postData = {
			apikey: apiKey,
			module: "contract",
			action: "verifysourcecode",
			contractaddress: address,
			sourceCode: sourceCode,
			codeformat: "solidity-standard-json-input",
			contractname: contractName,
			compilerversion: compilerVersion,
			optimizationUsed,
			runs,
			constructorArguments: constructorArgs,
		};

		const response = await axios.post(apiBase, qs.stringify(postData), {
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
		});

		const data = response.data as {
			status: string;
			message: string;
			result: string;
		};

		if (data.status === "1") {
			res.json({
				status: data.status,
				message: data.message,
				guid: data.result,
			});
		} else {
			res.status(400).json({
				status: data.status,
				message: data.message,
				result: data.result,
			});
		}
	} catch (err: any) {
		console.error("Error verifying Contract", err);
		res.status(500).json({ error: err.message || err.toString() });
	}
};
