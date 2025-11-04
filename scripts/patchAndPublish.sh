SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
ROOT_DIR=$SCRIPT_DIR/..

cd $ROOT_DIR

git checkout master
git pull
npm run update-providers
npm run test
if [[ $? -ne 0 ]] ; then
  echo "Unit test failed, fix it before publishing new version"
  exit 1
fi
git checkout master -- src/providers.json # reset file else version patching wont work
npm version patch
git push
rm -rf build
rm LICENSE
npm run update-providers
if [[ $? -ne 0 ]] ; then
  echo "Providers update failed, fix it before publishing new version"
  exit 1
fi
npm publish
git checkout master -- LICENSE
git checkout master -- src/providers.json
git push --tags