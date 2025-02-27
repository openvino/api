import axios, { AxiosResponse } from "axios";
import { appendFileSync, renameSync } from "node:fs";
import FormData from "form-data";
import { CLUSTER } from "../config";
import fs from "fs";
import { IClusterFile, IpfsClusterCidStatusResponse } from "../interfaces";
import { v4 as uuidv4 } from 'uuid'

export const uploadFileToIpfs = async (
	data: Express.Multer.File | string, // Acepta tanto archivos como strings (JSON)

): Promise<IClusterFile> => {
	let newPath: string | undefined; // Declarar newPath aquí

	try {
		const formData = new FormData();
		const uniqueName = `${uuidv4()}-${(data as Express.Multer.File).originalname}`;
		newPath = `uploads/${uniqueName}`; // Asignar newPath aquí
		renameSync((data as Express.Multer.File).path, newPath);
		formData.append("file", fs.createReadStream(newPath));

		const headers = {
			...formData.getHeaders(),
		};

		const response = await axios.post(`${CLUSTER}/add`, formData, { headers });
		const logData = createLogEntry(response.data);
		writeLogToFile(logData);


		deleteCache(newPath)
			.then(() => console.log("OK"))
			.catch((error) => console.error("Error cleaning cache:", error));


		return response.data;
	} catch (error: any) {
		console.error("Error uploading to IPFS:", error);
		clusterFile.error = error.message;
		return clusterFile;
	}
};


export const uploadJsonToIpfs = async (jsonData: string): Promise<IClusterFile> => {
    try {
        const formData = new FormData();
        const buffer = Buffer.from(jsonData, "utf-8"); // Convertimos el JSON a buffer

        formData.append("file", buffer, { filename: "data.json", contentType: "application/json" });

        const response = await axios.post(`${CLUSTER}/add`, formData, {
            headers: {
                ...formData.getHeaders(), // Asegurar que axios envíe los headers correctos para `multipart/form-data`
            },
        });

        return response.data;
    } catch (error: any) {
        console.error(" Error uploading JSON to IPFS:", error);
        return { error: error.message } as IClusterFile;
    }
};


export const pinnedFiles = async (): Promise<string> => {
	try {
		const response: AxiosResponse = await axios.get(`${CLUSTER}/pins`);

		return response.data;
	} catch (error: any) {
		return error.message;
	}
};
export const pinStatus = async (
	cid: string
): Promise<IpfsClusterCidStatusResponse> => {
	try {
		const response: AxiosResponse = await axios.get(`${CLUSTER}/pins/${cid}`);

		return response.data;
	} catch (error: any) {
		return error.message;
	}
};

const renameImage = (file: Express.Multer.File): string => {
	const newPath = `uploads/${file.originalname}`;
	renameSync(file.path, newPath);
	return newPath;
};

const deleteCache = (path: string): Promise<void> => {
	return new Promise((resolve, reject) => {
		fs.unlink(path, (err) => {
			if (err) {
				console.error(`Error cleaning ${path}:`, err);
				return reject(err);
			}

			resolve();
		});
	});
};

const clusterFile: IClusterFile = {
	cid: "",
	name: "",
	size: 0,
	allocations: [],
	error: "",
};

const createLogEntry = (data: IClusterFile, isError = false): string => {
	const timestamp = new Date().toISOString();
	if (isError) {
		return `[${timestamp}] ERROR: ${data.error}\n`;
	}
	return `[${timestamp}] CID: ${data.cid}, Name: ${data.name}, Size: ${data.size
		}, Allocations: ${JSON.stringify(data.allocations)}\n`;
};

const writeLogToFile = (logEntry: string): void => {
	const logFilePath = "uploads/logs.txt";
	try {
		appendFileSync(logFilePath, logEntry, { encoding: "utf8" });
		console.log("Log entry saved.");
	} catch (error) {
		console.error("Error writing to log file:", error);
	}
};
