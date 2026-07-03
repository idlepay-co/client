#!/usr/bin/env bash
# Verify that the extension published on the VS Code Marketplace was built
# from this source tree.
#
#   ./scripts/verify.sh            # verify the latest published version
#   ./scripts/verify.sh 0.0.20     # verify a specific version
#
# For an exact match, check out the tag of the version you are verifying
# (releases are tagged v<version>), then run this script.
#
# The script builds the working tree, downloads the published package, and
# diffs the CONTENTS of both archives file by file. Archive checksums are NOT
# compared: zip files embed timestamps, so two byte-identical trees still
# produce different archive hashes. The file-by-file diff is the check that
# actually means something.
set -euo pipefail
cd "$(dirname "$0")/.."

PUBLISHER=Idlepay
NAME=idlepay

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION=$(curl -sf "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery" \
    -H "Content-Type: application/json" -H "Accept: application/json;api-version=7.1-preview.1" \
    -d "{\"filters\":[{\"criteria\":[{\"filterType\":7,\"value\":\"${PUBLISHER}.${NAME}\"}]}],\"flags\":1}" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).results[0].extensions[0].versions[0].version))")
fi
echo "==> Verifying ${PUBLISHER}.${NAME} v${VERSION} against this source tree"

LOCAL_VERSION=$(node -p "require('./package.json').version")
if [ "$LOCAL_VERSION" != "$VERSION" ]; then
  echo "!!  Source tree is version ${LOCAL_VERSION}, published is ${VERSION}."
  echo "    Check out the matching tag first:  git checkout v${VERSION}"
  exit 1
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "==> Building from source (pnpm, pinned by lockfile)"
pnpm install --frozen-lockfile --silent
pnpm build >/dev/null
pnpm package >/dev/null
unzip -qo "${NAME}-${VERSION}.vsix" -d "$WORK/local"

echo "==> Downloading the published package"
curl -sfL --compressed \
  "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${PUBLISHER}/vsextensions/${NAME}/${VERSION}/vspackage" \
  -o "$WORK/published.vsix"
unzip -qo "$WORK/published.vsix" -d "$WORK/published"

echo "==> Diffing contents"
if diff -r "$WORK/local" "$WORK/published"; then
  echo ""
  echo "✅  MATCH — the published v${VERSION} is exactly what this source builds."
else
  echo ""
  echo "❌  MISMATCH — the published package differs from this source tree."
  echo "    If you are not on the release tag (v${VERSION}), check it out and retry."
  exit 1
fi
