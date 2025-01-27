export interface IClusterFile {
	cid: string;
	name: string;
	size: number;
	allocations: string[];
	error: string;
}

export interface PeerInfo {
	peername: string;
	ipfs_peer_id: string;
	ipfs_peer_addresses: string[];
	status: string;
	timestamp: string;
	error: string;
	attempt_count: number;
	priority_pin: boolean;
}

export interface IpfsClusterCidStatusResponse {
	cid: string;
	name: string;
	allocations: string[];
	origins: string[];
	created: string;
	metadata: any;
	peer_map: {
		[key: string]: PeerInfo;
	};
}
