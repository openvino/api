import MTBArtifact from "../artifacts/MTB.json";
import OVIArtifact from "../artifacts/OVI.json";

type ArtifactWithInput = { input: unknown };

const toStandardJsonInput = (artifact: ArtifactWithInput): string => {
	// keep only the fields the standard-json-input expects
	const input = artifact.input as {
		language?: unknown;
		sources?: unknown;
		settings?: unknown;
	};

	const cleaned = {
		language: input?.language ?? "Solidity",
		sources: input?.sources ?? {},
		settings: input?.settings ?? {},
	};

	return JSON.stringify(cleaned);
};

export const sourceCode = toStandardJsonInput(MTBArtifact);
export const sourceCodeOVI = toStandardJsonInput(OVIArtifact);
