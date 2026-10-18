// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SimpleDEX v2
/// @notice Exchange descentralizado de producto constante (x * y = k) entre dos tokens ERC20.
/// @dev Versión mejorada del trabajo práctico de ETH-KIPU. Cambios respecto de la v1:
///      - Reservas internas: la cotización ya no se puede manipular enviando tokens "de regalo" al contrato.
///      - Protección contra slippage / sandwich: cada swap exige un mínimo a recibir (minAmountOut).
///      - No se puede operar con el pool vacío (en la v1 el usuario perdía sus tokens).
///      - SafeERC20: soporta tokens que no devuelven bool o que devuelven false en vez de revertir.
///      - Se cuenta lo que realmente llegó al contrato (tokens con comisión por transferencia).
///      - Protección contra reentrancia y validaciones en el constructor.
///      - Comisión de 0,3 % por swap que queda en el pool, a favor de quien aporta liquidez.
///      - La liquidez nueva se agrega respetando la proporción actual, sin mover el precio.
contract SimpleDEX is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Token A del pool.
    IERC20 public immutable tokenA;
    /// @notice Token B del pool.
    IERC20 public immutable tokenB;

    /// @notice Reserva contabilizada de token A (no incluye tokens enviados directamente al contrato).
    uint256 public reserveA;
    /// @notice Reserva contabilizada de token B.
    uint256 public reserveB;

    /// @notice Comisión por swap, en puntos básicos (30 = 0,3 %).
    uint256 public constant FEE_BPS = 30;
    uint256 private constant BPS = 10_000;

    error ZeroAddress();
    error SameToken();
    error ZeroAmount();
    error EmptyPool();
    error InvalidToken();
    error InsufficientLiquidity();
    error InsufficientOutput(uint256 amountOut, uint256 minAmountOut);
    error UnbalancedRemoval();

    event LiquidityAdded(address indexed provider, uint256 amountA, uint256 amountB);
    event LiquidityRemoved(address indexed to, uint256 amountA, uint256 amountB);
    event TokenSwapped(address indexed user, address indexed tokenIn, uint256 amountIn, uint256 amountOut);
    event Skimmed(address indexed to, uint256 amountA, uint256 amountB);

    constructor(address _tokenA, address _tokenB) Ownable(msg.sender) {
        if (_tokenA == address(0) || _tokenB == address(0)) revert ZeroAddress();
        if (_tokenA == _tokenB) revert SameToken();
        tokenA = IERC20(_tokenA);
        tokenB = IERC20(_tokenB);
    }

    // ---------------------------------------------------------------- liquidez

    /// @notice Agrega liquidez al pool. Solo el owner.
    /// @dev Si el pool ya tiene fondos, toma la mayor cantidad posible que respete la proporción
    ///      actual (sin pasarse de lo indicado), para no alterar el precio.
    /// @return usedA Cantidad de token A efectivamente agregada.
    /// @return usedB Cantidad de token B efectivamente agregada.
    function addLiquidity(uint256 amountA, uint256 amountB)
        external
        onlyOwner
        nonReentrant
        returns (uint256 usedA, uint256 usedB)
    {
        if (amountA == 0 || amountB == 0) revert ZeroAmount();

        if (reserveA == 0 && reserveB == 0) {
            (usedA, usedB) = (amountA, amountB);
        } else {
            uint256 optimalB = (amountA * reserveB) / reserveA;
            if (optimalB <= amountB) {
                (usedA, usedB) = (amountA, optimalB);
            } else {
                (usedA, usedB) = ((amountB * reserveA) / reserveB, amountB);
            }
            if (usedA == 0 || usedB == 0) revert ZeroAmount();
        }

        usedA = _pull(tokenA, usedA);
        usedB = _pull(tokenB, usedB);
        reserveA += usedA;
        reserveB += usedB;

        emit LiquidityAdded(msg.sender, usedA, usedB);
    }

    /// @notice Retira liquidez del pool. Solo el owner.
    /// @dev No permite dejar un lado del pool vacío y el otro con fondos (el precio quedaría roto).
    function removeLiquidity(uint256 amountA, uint256 amountB) external onlyOwner nonReentrant {
        if (amountA == 0 && amountB == 0) revert ZeroAmount();
        if (amountA > reserveA || amountB > reserveB) revert InsufficientLiquidity();

        bool emptiesA = amountA == reserveA;
        bool emptiesB = amountB == reserveB;
        if (emptiesA != emptiesB) revert UnbalancedRemoval();

        reserveA -= amountA;
        reserveB -= amountB;

        tokenA.safeTransfer(msg.sender, amountA);
        tokenB.safeTransfer(msg.sender, amountB);

        emit LiquidityRemoved(msg.sender, amountA, amountB);
    }

    /// @notice Recupera tokens enviados por error directamente al contrato (fuera de las reservas).
    function skim(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 extraA = tokenA.balanceOf(address(this)) - reserveA;
        uint256 extraB = tokenB.balanceOf(address(this)) - reserveB;
        if (extraA > 0) tokenA.safeTransfer(to, extraA);
        if (extraB > 0) tokenB.safeTransfer(to, extraB);
        emit Skimmed(to, extraA, extraB);
    }

    // ------------------------------------------------------------------- swaps

    /// @notice Cambia token A por token B.
    /// @param amountAIn Cantidad de token A a entregar.
    /// @param minAmountBOut Mínimo de token B a recibir; si el precio se movió más que eso, revierte.
    function swapAforB(uint256 amountAIn, uint256 minAmountBOut) external nonReentrant returns (uint256 amountBOut) {
        amountBOut = _swap(tokenA, tokenB, amountAIn, minAmountBOut);
    }

    /// @notice Cambia token B por token A.
    /// @param amountBIn Cantidad de token B a entregar.
    /// @param minAmountAOut Mínimo de token A a recibir; si el precio se movió más que eso, revierte.
    function swapBforA(uint256 amountBIn, uint256 minAmountAOut) external nonReentrant returns (uint256 amountAOut) {
        amountAOut = _swap(tokenB, tokenA, amountBIn, minAmountAOut);
    }

    // ---------------------------------------------------------------- consultas

    /// @notice Precio de `_token` expresado en el otro token, con 18 decimales.
    function getPrice(address _token) external view returns (uint256) {
        if (reserveA == 0 || reserveB == 0) revert EmptyPool();
        if (_token == address(tokenA)) return (reserveB * 1e18) / reserveA;
        if (_token == address(tokenB)) return (reserveA * 1e18) / reserveB;
        revert InvalidToken();
    }

    /// @notice Cotiza cuánto se recibiría al entregar `amountIn` de `tokenIn` (comisión incluida).
    function getAmountOut(address tokenIn, uint256 amountIn) external view returns (uint256) {
        if (tokenIn == address(tokenA)) return _getAmountOut(amountIn, reserveA, reserveB);
        if (tokenIn == address(tokenB)) return _getAmountOut(amountIn, reserveB, reserveA);
        revert InvalidToken();
    }

    // ---------------------------------------------------------------- internas

    function _swap(IERC20 tokenIn, IERC20 tokenOut, uint256 amountIn, uint256 minAmountOut)
        private
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (reserveA == 0 || reserveB == 0) revert EmptyPool();

        bool aToB = tokenIn == tokenA;
        // Se cobra sobre lo que realmente llegó (cubre tokens con comisión por transferencia).
        uint256 received = _pull(tokenIn, amountIn);

        (uint256 reserveIn, uint256 reserveOut) = aToB ? (reserveA, reserveB) : (reserveB, reserveA);
        amountOut = _getAmountOut(received, reserveIn, reserveOut);
        if (amountOut == 0 || amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);

        if (aToB) {
            reserveA += received;
            reserveB -= amountOut;
        } else {
            reserveB += received;
            reserveA -= amountOut;
        }

        tokenOut.safeTransfer(msg.sender, amountOut);
        emit TokenSwapped(msg.sender, address(tokenIn), received, amountOut);
    }

    /// @dev Transfiere desde msg.sender y devuelve lo que efectivamente ingresó al contrato.
    function _pull(IERC20 token, uint256 amount) private returns (uint256) {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        return token.balanceOf(address(this)) - before;
    }

    /// @dev Producto constante con comisión: out = in*(1-fee)*R_out / (R_in + in*(1-fee)).
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) private pure returns (uint256) {
        if (reserveIn == 0 || reserveOut == 0) return 0;
        uint256 amountInWithFee = amountIn * (BPS - FEE_BPS);
        return (amountInWithFee * reserveOut) / (reserveIn * BPS + amountInWithFee);
    }
}
