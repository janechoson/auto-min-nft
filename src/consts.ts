export interface RpcEntry {
  label: string;
  id: number;
  rpc: string;
}

// Central RPC configuration shared by frontend (public/const.js) and backend.
export const RPCS: RpcEntry[] = [
  { label: 'Ethereum', id: 1, rpc: 'https://ethereum-rpc.publicnode.com' },
  { label: 'Base', id: 8453, rpc: 'https://mainnet.base.org' },
  { label: 'Robinhood', id: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com' },
  { label: 'BSC', id: 56, rpc: 'https://binance.llamarpc.com' },
];

export default RPCS;
