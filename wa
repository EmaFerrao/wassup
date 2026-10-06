#!/bin/sh
# Launch the client from any directory.
cd "$(dirname "$(readlink -f "$0")")" && exec node_modules/.bin/tsx src/main.ts "$@"
