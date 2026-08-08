#!/usr/bin/env bash
set -Eeuo pipefail

# Static validation; unlike migrate.sh this does not contact PostgreSQL.

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
migrations_dir="$script_dir/migrations"
fail() {
    printf 'database validation error: %s\n' "$1" >&2
    exit 1
}

[[ -d "$migrations_dir" ]] || fail "migration directory is missing"
mapfile -t files < <(find "$migrations_dir" -maxdepth 1 -type f -name '*.sql' -print | sort -V)
((${#files[@]} > 0)) || fail "no SQL migrations found"

previous=''
for file in "${files[@]}"; do
    name=${file##*/}
    [[ "$name" =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ ]] || fail "invalid migration filename: $name"
    version=${name%.sql}
    [[ -z "$previous" || "$version" > "$previous" ]] || fail "migration versions are not strictly ordered: $name"
    previous=$version

    grep -Eq '^BEGIN;[[:space:]]*$' "$file" || fail "$name must begin a transaction"
    grep -Eq '^COMMIT;[[:space:]]*$' "$file" || fail "$name must commit its transaction"
    grep -q 'schema_migrations' "$file" || fail "$name must use schema_migrations"
    grep -q "VALUES ('$version')" "$file" || fail "$name must record version $version"
    if sed '/^[[:space:]]*--/d' "$file" \
        | grep -Eiq 'sqlite|password[[:space:]]*=[[:space:]]*['"'"'][^'"'"']+|livekit_api_secret[[:space:]]*='; then
        fail "$name contains a prototype database reference or credential literal"
    fi
done

[[ -x "$script_dir/migrate.sh" ]] || fail 'migrate.sh must be executable'
printf 'Static database validation passed (%d migration%s)\n' "${#files[@]}" "$([[ ${#files[@]} -eq 1 ]] && printf '' || printf 's')"
