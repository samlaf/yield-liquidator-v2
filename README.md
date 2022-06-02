# Yield Protocol Liquidator

Liquidates undercollateralized fyDAI-ETH positions using Uniswap V2 as a capital source.

This liquidator **altruistically** calls the `Witch.auction` function for any
position that is underwater, trigerring an auction for that position. It then tries
to participate in the auction by flashloaning funds from Uniswap, if there's enough
profit to be made.

## CLI

```
Usage: ./yield-liquidator [OPTIONS]

Optional arguments:
  -h, --help
  -c, --config CONFIG        path to json file with the contract addresses
  -u, --url URL              the Ethereum node endpoint (HTTP or WS) (default: http://localhost:8545)
  -C, --chain-id CHAIN-ID    chain id (default: 1)
  -p, --private-key PRIVATE-KEY
                             path to your private key
  -i, --interval INTERVAL    polling interval (ms) (default: 1000)
  -f, --file FILE            the file to be used for persistence (default: data.json)
  -m, --min-ratio MIN-RATIO  the minimum ratio (collateral/debt) to trigger liquidation, percents (default: 110)
  -s, --start-block START-BLOCK
                             the block to start watching from
```

Your contracts' `--config` file should be in the following format where:

- `Witch` is the address of the Witch (Liquidation Engine)
- `Flash` is the address of the PairFlash (see below)
- `Multicall2` is the address of [Multicall2](https://github.com/makerdao/multicall#multicall2-contract-addresses)
- `SwapRouter02` is the address of Uniswapv2's [Router02](https://docs.uniswap.org/protocol/V2/reference/smart-contracts/router-02)
- `BaseToDebtThreshold` is a ilkid -> threshold dict (look in regression_tests/flashLiquidator.ts for examples) TODO: understand how it works, decimals, etc.

```
{
  "Witch": "0xD6b040736e948621c5b6E0a494473c47a6113eA8",
  "Flash": "0x0a17FabeA4633ce714F1Fa4a2dcA62C3bAc4758d",
  "Multicall2": "0x5ba1e12693dc8f9c48aad8770482f4739beed696",
  "SwapRouter02": "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  "BaseToDebtThreshold": { "303200000000": "1000000000" }
}
```

`Flash` is a deployment of `PairFlash` contract (https://github.com/sblOWPCKCR/vault-v2/blob/liquidation/contracts/liquidator/Flash.sol). Easy way to compile/deploy it:

```
solc --abi --overwrite --optimize --optimize-runs 5000 --bin -o /tmp/ external/vault-v2/contracts/liquidator/Flash.sol && ETH_GAS=3000000 seth send --create /tmp/PairFlash.bin "PairFlash(address,address,address,address,address) " $OWNER 0xE592427A0AEce92De3Edee1F18E0157C05861564 0x1F98431c8aD98523631AE4a59f267346ea31F984 0xd0a1e359811322d97991e03f863a0c30c2cf029c $WITCH_ADDRESS
```

The `--private-key` _must not_ have a `0x` prefix. Set the `interval` to 15s for mainnet.

## Building and Running

```
# Build in release mode
cargo build --release

# Run it with
./target/release/yield-liquidator \
    --config ./addrs.json \
    --private-key ./private_key \
    --url http://localhost:8545 \
    --interval 7000 \
    --file state.json \
```

## How it Works

On each block:

1. Bumps the gas price of all of our pending transactions
2. Updates our dataset of borrowers debt health & liquidation auctions with the new block's data
3. Trigger the auction for any undercollateralized borrowers
4. Try participating in any auctions which are worth buying

Take this liquidator for a spin by [running it in a test environment](TESTNET.md).

## More Info

All interfaces for yield contracts are found in [this repo](https://github.com/yieldprotocol/vault-interfaces/tree/main/src).

Important calls for us:

- [cauldron.level(vaultId)](https://github.com/yieldprotocol/vault-interfaces/blob/29af681f100726425d2c38e70171303b06c44492/src/ICauldron.sol#L118) returns the collateralization level of a vault (negative if undercollateralized)
  - seth call <cauldron_addr> "level(bytes12)(int256)" "<vault_id>"
- [spotOracle.get(base, quote amount)](https://github.com/yieldprotocol/vault-interfaces/blob/29af681f100726425d2c38e70171303b06c44492/src/IOracle.sol#L19)
  - seth call <spotOracle_addr> "get(bytes32,bytes32,uint256)(uint256, uint256)" "<base_id>" "<quote_id/ilk_id>" "<amount>"
  - eg. seth call <spotOracleAddr> "get(bytes32,bytes32,uint256)(uint256, uint256)" "0x303100000000" "0x303000000000" "1000000000000000000"
- [cauldron.balances(vault)](https://github.com/yieldprotocol/vault-interfaces/blob/29af681f100726425d2c38e70171303b06c44492/src/ICauldron.sol#L27): returns the debt/collateral balances of this vault (each vault can only borrow from one series)
  - seth call <cauldron_addr> "balances(bytes12)(uint128,uint128)" "<vault_id>"
