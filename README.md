# SimpleDEX v2

Exchange descentralizado (DEX) de dos tokens ERC20 escrito en Solidity, con la regla del producto constante **x · y = k**.

La v1 fue el trabajo práctico del **Developer Pack en Ethereum de ETH-KIPU**. La v2 revisa ese contrato, corrige sus fallas y suma tests que las demuestran.

**Demo interactiva:** [`demo/index.html`](demo/index.html). Simula el pool en el navegador con la misma matemática del contrato y compara, caso por caso, la v1 con la v2.

## Qué fallaba en la v1 y cómo se resolvió

| Falla en la v1 | Qué podía pasar | Solución en la v2 |
|---|---|---|
| Swap con el pool vacío | El usuario entregaba sus tokens y recibía 0 | Revierte con `EmptyPool` |
| Sin mínimo a recibir | Ataque sándwich: el usuario recibía mucho menos de lo esperado | Parámetro `minAmountOut` en cada swap |
| Precio calculado con `balanceOf` | Cualquiera podía mover el precio enviando tokens directo al contrato | Reservas internas (`reserveA`, `reserveB`) y `skim()` para recuperar lo enviado por error |
| No revisa la respuesta de `transfer` / `transferFrom` | Con tokens que devuelven `false`, se entregaban tokens sin cobrar | `SafeERC20` |
| `getPrice` con el pool vacío | División por cero | Error claro `EmptyPool` |
| Liquidez en cualquier proporción | Agregar liquidez movía el precio | Toma solo la parte proporcional |
| Retiro de liquidez sin control | Se podía vaciar un lado del pool y dejar el otro | Revierte con `UnbalancedRemoval` |
| Sin validaciones en el constructor | Dirección cero o el mismo token dos veces | `ZeroAddress` / `SameToken` |

Además, la v2 suma:
- **Comisión de 0,3 %** por swap, que queda en el pool.
- Soporte para **tokens con comisión por transferencia**: se cuenta lo que realmente llegó.
- **Protección contra reentrancia** (`ReentrancyGuard`).
- Eventos más completos y **errores con nombre**.

> **Cambio de interfaz:** `swapAforB` y `swapBforA` ahora reciben un segundo parámetro, el mínimo a recibir. Se agregó `getAmountOut(tokenIn, amountIn)` para cotizar antes de operar.

## Estructura

```
packages/hardhat/contracts/SimpleDex.sol          contrato v2
packages/hardhat/contracts/TokenA.sol, TokenB.sol tokens de prueba
packages/hardhat/contracts/legacy/SimpleDexV1.sol versión original, solo para los tests
packages/hardhat/contracts/test/Mocks.sol         tokens no estándar para los tests
packages/hardhat/test/SimpleDex.test.js           20 tests (fallas de la v1 + v2)
demo/index.html                                   página demo
```

## Correrlo

Requiere Node 18+ y Yarn.

```bash
yarn install
yarn test     # corre los tests del contrato
yarn chain    # red local (en una terminal)
yarn deploy   # despliega TokenA, TokenB y SimpleDEX (en otra terminal)
yarn start    # front-end de Scaffold-ETH en http://localhost:3000
```

Al desplegar se regenera `packages/nextjs/contracts/deployedContracts.ts` con la nueva interfaz.

Para ver la demo alcanza con abrir `demo/index.html` en el navegador. Para publicarla en Vercel, importá este repo y elegí `demo` como *Root Directory*.

---

Hecho por Mirta Longhitano · [Moebius Labs](https://moebiuslabs.vercel.app) · Basado en [Scaffold-ETH 2](https://scaffoldeth.io).
