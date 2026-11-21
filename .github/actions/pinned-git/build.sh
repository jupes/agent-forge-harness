#!/bin/sh
set -eu

# Both job containers see the checkout. Stage the full installation there so
# Git's compiled helper and template paths are valid in the browser container.
stage="$GITHUB_WORKSPACE/.tmp/browser-git-stage"
mkdir -p "$GITHUB_WORKSPACE/.tmp"
mkdir "$stage"
build=$(mktemp -d)
archive="$build/git-2.55.1.tar.xz"
prlimit --fsize=33554432:33554432 -- curl --fail --silent --show-error \
  --location --max-redirs 3 --proto '=https' --tlsv1.2 --max-time 60 \
  --max-filesize 33554432 --output "$archive" https://www.kernel.org/pub/software/scm/git/git-2.55.1.tar.xz
printf '%s  %s\n' '7bc345dba23c9089fa71bcf4e793d13d204fdc99b96abc118b3a29c18159eb16' "$archive" | sha256sum --check --strict
mkdir "$build/source"
tar -xJf "$archive" -C "$build/source" --strip-components=1 --no-same-owner
timeout --kill-after=5s 180s make -C "$build/source" -j2 \
  prefix=/opt/forge-git-2.55.1 DESTDIR="$stage" \
  NO_RUST=YesPlease NO_TCLTK=YesPlease NO_GETTEXT=YesPlease NO_CURL=YesPlease \
  NO_EXPAT=YesPlease NO_OPENSSL=YesPlease NO_PERL=YesPlease install
