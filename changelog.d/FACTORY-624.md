bump: patch

### Changed
- The release gate now derives a minimum bump from the diff's public surface:
  HTTP routes and `BUTCHR_*` env names under `src/` are compared against the
  merge-base. Adding one requires at least `bump: minor`; removing (or
  renaming) one requires `bump: major` with a `### BREAKING` section. A
  fragment that declares a lower level fails the gate (FACTORY-624).
