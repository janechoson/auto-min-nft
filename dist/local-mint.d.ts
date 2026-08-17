import { LocalMintPlan } from "./seadrop-public";
export interface LocalSnipeOpts {
    nftContract: string;
    quantity: number;
    walletKeys: string[];
    rpcUrls: string[];
    maxFeePerGas: bigint;
    maxPriorityFee: bigint;
    gasLimit: number;
    targetStart: Date | null;
    plan: LocalMintPlan;
}
export declare function localPublicSnipe(opts: LocalSnipeOpts): Promise<void>;
