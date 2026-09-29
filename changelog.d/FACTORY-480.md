bump: minor

### Added

- **`POST /resources/for-url` (FACTORY-480, implementing FACTORY-478, epic
  FACTORY-330).** A real MV3 extension service worker's GET carries no
  `Origin` header at all (measured against headless Chrome for Testing 148
  with a real built `clevr` extension), so the strict Origin-required guard
  403'd Clevr's lookup on every real install, and no `BUTCHR_EXTENSION_ORIGINS`
  entry could fix it. Clevr now sends this lookup as a POST with the page URL
  in a JSON body — the request shape Chrome DOES stamp with `Origin` from a
  service worker. The guard (`src/web/origin-guard.ts`'s
  `checkExtensionOrigin`) is unchanged and fully strict: an absent `Origin`
  is still refused on every guarded route, on both methods. `GET
  /resources/for-url` is kept, unchanged, for any caller that can present a
  real `Origin` header itself; it is simply unreachable from Clevr's own
  service-worker context. CORS preflight now also advertises `POST` and
  `content-type` (a JSON-body POST triggers a real preflight). See
  `docs/resources-for-url.md` for the full contract.
