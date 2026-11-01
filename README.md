# xevolution-site

STATUS: placeholder only. This repository does NOT yet contain the storefront.

The real, deployable site tree lives on the station at
`offers/497-vault/site/` (8 HTML pages + `assets/`), passes
`python _site_tools/deploy_gate.py --root site` -> `RESULT: SAFE TO DEPLOY`,
and is packaged as `offers/xevolution-site-deploy.zip`.

## Why the files are not here

The station holds no GitHub push credential: HTTPS push prompts and dies,
there is no SSH key for github.com, and the `gh` CLI is not installed. The
GitHub connector can create a repository but this route was not used to
stream the tree.

## How to finish the deploy

1. Reconnect Vercel in ABILITIES > DISCOVER (currently returning HTTP 401), or
   add a Cloudflare API token with Pages + account read.
2. Upload `xevolution-site-deploy.zip`.
3. Point it at the domain. DNS already resolves `xevolution.biz` and
   `www.xevolution.biz` at Vercel.
