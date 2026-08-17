# NFT Public Mint

Vue 3 web app for minting public SeaDrop NFT stages with one configured wallet.
The server reads the private key from `.env`; the browser never receives it and
does not show a private-key input.

## Install

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```bash
PRIVATE_KEY=0x...
PORT=3003
MAX_FEE_PER_GAS=2
MAX_PRIORITY_FEE=0.05
GAS_LIMIT=250000
```

Use a dedicated hot wallet funded only with the amount you intend to spend.

## RPC Config

The RPC select is configured in [`public/const.js`](public/const.js):

```js
export default [
  { label: "Ethereum", id: 1, rpc: "https://ethereum-rpc.publicnode.com" },
  { label: "Base", id: 8453, rpc: "https://mainnet.base.org" },
  { label: "Robinhood", id: 4663, rpc: "https://rpc.mainnet.chain.robinhood.com" },
];
```

Keep [`src/consts.ts`](src/consts.ts) in sync with that list so the backend can
resolve the selected `id` to the actual RPC URL.

## Development

```bash
npm run dev
```

- Vue app: `http://localhost:5173`
- Express API: `http://localhost:3003`

## Production

```bash
npm run build
npm start
```

Open `http://localhost:3003`.

## Notes

- Only one wallet is used: `PRIVATE_KEY` from `.env`.
- The UI only sends `rpcId`; manual RPC URLs are not accepted by the web API.
- Public mint calldata is built from on-chain SeaDrop data.
- Allowlist or signed stages are not supported.
