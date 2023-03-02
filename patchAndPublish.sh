git checkout master
git pull
ts-node src/util/updateProviderList.ts
npm run test
if [[ $? -ne 0 ]] ; then
  echo "Unit test failed, fix it before publishing new version"
  exit 1
fi
npm version patch
git push
rm -rf build
rm LICENSE
npm publish
git checkout master -- LICENSE
git checkout master -- src/providers.json
git push --tags