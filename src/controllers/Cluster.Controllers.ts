import { Request, Response } from "express";
import { pinnedFiles, pinStatus, uploadFileToIpfs, uploadJsonToIpfs } from "../services";
import { IClusterFile, IpfsClusterCidStatusResponse } from "../interfaces";
import fs from "fs";
export const addFile = async (req: Request, res: Response): Promise<void> => {
	try {
		if (!req.file) {
			throw new Error("No file uploaded");
		}

		const data: IClusterFile = await uploadFileToIpfs(req.file);

		res.status(200).json({
			message: data.error || "File uploaded successfully",
			cid: data.cid,
			fileName: data.name,
			size: data.size || "Unknown size",
			allocations: data.allocations,
		});
		return;
	} catch (error) {
		console.log(error);
		res.status(500).json({ error: "Error processing file" });
	}
};


export const addJsonFile = async (req: Request, res: Response): Promise<void> => {
    try {
        let jsonData;
        
        if (req.file) {
            // Si el archivo viene como req.file, lo lee desde el sistema de archivos (posible error)
            jsonData = fs.readFileSync(req.file.path, "utf8");
        } else if (req.body) {
            // Si viene en el body, lo usa directamente
            jsonData = JSON.stringify(req.body);
        } else {
            throw new Error("No JSON data received");
        }

        const data: IClusterFile = await uploadJsonToIpfs(jsonData);

        res.status(200).json({
            message: data.error || "JSON uploaded successfully",
            cid: data.cid,
            fileName: "data.json",
            size: data.size || "Unknown size",
            allocations: data.allocations,
        });
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Error processing JSON file" });
    }
};


export const getPinnedFiles = async (
	req: Request,
	res: Response
): Promise<void> => {
	try {
		const filesString: string = await pinnedFiles();

		const jsonStrings = filesString.trim().split("\n");

		const files = jsonStrings.map((line) => JSON.parse(line));

		res.status(200).json(files);
	} catch (error) {
		console.error("Error processing pinned files:", error);

		res.status(500).json({
			message: "Error fetching pinned files",
		});
	}
};
export const getPinStatus = async (
	req: Request,
	res: Response
): Promise<void> => {
	try {
		const cid: string = req.params.cid;
		const pinStatusData: IpfsClusterCidStatusResponse = await pinStatus(cid);

		res.status(200).json(pinStatusData);
	} catch (error) {
		console.error("Error processing pinned files:", error);

		res.status(500).json({
			message: "Error fetching pinned files",
		});
	}
};
