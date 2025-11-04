SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
ROOT_DIR=$SCRIPT_DIR/..

cd $ROOT_DIR

mkdir -p depRepos
cd depRepos

echo "Update tvl repo"

[ ! -d "DefiLlama-Adapters" ] && git clone git@github.com:DefiLlama/DefiLlama-Adapters.git

cd DefiLlama-Adapters
git stash
git checkout main
git pull
pnpm i
pnpm update @defillama/sdk
git add package.json pnpm-lock.yaml
git commit -m "update @defillama/sdk version"
git push
cd ..


echo "Update dimension repo"

[ ! -d "dimension-adapters" ] && git clone git@github.com:DefiLlama/dimension-adapters.git

cd dimension-adapters
git stash
git checkout master
git pull
pnpm i
pnpm update @defillama/sdk
git add package.json pnpm-lock.yaml
git commit -m "update @defillama/sdk version"
git push
cd ..


echo "Update server repo"

[ ! -d "defillama-server" ] && git clone git@github.com:DefiLlama/defillama-server.git

cd defillama-server
git stash
git checkout master
git pull
cd defi
pnpm i
pnpm update @defillama/sdk
git add package.json pnpm-lock.yaml

cd ../coins
pnpm i
pnpm update @defillama/sdk
git add package.json pnpm-lock.yaml

git commit -m "update @defillama/sdk version"
git push


