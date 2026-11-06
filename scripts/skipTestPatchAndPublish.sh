
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
ROOT_DIR=$SCRIPT_DIR/..

cd $ROOT_DIR

git checkout master
git pull

git checkout master -- src/providers.json # reset file else version patching wont work
npm version patch
git push

# regen build and update providers list
rm -rf build
rm README.md

# SDK_PUBLISH_REUSE_PROVIDERS=true  -> copy providers.json from the latest published release (fast, for back-to-back releases where the list did not change)
# SDK_PUBLISH_REUSE_PROVIDERS=false -> rebuild it from chainlist + rpc health checks (the default behaviour)
# unset                             -> ask
REUSE_PROVIDERS=${SDK_PUBLISH_REUSE_PROVIDERS:-}
if [[ -z "$REUSE_PROVIDERS" ]] ; then
  read -p "Reuse providers.json from the latest published sdk instead of rebuilding it? [y/N] " _reuse
  case "$_reuse" in
    y|Y|yes|YES) REUSE_PROVIDERS=true ;;
    *) REUSE_PROVIDERS=false ;;
  esac
fi

if [[ "$REUSE_PROVIDERS" == "true" ]] ; then
  echo "Reusing providers.json from the latest published release"
  curl -sfL https://unpkg.com/@defillama/sdk@latest/build/providers.json -o src/providers.json
  if [[ $? -ne 0 ]] ; then
    echo "Failed to download providers.json"
    exit 1
  fi
else
  npm run update-providers
  if [[ $? -ne 0 ]] ; then
    echo "Failed to update providers"
    exit 1
  fi
fi

# build and verify the tarball contents before touching npm (prepublishOnly repeats this as a second guard)
npm run build
if [[ $? -ne 0 ]] ; then
  echo "Build failed, aborting publish"
  exit 1
fi
npm run verify-package
if [[ $? -ne 0 ]] ; then
  echo "Package verification failed, aborting publish"
  exit 1
fi

read -p "Ready to npm login and npm publish. Press enter to continue, Ctrl+C to abort..." _ack
npm login
npm publish
if [[ $? -ne 0 ]] ; then
  echo "npm publish failed, aborting"
  exit 1
fi

# reset the files we changed
git checkout master -- README.md
git checkout master -- src/providers.json
git push --tags

echo "Published successfully"


echo "Waiting for npm registry to update..."
sleep 600 # sleep for 10 minutes to allow npm registry to update


echo "Updating repos that depend on sdk..."
cd $SCRIPT_DIR
bash updateRepos.sh