import { Router } from "express";
import {
	addFile,
	addJsonFile,
	getPinnedFiles,
	getPinStatus,
} from "../controllers/Cluster.Controllers";
import { handleUploadSingleFile } from "../middlewares";
import auth from "../middlewares/auth";
import { sendEmail } from "../controllers/Email.controller";

const router: Router = Router();

router.post("/ipfs/add", auth, handleUploadSingleFile, addFile);
router.post("/ipfs/addJson", auth, addJsonFile);

router.get("/ipfs/pins", getPinnedFiles);
router.get("/ipfs/pins/:cid", getPinStatus);
router.get("/ipfs/:cid")


router.post('/email/send',auth,sendEmail)

router.get("/", (req, res) => {
	res.send("Openvino API is Up!");
});

export default router;
