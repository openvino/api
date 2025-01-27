import { NextFunction, Request, Response } from "express";
import { API_KEY } from "../config";

const auth = (req: Request, res: Response, next: NextFunction) => {
	const apiKey = req.headers["x-api-key"];

	if (apiKey === API_KEY) {
		next();
	} else {
		res.status(401).json({ error: "Not authorized" });
	}
};

export default auth;
