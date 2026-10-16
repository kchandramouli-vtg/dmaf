require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

/* Hardhat lives under chain/ so it doesn't mix with the MCO JSON-LD
   templates in contracts/templates.

   chain/contracts/mpeg21/  ISO/IEC 21000-23 reference contracts (Contract, NFToken,
                            EnumerableMap), byte-for-byte; OpenZeppelin 4.9 as in the reference
   chain/contracts/cel/     the CEL Server's contracts (Cel, MediaToken), compiled with
                            solc 0.7.6 like the reference CEL Server does */
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL;
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;

module.exports = {
  solidity: {
    compilers: [{ version: "0.8.28", settings: { optimizer: { enabled: true, runs: 200 } } }],
    overrides: {
      "chain/contracts/cel/Ethereum_Smart.sol": { version: "0.7.6", settings: { optimizer: { enabled: false } } },
      "chain/contracts/cel/Ethereum_Media_Token.sol": { version: "0.7.6", settings: { optimizer: { enabled: false } } },
    },
  },
  paths: {
    sources: "./chain/contracts",
    tests: "./chain/test",
    cache: "./chain/cache",
    artifacts: "./chain/artifacts",
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    // Optional public testnet: SEPOLIA_RPC_URL=… DEPLOYER_PRIVATE_KEY=0x… npm run deploy -- --network sepolia
    ...(SEPOLIA_RPC && DEPLOYER_KEY ? { sepolia: { url: SEPOLIA_RPC, chainId: 11155111, accounts: [DEPLOYER_KEY] } } : {}),
  },
  mocha: { timeout: 120000 },
};
