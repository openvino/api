export const toNumber = (value: bigint | number): number => Number(value);

export const formatBigint = (value: bigint | number | string): string => {
	if (typeof value === "string") return value;
	if (typeof value === "number") return value.toString();
	return value.toString();
};

export const formatIsoDate = (timestamp: number): string | undefined => {
	if (!timestamp) return undefined;
	return new Date(timestamp * 1000).toISOString();
};

export const formatReadableDate = (timestamp: number): string | undefined => {
	if (!timestamp) return undefined;
	const iso = new Date(timestamp * 1000).toISOString();
	return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
};

export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));
