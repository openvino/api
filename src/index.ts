import server from "./server";
import { PORT } from "./config";

server.listen(PORT, () => {
	console.log(`Server running on port ${PORT}`);
});
