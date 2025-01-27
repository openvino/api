import multer from "multer";

const upload = multer({
	dest: "uploads/",
	limits: { fileSize: 50 * 1024 * 1024 },
});

export const handleUploadSingleFile = upload.single("file");
