#!/usr/bin/env bash
# Descarga en ./backups las copias vigentes guardadas como artifacts de GitHub Actions.
# Requiere GH_TOKEN y GITHUB_REPOSITORY, que GitHub Actions proporciona.
set -euo pipefail

dir="${1:-backups}"
mkdir -p "$dir"

gh api --paginate "repos/$GITHUB_REPOSITORY/actions/artifacts?per_page=100" \
  --jq '.artifacts[] | select(.expired | not) | select(.name | startswith("backup-")) | "\(.id) \(.name)"' |
while read -r artifact_id name; do
  id="${name#backup-}"
  [ -d "$dir/$id" ] && continue
  mkdir -p "$dir/$id"
  gh api "repos/$GITHUB_REPOSITORY/actions/artifacts/$artifact_id/zip" > "$dir/$id.zip"
  unzip -q -o "$dir/$id.zip" -d "$dir/$id"
  rm "$dir/$id.zip"
  echo "Descargada: $id"
done
