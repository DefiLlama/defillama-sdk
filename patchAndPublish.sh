git checkout master
git pull
npm version patch
git push
rm -rf build
rm LICENSE
npm publish
git checkout master -- LICENSE
git push --tags