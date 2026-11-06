#!/usr/bin/env bash
# Build and publish dist/ to the gh-pages branch (no GitHub Actions). Needs gh auth.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
touch dist/.nojekyll
[ -f dist/CNAME ] || echo satsroadmarket.com > dist/CNAME
cd dist
rm -rf .git && git init -q -b gh-pages && git add -A
git -c user.name="satsroad deploy" -c user.email="deploy@satsroadmarket.com" commit -q -m "Deploy $(date -u +%FT%TZ)"
git push -f https://github.com/shroominic/satsroadmarket.git gh-pages
rm -rf .git
gh api -X POST repos/shroominic/satsroadmarket/pages/builds
