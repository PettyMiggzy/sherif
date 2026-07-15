// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CurveToken} from "../CurveToken.sol";
import {BondingCurve} from "../BondingCurve.sol";
import {OtcVault} from "../OtcVault.sol";

/// @notice Thin deployers so the big contracts' creation bytecode isn't inlined into CurveLaunchFactory
/// (24KB contract-size limit). Each is deployed once and its address handed to the factory.

contract CurveTokenDeployer {
    function deploy(string calldata name, string calldata symbol, uint256 supply, address recipient)
        external
        returns (address)
    {
        return address(new CurveToken(name, symbol, supply, recipient));
    }
}

contract BondingCurveDeployer {
    function deploy(
        address token,
        address weth,
        address v3Factory,
        address platform,
        address dev,
        uint256 virtEth,
        uint256 curveSupply,
        uint256 gradTarget,
        uint32 antiSnipeSecs,
        uint256 maxBuyWei
    ) external returns (address) {
        return address(
            new BondingCurve(token, weth, v3Factory, platform, dev, virtEth, curveSupply, gradTarget, antiSnipeSecs, maxBuyWei)
        );
    }
}

contract OtcVaultDeployer {
    function deploy(
        address v3Factory,
        address token,
        address weth,
        address sheriff,
        address platform,
        uint32 twapWindow,
        uint256 otcPrice,
        uint256 burnRatio
    ) external returns (address) {
        return address(new OtcVault(v3Factory, token, weth, sheriff, platform, twapWindow, otcPrice, burnRatio));
    }
}
