export const VINISWAP_PAIR_ABI = [
	"function token0() view returns (address)",
	"function token1() view returns (address)",
	"function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
	"function totalSupply() view returns (uint256)",
	"event Transfer(address indexed from, address indexed to, uint256 value)",
	"event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
	"event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
	"event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)",
	"event Sync(uint112 reserve0, uint112 reserve1)",
];

export const ERC20_ABI = [
	"function symbol() view returns (string)",
	"function name() view returns (string)",
	"function decimals() view returns (uint8)",
];
