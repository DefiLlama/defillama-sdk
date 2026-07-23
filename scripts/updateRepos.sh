SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
ROOT_DIR=$SCRIPT_DIR/..

cd $ROOT_DIR

SDK_VERSION=$(node -p "require('./package.json').version")
echo "Pinning @defillama/sdk to $SDK_VERSION"

mkdir -p depRepos
cd depRepos

# Pin @defillama/sdk to $SDK_VERSION in package.json (any range/spec).
pin_sdk_version() {
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    let changed = false;
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (p[k] && p[k]['@defillama/sdk']) {
        p[k]['@defillama/sdk'] = '$SDK_VERSION';
        changed = true;
      }
    }
    if (changed) fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
  "
}

# update_repo <repo-name> <git-url> <branch> [subdir1 subdir2 ...]
update_repo() {
  local name=$1 url=$2 branch=$3
  shift 3
  local subdirs=("$@")
  [ ${#subdirs[@]} -eq 0 ] && subdirs=(".")

  echo "Update $name"
  [ ! -d "$name" ] && git clone "$url"

  pushd "$name" > /dev/null
  git stash
  git checkout "$branch"
  git pull

  for sub in "${subdirs[@]}"; do
    pushd "$sub" > /dev/null
    pin_sdk_version
    pnpm i
    git add package.json pnpm-lock.yaml
    popd > /dev/null
  done

  git commit -m "update @defillama/sdk version"
  git push
  popd > /dev/null
}

update_repo DefiLlama-Adapters  git@github.com:DefiLlama/DefiLlama-Adapters.git  main
update_repo dimension-adapters  git@github.com:DefiLlama/dimension-adapters.git  master
update_repo defillama-server    git@github.com:DefiLlama/defillama-server.git    master  defi coins
update_repo peggedassets-server git@github.com:DefiLlama/peggedassets-server.git master
update_repo emissions-adapters  git@github.com:DefiLlama/emissions-adapters.git  master

# Private repos, configured via the PRIVATE_REPOS env var so they stay out of
# this committed script. Format: one repo per line, fields are the same as the
# update_repo args (name, url, branch, and optional subdirs), space-separated.
# Example:
#   export PRIVATE_REPOS="my-private-repo git@github.com:org/my-private-repo.git main
#   another-repo git@github.com:org/another-repo.git master defi coins"
if [ -n "$SDK_UPDATE_PRIVATE_REPOS" ]; then
  while IFS= read -r line; do
    # skip blank lines and comments
    [ -z "${line// }" ] && continue
    [ "${line#\#}" != "$line" ] && continue
    update_repo $line
  done <<< "$SDK_UPDATE_PRIVATE_REPOS"
fi

