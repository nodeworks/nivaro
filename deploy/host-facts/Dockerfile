# Nivaro host facts collector as a container (no sudo on the host; the docker group is enough).
# See compose.example.yml and README.md ("Run as a container (no sudo)").
# Both bases are pinned by exact tag AND multi-arch index digest: a rebuild never picks up
# whatever the tag points at that day. Bump steps: README.md "Updating the base image".
FROM docker:27.3.1-cli@sha256:328eb399a065780c2cebe9224de003aa14084cf69efae882ac27430f921819b7 AS dockercli

FROM debian:bookworm-20261005-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash coreutils findutils gawk util-linux openssl \
    systemd rpm ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY nivaro-host-facts.sh /usr/local/bin/nivaro-host-facts.sh
RUN chmod 0755 /usr/local/bin/nivaro-host-facts.sh

ENV HOST_ROOT=/host \
  TEXTFILE_DIR=/textfile \
  HOST_FACTS_STATE_DIR=/state \
  HOST_FACTS_INTERVAL=60

# One run a minute; the slow probes inside are cached for 30 minutes in /state.
CMD ["bash", "-c", "while :; do /usr/local/bin/nivaro-host-facts.sh || echo 'nivaro-host-facts: run failed' >&2; sleep \"${HOST_FACTS_INTERVAL}\"; done"]
