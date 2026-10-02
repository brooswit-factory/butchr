bump: patch

### Fixed

- `dashboard-app` no longer renders a blank page: `vite.config.ts` now sets
  `base: "/dashboard-app/"` so built asset URLs resolve under the prefix the
  daemon actually serves them from, instead of 404ing at `/assets/...`.
