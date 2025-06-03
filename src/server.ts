import express from "express";
import router from "./routes";
import cors from "cors";

const server = express();

server.use(cors());

server.use(
	express.json({
		limit: "10mb",
	})
);

server.use(
	express.urlencoded({
		extended: true,
		limit: "10mb",
		parameterLimit: 50_000,
	})
);

server.use(router);

export default server;
