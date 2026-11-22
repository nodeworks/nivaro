#!/bin/sh
# Deploy one environment of a Nivaro Hub app to a Docker swarm. Runs in the GitLab `deploy`
# job (docker:cli image) on an environment branch that carries .hub/app.env.
#
#   1. read .hub/app.env — exactly the app settings below, any other line stops the deploy
#      (it is never sourced: a value is data, never shell)
#   2. read the pin (.hub/nivaro-version): line 1 version, line 2 image digest
#   3. open ONE ssh connection to DEPLOY_HOST (a swarm manager) and forward its Docker socket
#   4. turn each NIVARO_*_B64 CI variable into an immutable swarm secret
#      <STACK_NAME>_<name>_<sha8 of the value> (a new value = a new secret name)
#   5. docker stack deploy docker-stack.yml, wait for the services to converge
#   6. wait until web answers /api/version with the pinned version, inside the stack network
#
# CI variables it reads (none is ever printed):
#   DEPLOY_HOST           project variable the Hub sets: host, user@host or host:port
#   DEPLOY_SSH_KEY        group variable (file or text): the deploy user's private key
#   DEPLOY_KNOWN_HOSTS    optional group variable (file or text): the manager's host keys;
#                         without it the first connection learns the key (accept-new)
#   NIVARO_DB_URL_B64, NIVARO_HUB_TOKEN_B64, NIVARO_SESSION_SECRET_B64,
#   NIVARO_ENCRYPTION_KEY_B64, NIVARO_OIDC_CLIENT_SECRET_B64
#                         masked, protected, scoped to this environment (the Hub sets them)
#   HUB_PIN_FILE          optional, default .hub/nivaro-version
#   HUB_IMAGE             optional, default nodeworks/nivaro
#   TRAEFIK_ENTRYPOINT    optional, default websecure (https) / web (http)
#   DEPLOY_DOCKER_SOCKET  optional, default /var/run/docker.sock on the manager
#   DEPLOY_WAIT_TRIES     optional, default 40 (x 15 s) for /api/version
set -eu
# No globbing: hostnames and keys are split on commas / spaces below.
set -f

APP_ENV_FILE=.hub/app.env
PIN_FILE=${HUB_PIN_FILE:-.hub/nivaro-version}
IMAGE_REPO=${HUB_IMAGE:-nodeworks/nivaro}
REMOTE_SOCKET=${DEPLOY_DOCKER_SOCKET:-/var/run/docker.sock}
WAIT_TRIES=${DEPLOY_WAIT_TRIES:-40}

# Twin of HUB_APP_ENV_KEYS in api/src/services/hub/create/app-config.ts.
APP_ENV_KEYS="APP_KEY ENV_KEY STACK_NAME APP_HOSTS PUBLIC_URL ADMIN_URL HUB_URL NIVARO_ENVIRONMENT DB_CLIENT OIDC_ISSUER OIDC_CLIENT_ID OIDC_REDIRECT_URI PROXY_NETWORK TRUST_PROXY"
# Twin of HUB_SECRET_FILES: <CI variable>:<swarm secret short name>.
SECRET_VARS="NIVARO_DB_URL_B64:db_url NIVARO_HUB_TOKEN_B64:hub_token NIVARO_SESSION_SECRET_B64:session_secret NIVARO_ENCRYPTION_KEY_B64:encryption_key NIVARO_OIDC_CLIENT_SECRET_B64:oidc_secret"

say() { printf 'deploy: %s\n' "$*"; }
die() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

# ── 1. settings ─────────────────────────────────────────────────────────────
[ -s "$APP_ENV_FILE" ] || die "no $APP_ENV_FILE on this branch: nothing to deploy"
CR=$(printf '\r')
seen=' '
while IFS= read -r line || [ -n "$line" ]; do
  case $line in '' | '#'*) continue ;; esac
  key=${line%%=*}
  [ "$key" != "$line" ] || die "$APP_ENV_FILE: a line without '=' (refusing)"
  case $key in '' | *[!A-Z0-9_]*) die "$APP_ENV_FILE: a line that is not KEY=value (refusing)" ;; esac
  case " $APP_ENV_KEYS " in
    *" $key "*) ;;
    *) die "$APP_ENV_FILE: $key is not an app setting (refusing)" ;;
  esac
  case $seen in *" $key "*) die "$APP_ENV_FILE: $key appears twice (refusing)" ;; esac
  seen="$seen$key "
  value=${line#*=}
  case $value in *"$CR"*) die "$APP_ENV_FILE: $key holds a carriage return (refusing)" ;; esac
  [ -n "$value" ] || die "$APP_ENV_FILE: $key is empty"
  export "$key=$value"
done <"$APP_ENV_FILE"
for key in $APP_ENV_KEYS; do
  case $seen in *" $key "*) ;; *) die "$APP_ENV_FILE has no $key" ;; esac
done

case $STACK_NAME in [a-z]*) ;; *) die "STACK_NAME must start with a letter" ;; esac
case $STACK_NAME in *[!a-z0-9-]*) die "STACK_NAME may hold a-z, 0-9 and - only" ;; esac
[ "${#STACK_NAME}" -le 40 ] || die "STACK_NAME is longer than 40 characters"
case $APP_KEY in '' | *[!a-z0-9-]*) die "APP_KEY is not a Hub key" ;; esac
case $ENV_KEY in '' | *[!a-z0-9-]*) die "ENV_KEY is not a Hub key" ;; esac
# An app.env copied onto another branch must not deploy that other environment's stack.
if [ -n "${CI_COMMIT_REF_NAME:-}" ] && [ "$ENV_KEY" != "$CI_COMMIT_REF_NAME" ]; then
  die "ENV_KEY $ENV_KEY does not match branch $CI_COMMIT_REF_NAME (refusing)"
fi
case $DB_CLIENT in mssql | pg | mysql2 | mariadb) ;; *) die "DB_CLIENT $DB_CLIENT is not supported" ;; esac
case $PROXY_NETWORK in [A-Za-z0-9]*) ;; *) die "PROXY_NETWORK is not a network name" ;; esac
case $PROXY_NETWORK in *[!A-Za-z0-9_.-]*) die "PROXY_NETWORK is not a network name" ;; esac
case $PUBLIC_URL in
  https://*) TRAEFIK_TLS=true entrypoint=websecure ;;
  http://*) TRAEFIK_TLS=false entrypoint=web ;;
  *) die "PUBLIC_URL must be an http(s) URL" ;;
esac
TRAEFIK_ENTRYPOINT=${TRAEFIK_ENTRYPOINT:-$entrypoint}
case $TRAEFIK_ENTRYPOINT in '' | *[!A-Za-z0-9_-]*) die "TRAEFIK_ENTRYPOINT is not a name" ;; esac

# Traefik rule: Host(`a`) || Host(`b`) — only plain hostnames reach it.
TRAEFIK_RULE=
old_ifs=$IFS
IFS=,
for h in $APP_HOSTS; do
  case $h in
    '' | [-.]* | *[-.] | *..* | *[!a-z0-9.-]*) die "APP_HOSTS: '$h' is not a hostname" ;;
  esac
  TRAEFIK_RULE="${TRAEFIK_RULE:+$TRAEFIK_RULE || }Host(\`$h\`)"
done
IFS=$old_ifs
[ -n "$TRAEFIK_RULE" ] || die "APP_HOSTS is empty"

# ── 2. pin ──────────────────────────────────────────────────────────────────
[ -s "$PIN_FILE" ] || die "no $PIN_FILE pin (refusing to deploy)"
VERSION=$(sed -n 1p "$PIN_FILE" | tr -d '[:space:]')
DIGEST=$(sed -n 2p "$PIN_FILE" | tr -d '[:space:]')
[ "$VERSION" != latest ] || die "$PIN_FILE pins latest (refusing)"
case $VERSION in '' | *[!0-9A-Za-z.+-]*) die "$PIN_FILE line 1 is not a version" ;; esac
case $IMAGE_REPO in '' | -* | *[!a-z0-9./_:-]*) die "HUB_IMAGE is not an image name" ;; esac
case $DIGEST in
  sha256:*)
    hex=${DIGEST#sha256:}
    case $hex in *[!0-9a-f]*) die "$PIN_FILE line 2 is not an image digest" ;; esac
    [ "${#hex}" -eq 64 ] || die "$PIN_FILE line 2 is not an image digest"
    NIVARO_IMAGE_REF="$IMAGE_REPO@$DIGEST"
    ;;
  '')
    # pinText leaves the digest out when the registry did not give one.
    say "warning: $PIN_FILE has no digest; deploying the tag $VERSION"
    NIVARO_IMAGE_REF="$IMAGE_REPO:$VERSION"
    ;;
  *) die "$PIN_FILE line 2 is not an image digest" ;;
esac
say "stack $STACK_NAME, image $NIVARO_IMAGE_REF, hosts $APP_HOSTS"

# ── 3. one ssh connection to the manager ────────────────────────────────────
# DEPLOY_HOST is only ever an ssh destination: checked here, quoted, always after `--`.
case "$DEPLOY_HOST" in
  '' | -* | *@*@* | *[!A-Za-z0-9@._:-]*) die "DEPLOY_HOST must be host, user@host or host:port" ;;
esac
DEST="ssh://$DEPLOY_HOST"

umask 077
WORK=$(mktemp -d)
CTL="$WORK/ctl"
LOCAL_SOCKET="$WORK/docker.sock"
cleanup() {
  if [ -S "$CTL" ]; then
    ssh -S "$CTL" -O exit -- "$DEST" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

[ -n "${DEPLOY_SSH_KEY:-}" ] || die "DEPLOY_SSH_KEY is not set (a group CI variable)"
if [ -f "$DEPLOY_SSH_KEY" ]; then cp "$DEPLOY_SSH_KEY" "$WORK/key"; else printf '%s\n' "$DEPLOY_SSH_KEY" >"$WORK/key"; fi
HOSTKEYS=accept-new
if [ -n "${DEPLOY_KNOWN_HOSTS:-}" ]; then
  if [ -f "$DEPLOY_KNOWN_HOSTS" ]; then cp "$DEPLOY_KNOWN_HOSTS" "$WORK/known_hosts"; else printf '%s\n' "$DEPLOY_KNOWN_HOSTS" >"$WORK/known_hosts"; fi
  HOSTKEYS=yes
else
  : >"$WORK/known_hosts"
  say "warning: DEPLOY_KNOWN_HOSTS is not set; trusting the manager's host key on first use"
fi

ssh -i "$WORK/key" -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile="$WORK/known_hosts" -o StrictHostKeyChecking="$HOSTKEYS" -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes -M -S "$CTL" -f -N -L "$LOCAL_SOCKET:$REMOTE_SOCKET" -- "$DEST" ||
  die "cannot reach the swarm manager over SSH"
export DOCKER_HOST="unix://$LOCAL_SOCKET"

state=$(docker info --format '{{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}' 2>/dev/null || true)
[ "$state" = "active true" ] || die "DEPLOY_HOST is not a swarm manager (state: ${state:-unknown})"
docker network inspect "$PROXY_NETWORK" >/dev/null 2>&1 ||
  die "the proxy network $PROXY_NETWORK does not exist on the swarm"

# A stack of this name that another app or environment owns is never deployed over.
for svc in $(docker service ls --filter "label=com.docker.stack.namespace=$STACK_NAME" --format '{{.Name}}'); do
  owner=$(docker service inspect --format '{{index .Spec.Labels "nivaro.hub.app"}}/{{index .Spec.Labels "nivaro.hub.env"}}' "$svc")
  [ "$owner" = "$APP_KEY/$ENV_KEY" ] || die "stack $STACK_NAME already runs $svc for another app (refusing)"
done

# ── 4. secrets ──────────────────────────────────────────────────────────────
for pair in $SECRET_VARS; do
  var=${pair%%:*}
  short=${pair#*:}
  b64=$(printenv "$var" || true)
  [ -n "$b64" ] || die "$var is not set for environment $ENV_KEY"
  value=$(printf '%s' "$b64" | base64 -d 2>/dev/null) || die "$var is not base64"
  [ -n "$value" ] || die "$var is empty"
  sha8=$(printf '%s' "$value" | sha256sum | cut -c1-8)
  name="${STACK_NAME}_${short}_${sha8}"
  if ! docker secret inspect "$name" >/dev/null 2>&1; then
    say "new secret $name"
    printf '%s' "$value" | docker secret create --label "nivaro.hub.stack=$STACK_NAME" "$name" -
  fi
  value=
  b64=
  upper=$(printf '%s' "$short" | tr 'a-z' 'A-Z')
  export "SECRET_$upper=$name"
done

# ── 5. deploy ───────────────────────────────────────────────────────────────
export NIVARO_IMAGE_REF TRAEFIK_RULE TRAEFIK_TLS TRAEFIK_ENTRYPOINT
docker stack deploy --detach=false --resolve-image always -c docker-stack.yml "$STACK_NAME"

# ── 6. wait for the pinned version, from inside the stack network ───────────
tries=0
while :; do
  out=$(docker run --rm --network "${STACK_NAME}_internal" --read-only --cap-drop ALL \
    --security-opt no-new-privileges --entrypoint wget "$NIVARO_IMAGE_REF" \
    -q -T 5 -O - http://web:3055/api/version 2>/dev/null || true)
  case $out in *"\"version\":\"$VERSION\""*) break ;; esac
  tries=$((tries + 1))
  [ "$tries" -lt "$WAIT_TRIES" ] || die "web did not answer /api/version with $VERSION"
  sleep 15
done
# Secrets of earlier values stay: a `docker service rollback` needs the previous ones. They
# carry the label nivaro.hub.stack=<STACK_NAME>; README.md says how to clear old ones.
say "done: web answers $VERSION"
