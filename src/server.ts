import express from "express";
import router from "./routes";
import cors from "cors";
const server = express();



server.use(cors());

server.use(express.json());

server.use(express.urlencoded({ extended: true }));

server.use(router);

export default server;
