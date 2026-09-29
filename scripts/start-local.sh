#!/bin/zsh
set -eu
project_dir="${0:A:h:h}"
cd "$project_dir"
exec node --env-file-if-exists=.env --experimental-strip-types src/index.ts
