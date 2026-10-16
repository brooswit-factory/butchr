bump: patch

### Fixed
- The built dashboard app (`/dashboard-app/`, including the Rules page) rendered blank in a browser: every `/dashboard-app*` response had no `content-type` header (the CSP/`nosniff` hook added in FACTORY-662 rebuilt the response and dropped the static file's implicit type), and with `X-Content-Type-Options: nosniff` the browser refused to run the module script. Static assets now set `content-type` explicitly. Found by a real-browser pass of the Rules page (FACTORY-686).
