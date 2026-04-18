#!/usr/bin/env bash
cd "$(dirname "$0")/.."
exec node tests/acceptance.js
