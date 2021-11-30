// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity >=0.8.6;

import "./FlashLiquidator.sol";
import "./ICurveStableSwap.sol";
import "./IWstEth.sol";

// @notice This is the Yield Flash liquidator contract for Lido Wrapped Staked Ether (WstEth)
contract WstethFlashLiquidator is FlashLiquidator {
    using TransferHelper for address;
    using TransferHelper for IWstEth;

    // @notice "i" and "j" are the first two parameters (token to sell and token to receive respectively)
    //         in the CurveStableSwap.exchange function.  They represent that contract's internally stored
    //         index of the token being swapped
    // @dev    The STETH/ETH pool only supports two tokens: ETH index: 0, STETH index: 1
    //         https://etherscan.io/address/0xDC24316b9AE028F1497c275EB9192a3Ea0f67022#readContract
    //         This can be confirmed by calling the "coins" function on the CurveStableSwap contract
    //         0 -> 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE == ETH (the address Curve uses to represent ETH -- see github link below)
    //         1 -> 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84 == STETH (deployed contract address of STETH)
    // https://github.com/curvefi/curve-contract/blob/b0bbf77f8f93c9c5f4e415bce9cd71f0cdee960e/contracts/pools/steth/StableSwapSTETH.vy#L143
    int128 public constant CURVE_EXCHANGE_PARAMETER_I = 1; // token to sell (STETH, index 1 on Curve contract)
    int128 public constant CURVE_EXCHANGE_PARAMETER_J = 0; // token to receive (ETH, index 0 on Curve contract)

    ICurveStableSwap public immutable curveSwap;  // Curve stEth/Eth pool
    IWstEth public immutable wstEth;              // Lido wrapped stEth contract address
    address public immutable stEth;               // stEth contract address

    constructor(
        address recipient_,
        IWitch witch_,
        address factory_,
        ISwapRouter swapRouter_,

        ICurveStableSwap curveSwap_,
        address stEth_,
        IWstEth wstEth_
    ) FlashLiquidator(
        recipient_,
        witch_,
        factory_,
        swapRouter_
    ) {
        curveSwap = curveSwap_;
        stEth = stEth_;
        wstEth = wstEth_;
    }

    // @dev Required to receive ETH from Curve
    receive() external payable {}

    // @param fee0 The fee from calling flash for token0
    // @param fee1 The fee from calling flash for token1
    // @param data The data needed in the callback passed as FlashCallbackData from `initFlash`
    // @notice     implements the callback called from flash
    // @dev        Unlike the other Yield FlashLiquidator contracts, this contains extra steps to
    //             unwrap wstEth and swap it for Eth on Curve before Uniswapping it for base
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override {
        // we only borrow 1 token
        require(fee0 == 0 || fee1 == 0, "Two tokens were borrowed");
        uint256 fee;
        unchecked {
            // Since one fee is always zero, this won't overflow
            fee = fee0 + fee1;
        }

        // decode, verify, and set debtToReturn
        FlashCallbackData memory decoded = abi.decode(data, (FlashCallbackData));
        _verifyCallback(decoded.poolKey);
        uint256 debtToReturn = decoded.baseLoan + fee;

        // liquidate the vault
        decoded.base.safeApprove(decoded.baseJoin, decoded.baseLoan);
        uint256 collateralReceived = witch.payAll(decoded.vaultId, 0);

        // Sell collateral:

        // Step 1 - unwrap wstEth => stEth
        uint256 unwrappedStEth = wstEth.unwrap(collateralReceived);

        // Step 2 - swap stEth for Eth on Curve
        stEth.safeApprove(address(curveSwap), unwrappedStEth);
        uint256 ethReceived = curveSwap.exchange(
            CURVE_EXCHANGE_PARAMETER_I,  // index 1 representing STETH
            CURVE_EXCHANGE_PARAMETER_J,  // index 0 representing ETH
            unwrappedStEth,              // amount to swap
            0                            // no slippage guard
        );

        // Step 3 -  wrap the Eth => Weth
        IWETH9(WETH).deposit{value: ethReceived}();

        // Step 4 - if necessary, swap Weth for base on UniSwap
        uint256 debtRecovered;
        if (decoded.base == WETH) {
            debtRecovered = ethReceived;
        } else {
            ISwapRouter swapRouter_ = swapRouter;
            WETH.safeApprove(address(swapRouter_), ethReceived);
            debtRecovered = swapRouter_.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: WETH,
                    tokenOut: decoded.base,
                    fee: 500,  // can't use the same fee as the flash loan
                               // because of reentrancy protection
                    recipient: address(this),
                    deadline: block.timestamp + 180,
                    amountIn: ethReceived,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        // if profitable pay profits to recipient
        if (debtRecovered > debtToReturn) {
            uint256 profit;
            unchecked {
                profit = debtRecovered - debtToReturn;
            }
            decoded.base.safeTransfer(recipient, profit);
        }
        // repay flash loan
        decoded.base.safeTransfer(msg.sender, debtToReturn);
    }
}
