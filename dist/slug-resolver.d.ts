interface CollectionInfo {
    name: string;
    contractAddress: string;
    chain: string;
}
export declare function resolveSlug(slug: string, apiKey?: string, preferredChain?: string): Promise<CollectionInfo>;
export declare function isSlug(input: string): boolean;
export {};
