// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

// Simple Decentralized Exchange (DEX) contract
contract SimpleDEX is Ownable {
    IERC20 public tokenA;
    IERC20 public tokenB;

    uint256 public reserveA;
    uint256 public reserveB;

    event LiquidityAdded(uint256 amountA, uint256 amountB);
    event SwapAforB(address indexed user, uint256 inputAmount, uint256 outputAmount);
    event SwapBforA(address indexed user, uint256 inputAmount, uint256 outputAmount);
    event LiquidityRemoved(uint256 amountA, uint256 amountB);

    // Constructor initializes the contract with token addresses
    constructor(address _tokenA, address _tokenB) Ownable(msg.sender) {
        tokenA = IERC20(_tokenA);
        tokenB = IERC20(_tokenB);
    }

    function addLiquidity(uint256 amountA, uint256 amountB) external onlyOwner {
        require(amountA > 0 && amountB > 0, "AMT>0");

        IERC20 _tokenA = tokenA;
        IERC20 _tokenB = tokenB;

        require(_tokenA.allowance(msg.sender, address(this)) >= amountA, "ALLOW_A");
        require(_tokenB.allowance(msg.sender, address(this)) >= amountB, "ALLOW_B");

        _tokenA.transferFrom(msg.sender, address(this), amountA);
        _tokenB.transferFrom(msg.sender, address(this), amountB);

        reserveA += amountA;
        reserveB += amountB;

        emit LiquidityAdded(amountA, amountB);
    }

    // Resto del contrato (swapAforB, swapBforA, etc.) permanece igual
}


