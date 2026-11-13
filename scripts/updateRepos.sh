SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
ROOT_DIR=$SCRIPT_DIR/..

cd $ROOT_DIR

# Latest published version, so repos are never pinned to something not yet on npm.
SDK_VERSION=$(npm view @defillama/sdk version)
if [ -z "$SDK_VERSION" ]; then
  echo "ERROR: could not read the latest @defillama/sdk version from npm"
  exit 1
fi
export SDK_VERSION
echo "Pinning @defillama/sdk to $SDK_VERSION (latest on npm)"

LOCAL_VERSION=$(node -p "require('./package.json').version")
[ "$LOCAL_VERSION" != "$SDK_VERSION" ] && echo "NOTE: local package.json is at $LOCAL_VERSION, npm latest is $SDK_VERSION"

mkdir -p depRepos
cd depRepos

# Pin @defillama/sdk to $SDK_VERSION in package.json (any range/spec).
# Exit code: 0 = package.json changed, 10 = already on $SDK_VERSION, 11 = sdk is not a dependency.
pin_sdk_version() {
  node -e "
    const fs = require('fs');
    const version = process.env.SDK_VERSION;
    const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    let found = false, changed = false;
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (p[k] && p[k]['@defillama/sdk']) {
        found = true;
        if (p[k]['@defillama/sdk'] !== version) {
          p[k]['@defillama/sdk'] = version;
          changed = true;
        }
      }
    }
    if (changed) fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
    process.exit(changed ? 0 : found ? 10 : 11);
  "
}

# update_repo <repo-name> <git-url> <branch> [subdir1 subdir2 ...]
# Set PKG_MANAGER=npm for repos that use npm instead of pnpm.
update_repo() {
  local name=$1 url=$2 branch=$3
  shift 3
  local subdirs=("$@")
  [ ${#subdirs[@]} -eq 0 ] && subdirs=(".")

  local pm=${PKG_MANAGER:-pnpm} lockfile=pnpm-lock.yaml
  [ "$pm" = "npm" ] && lockfile=package-lock.json

  echo "

  ---

  Updating $name


   "
  [ ! -d "$name" ] && git clone "$url"

  pushd "$name" > /dev/null
  git stash
  git checkout "$branch"
  git pull --quiet

  local failed=0 staged=0
  for sub in "${subdirs[@]}"; do
    pushd "$sub" > /dev/null
    pin_sdk_version
    case $? in
      0)
        if ! $pm install; then
          echo "ERROR: $pm install failed in $name/$sub, skipping repo"
          failed=1
        elif git diff --quiet -- "$lockfile"; then
          echo "ERROR: $lockfile unchanged in $name/$sub, skipping repo"
          failed=1
        else
          git add package.json "$lockfile"
          staged=1
        fi
        ;;
      10) echo "$name/$sub already uses @defillama/sdk $SDK_VERSION, nothing to do" ;;
      11) echo "$name/$sub does not depend on @defillama/sdk, nothing to do" ;;
      *)
        echo "ERROR: could not update package.json in $name/$sub, skipping repo"
        failed=1
        ;;
    esac
    popd > /dev/null
    [ $failed -eq 1 ] && break
  done

  if [ $failed -eq 1 ]; then
    git reset --hard HEAD
    popd > /dev/null
    return 1
  fi

  if [ $staged -eq 0 ]; then
    echo "$name is already up to date, no commit needed"
    popd > /dev/null
    return 0
  fi

  git commit -m "update @defillama/sdk version"
  git push
  popd > /dev/null
}

update_repo DefiLlama-Adapters  git@github.com:DefiLlama/DefiLlama-Adapters.git  main
update_repo dimension-adapters  git@github.com:DefiLlama/dimension-adapters.git  master
update_repo defillama-server    git@github.com:DefiLlama/defillama-server.git    master  defi coins
update_repo peggedassets-server git@github.com:DefiLlama/peggedassets-server.git master
update_repo emissions-adapters  git@github.com:DefiLlama/emissions-adapters.git  master
update_repo nft-server  git@github.com:DefiLlama/nft-server.git  master
update_repo icons  git@github.com:DefiLlama/icons.git  v2
PKG_MANAGER=npm update_repo yield-server git@github.com:DefiLlama/yield-server.git master

# Private repos, configured via the SDK_UPDATE_PRIVATE_REPOS env var so they stay
# out of this committed script. Format: one repo per line, fields are the same as
# the update_repo args (name, url, branch, and optional subdirs), space-separated.
# Example:
#   export SDK_UPDATE_PRIVATE_REPOS="my-private-repo git@github.com:org/my-private-repo.git main
#   another-repo git@github.com:org/another-repo.git master defi coins"
# Prefix a line with PKG_MANAGER=npm for repos that use npm instead of pnpm:
#   PKG_MANAGER=npm npm-repo git@github.com:org/npm-repo.git main
if [ -n "$SDK_UPDATE_PRIVATE_REPOS" ]; then
  while IFS= read -r line; do
    # skip blank lines and comments
    [ -z "${line// }" ] && continue
    [ "${line#\#}" != "$line" ] && continue
    set -- $line
    if [ "${1#PKG_MANAGER=}" != "$1" ]; then
      pm=${1#PKG_MANAGER=}
      shift
      PKG_MANAGER=$pm update_repo "$@"
    else
      update_repo "$@"
    fi
  done <<< "$SDK_UPDATE_PRIVATE_REPOS"
fi

