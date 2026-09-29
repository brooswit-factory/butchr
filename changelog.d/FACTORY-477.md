bump: minor

### Changed

- **Clevr's one fixed extension id (`chrome-extension://geffpgminecanhmpafbliajpeleoocan`) is now the daemon's allowed extension origin (FACTORY-475, implementing FACTORY-477, epic FACTORY-330).** A fresh Clevr install now attaches to the daemon with no daemon-side configuration at all, since Clevr's `manifest.json` pins a `"key"` that makes this id stable across every install (see the `clevr` repo, FACTORY-475). The id is hardcoded and is the only allowed origin; there is no default-plus-override, additive override or operator allowlist (see the BREAKING entry from FACTORY-497, which removes `BUTCHR_EXTENSION_ORIGINS`). **This is a deliberate opening of the guard to one fixed id**, the same shape of operator-decided tradeoff FACTORY-464 made to the auth requirement itself: any local process that can set an `Origin` header by hand can spoof this exact origin.
