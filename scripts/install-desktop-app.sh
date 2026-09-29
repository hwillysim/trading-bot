#!/bin/zsh
set -eu
project_dir="${0:A:h:h}"
zsh "$project_dir/scripts/build-desktop-app.sh"
ditto "$project_dir/dist/JEV Trading Bot.app" "$HOME/Desktop/JEV Trading Bot.app"
echo "Installed $HOME/Desktop/JEV Trading Bot.app"
