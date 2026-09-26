import { parseAbi } from 'viem';

// RobinPortal — matches the audited contracts in usdg-pad/src
// (RobinPortal.sol). The quote asset is fixed per portal at construction,
// so CreateLaunchParams has no quoteAsset field.
export const portalAbi = parseAbi([
  'struct CreateLaunchParams { string name; string symbol; uint256 startingMarketCapQuote; uint16 buyTaxBps; uint16 sellTaxBps }',
  'function createLaunch(CreateLaunchParams p) returns (address token, address locker)',
  'function quoteAsset() view returns (address)',
  'function launchCount() view returns (uint256)',
  'function allLaunches(uint256) view returns (address)',
  'function lockerForToken(address) view returns (address)',
  'function hook() view returns (address)',
  'function treasury() view returns (address)',
  'function MIN_STARTING_MC_QUOTE() view returns (uint256)',
  'function MAX_STARTING_MC_QUOTE() view returns (uint256)',
  'function MAX_TAX_BPS() view returns (uint16)',
  'event LaunchCreated(address indexed token, address indexed creator, address locker, address splitter, bytes32 poolId, address quoteAsset, bool tokenIsToken0, uint16 buyTaxBps, uint16 sellTaxBps, int24 tickLower, int24 tickUpper, uint160 initSqrtPriceX96, string name, string symbol)',
]);

export const hookAbi = parseAbi([
  'function poolConfigs(bytes32) view returns (address splitter, address quoteAsset, bool tokenIsToken0, uint16 buyTaxBps, uint16 sellTaxBps, bool active)',
  'function pendingTax(bytes32) view returns (uint256)',
  'function flush((address,address,uint24,int24,address) key)',
  'event TaxCollected(bytes32 indexed poolId, address indexed quoteAsset, bool isBuy, uint256 amount)',
  'event TaxFlushed(bytes32 indexed poolId, address indexed quoteAsset, address indexed splitter, uint256 amount, address caller)',
]);

export const splitterAbi = parseAbi([
  'function creator() view returns (address)',
  'function pendingCreator() view returns (address)',
  'function acceptCreator()',
  'function creditedToCreator(address) view returns (uint256)',
  'function creditedToPlatform(address) view returns (uint256)',
  'function claim(address to, address quoteAsset)',
  'function claimPlatform(address quoteAsset)',
  'function isMainPad() view returns (bool)',
  'event RevenueReceived(address indexed quoteAsset, uint256 total, uint256 platformCut, uint256 creatorCut)',
  'event CreatorClaimed(address indexed to, address indexed quoteAsset, uint256 amount)',
]);

export const lockerAbi = parseAbi([
  'function harvestFees()',
  'function seeded() view returns (bool)',
  'function tickLower() view returns (int24)',
  'function tickUpper() view returns (int24)',
  'function splitter() view returns (address)',
]);

export const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export const permit2Abi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

export const universalRouterAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);

export const poolManagerAbi = parseAbi([
  'function extsload(bytes32 slot) view returns (bytes32)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
]);
