#!/bin/sh
set -eu
umask 077

state_dir=${FREECORD_STATE_DIR:-/run/freecord-state}
manifest="$state_dir/manifest-v1"
completion="$state_dir/complete-v1"

[ -s "$manifest" ] || {
  printf 'FreeCord configuration finalization failed: initialization manifest is unavailable\n' >&2
  exit 1
}

exec 9>"$state_dir/.init.lock"
flock -n 9 || {
  printf 'FreeCord configuration finalization failed: initializer is still running\n' >&2
  exit 1
}

if [ ! -s "$completion" ]; then
  installation_id=$(sed -n 's/^installation_id=//p' "$manifest")
  [ -n "$installation_id" ] || {
    printf 'FreeCord configuration finalization failed: installation identity is unavailable\n' >&2
    exit 1
  }
  printf 'version=1\ninstallation_id=%s\n' "$installation_id" >"$state_dir/.complete-next"
  chmod 0400 "$state_dir/.complete-next"
  mv "$state_dir/.complete-next" "$completion"
fi

printf 'FreeCord persistent installation initialization is complete.\n'
