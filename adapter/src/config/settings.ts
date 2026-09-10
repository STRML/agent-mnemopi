// Type-only compatibility shim for the copied OMP bank resolver. The adapter
// reads settings read-only in context.ts and never instantiates Settings.
export interface Settings {
	get(path: string): unknown;
	getCwd(): string;
}
