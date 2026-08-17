#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
const chalk_1 = __importDefault(require("chalk"));
dotenv_1.default.config({ path: path_1.default.resolve(process.cwd(), ".env") });
const wizard_1 = require("./wizard");
const prompt_1 = require("./prompt");
const HELP = `
NFT Public Mint Sniper

  Mints public SeaDrop stages. Calldata is built from on-chain state, so no
  OpenSea account or access token is required.

Usage
  npm start              run the interactive wizard
  npm start -- --help    show this message

Everything is asked interactively: keys, chain, quantity, NFT link, RPC,
gas and timing. Optional defaults can be set in .env (see .env.example).
`;
async function main() {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
        console.log(HELP);
        return;
    }
    try {
        await (0, wizard_1.runWizard)();
        (0, prompt_1.closePrompts)();
        process.exit(0);
    }
    catch (err) {
        (0, prompt_1.closePrompts)();
        console.error(chalk_1.default.red(`\n❌ ${err.message}\n`));
        process.exit(1);
    }
}
void main();
//# sourceMappingURL=index.js.map