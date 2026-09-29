bump: minor

### Changed

- **`BUTCHR_EXTENSION_ORIGINS` now defaults to Clevr's one fixed extension
  id (FACTORY-475, implementing FACTORY-477, epic FACTORY-330).** A fresh
  Clevr install now attaches to the daemon with no daemon-side
  configuration at all: `chrome-extension://geffpgminecanhmpafbliajpeleoocan`
  is allowlisted by default, since Clevr's `manifest.json` now pins a
  `"key"` that makes this id stable across every install (see the `clevr`
  repo, FACTORY-475). `BUTCHR_EXTENSION_ORIGINS` remains an ADDITIVE
  override — a non-empty explicit value adds to this default rather than
  replacing it. **This is a deliberate widening of the default allowlist by
  one fixed id**, the same shape of operator-decided tradeoff FACTORY-464
  made to the auth requirement itself: any local process that can set an
  `Origin` header by hand can now spoof this exact origin without the
  operator ever having typed it into `BUTCHR_EXTENSION_ORIGINS`. An
  explicitly EMPTY `BUTCHR_EXTENSION_ORIGINS` still fails closed to no
  origins at all — losing even this default — the same "never silently
  open" discipline the allowlist has always had.
