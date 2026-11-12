# Optimized contract WASM

Built with `stellar contract optimize` from `cargo build --release --target wasm32v1-none`. These files are tracked.

| File | Size (bytes) | SHA-256 |
|---|---:|---|
| `wasm/lending_pool.wasm` | 27349 | `d95a9703eb10b9c1ff08e056d88e6aec98cbdfbfaa53855f3b8ea94d6ed42209` |
| `wasm/marketplace_escrow.wasm` | 18577 | `39f6794006e93e8a0352f3ebef24e8cacfbc5839d879f7ff1096e9bddbb38f5f` |
| `wasm/reputation.wasm` | 13472 | `7b0c696d5d055cedb64e00f8876f8419a8400056fd9a27515721250e9644139f` |

Rebuild:

```powershell
stellar contract build
stellar contract optimize --wasm target/wasm32v1-none/release/lending_pool.wasm --wasm-out wasm/lending_pool.wasm
stellar contract optimize --wasm target/wasm32v1-none/release/marketplace_escrow.wasm --wasm-out wasm/marketplace_escrow.wasm
stellar contract optimize --wasm target/wasm32v1-none/release/reputation.wasm --wasm-out wasm/reputation.wasm
Get-FileHash -Algorithm SHA256 wasm\*.wasm
```
