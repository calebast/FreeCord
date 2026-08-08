#!/usr/bin/env bash
set -Eeuo pipefail

# Dependency-free PostgreSQL migration runner for FreeCord.
# The only runtime dependency is the PostgreSQL client (`psql`).

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
migrations_dir="$script_dir/migrations"

usage() {
    cat <<'EOF'
Usage:
  database/migrate.sh [--init-community NAME [--slug SLUG]]

Environment:
  DATABASE_URL  PostgreSQL connection URL or libpq connection string (required)

The runner applies pending SQL files in database/migrations and verifies that
each migration records its own version in public.schema_migrations. With
--init-community it creates the single community if the database is empty, or
verifies the existing community has the requested name and slug.
EOF
}

fail() {
    printf 'database migration error: %s\n' "$1" >&2
    exit 1
}

[[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL is required"
command -v psql >/dev/null 2>&1 || fail "psql is required but was not found"
[[ -d "$migrations_dir" ]] || fail "migration directory is missing: $migrations_dir"

init_name=''
init_slug=''
while (($#)); do
    case "$1" in
        --init-community)
            (($# >= 2)) || fail "--init-community requires a name"
            init_name=$2
            shift 2
            ;;
        --slug)
            (($# >= 2)) || fail "--slug requires a value"
            init_slug=$2
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            fail "unknown argument: $1"
            ;;
    esac
done

if [[ -n "$init_slug" && -z "$init_name" ]]; then
    fail "--slug may only be used with --init-community"
fi

if [[ -n "$init_name" ]]; then
    [[ ${#init_name} -ge 1 && ${#init_name} -le 100 ]] || fail "community name must be 1-100 characters"
    [[ "$init_name" != *$'\n'* && "$init_name" != *$'\r'* ]] || fail "community name must not contain newlines"
    if [[ -z "$init_slug" ]]; then
        init_slug=$(printf '%s' "$init_name" \
            | LC_ALL=C tr '[:upper:]' '[:lower:]' \
            | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
    fi
    [[ "$init_slug" =~ ^[a-z0-9]+([a-z0-9-]*[a-z0-9])?$ ]] || fail "community slug must contain only lowercase letters, numbers, and internal hyphens"
    [[ ${#init_slug} -le 100 ]] || fail "community slug must be at most 100 characters"
fi

# psql variable interpolation is not available in every supported client
# invocation mode. The values above are validated; escape names before using
# them as SQL string literals.
sql_init_name=$(printf '%s' "$init_name" | sed "s/'/''/g")
sql_init_slug=$(printf '%s' "$init_slug" | sed "s/'/''/g")

psql_query() {
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atq "$@"
}

mapfile -t migration_files < <(find "$migrations_dir" -maxdepth 1 -type f -name '*.sql' -print | sort -V)
((${#migration_files[@]} > 0)) || fail "no SQL migrations found"

declare -A applied=()
schema_migrations_exists=$(psql_query -c "SELECT to_regclass('public.schema_migrations') IS NOT NULL;")
if [[ "$schema_migrations_exists" == 't' ]]; then
    while IFS= read -r version; do
        [[ -n "$version" ]] && applied["$version"]=1
    done < <(psql_query -c 'SELECT version FROM public.schema_migrations ORDER BY version;')
fi

for migration in "${migration_files[@]}"; do
    filename=${migration##*/}
    [[ "$filename" =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ ]] || fail "invalid migration filename: $filename"
    version=${filename%.sql}

    if [[ -n "${applied[$version]:-}" ]]; then
        continue
    fi

    printf 'Applying migration %s\n' "$version"
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$migration" >/dev/null

    recorded=$(psql_query -c "SELECT 1 FROM public.schema_migrations WHERE version = '$version' LIMIT 1;")
    [[ "$recorded" == '1' ]] || fail "migration $version completed without recording its version"
    applied["$version"]=1
done

if [[ -n "$init_name" ]]; then
    community_count=$(psql_query -c 'SELECT count(*) FROM public.communities;')
    case "$community_count" in
        0)
            printf 'Initializing the single community\n'
            psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
                -c "WITH community AS (INSERT INTO public.communities (name, slug) VALUES ('$sql_init_name', '$sql_init_slug') RETURNING id), text_channel AS (INSERT INTO public.channels (community_id, name, type, position) SELECT id, 'general', 'text', 0 FROM community), voice_channel AS (INSERT INTO public.channels (community_id, name, type, position) SELECT id, 'General Voice', 'voice', 0 FROM community RETURNING id, community_id) INSERT INTO public.voice_channel_bindings (community_id, channel_id, livekit_room_id) SELECT community_id, id, 'general-voice' FROM voice_channel;" \
                >/dev/null
            printf 'Created default channels; voice channel ID: '
            psql_query -c "SELECT id FROM public.channels WHERE type = 'voice' ORDER BY created_at, id LIMIT 1;"
            ;;
        1)
            matches=$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atq \
                -c "SELECT 1 FROM public.communities WHERE name = '$sql_init_name' AND slug = '$sql_init_slug';")
            [[ "$matches" == '1' ]] || fail "one community already exists with a different name or slug"
            printf 'Single community already initialized\n'
            ;;
        *)
            fail "database contains more than one community"
            ;;
    esac
    # Default channels belong only to first initialization. On later starts,
    # administrators may have renamed or archived them; startup must preserve
    # that authoritative state instead of trying to recreate reserved names or
    # the original LiveKit room binding.
    printf 'First active voice channel ID: '
    psql_query -c "SELECT c.id FROM public.channels c JOIN public.communities co ON co.id = c.community_id WHERE co.slug = '$sql_init_slug' AND c.type = 'voice' AND NOT c.is_archived ORDER BY c.position, c.created_at, c.id LIMIT 1;"
fi

printf 'Database migrations are up to date\n'
