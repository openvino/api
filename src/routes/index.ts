import { Router } from "express";
import { addFile, getPinnedFiles } from "../controllers/Cluster.Controllers";
import { handleUploadSingleFile } from "../middlewares";
import auth from "../middlewares/auth";

const router: Router = Router();

router.post("/ipfs/add", auth, handleUploadSingleFile, addFile);

router.get("/pins", getPinnedFiles);

// router.get("/id", getEndpointId);

router.get("/", (req, res) => {
	res.send("Openvino API is Up!");
});

export default router;
