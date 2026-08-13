#!/bin/sh

set -eu

target=${1:?usage: generate_web_auth.sh ABSOLUTE_NEW_FILE [USERNAME]}
username=${2:-owner}

case "$target" in
  /*) ;;
  *) printf 'target must be an absolute path\n' >&2; exit 64 ;;
esac
case "$username" in
  ''|*[!A-Za-z0-9._-]*) printf 'username contains unsupported characters\n' >&2; exit 64 ;;
esac
[ "${#username}" -le 64 ] || { printf 'username is too long\n' >&2; exit 64; }
[ ! -e "$target" ] || { printf 'target already exists\n' >&2; exit 73; }
[ -d "$(dirname -- "$target")" ] || { printf 'target parent does not exist\n' >&2; exit 73; }
command -v openssl >/dev/null 2>&1 || { printf 'openssl is required\n' >&2; exit 69; }

umask 077
password=$(openssl rand -base64 24 | tr '/+' '_-' | tr -d '\n')
temporary="${target}.tmp.$$"
trap 'rm -f "$temporary"' 0 1 2 15
printf '%s:%s\n' "$username" "$password" >"$temporary"
chmod 600 "$temporary"
mv "$temporary" "$target"
trap - 0 1 2 15

printf 'Created COCEAN Web credential file.\n'
printf 'Username: %s\n' "$username"
printf 'Password (shown once; store it in your password manager): %s\n' "$password"
