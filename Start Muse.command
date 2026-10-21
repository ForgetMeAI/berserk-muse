#!/bin/zsh
set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
node scripts/start.mjs --login
node scripts/panel.mjs
printf '\nПанель Muse открыта. Добавьте или проверьте аккаунт в ней.\n'
printf 'После входа запустите Agent.command или npm run agent.\n'
printf '\nДля закрытия этой вкладки нажмите Enter.\n'
read -r
