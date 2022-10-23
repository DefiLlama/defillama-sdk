git checkout master
git pull
npm version patch
git push
rm -rf build
npm publish