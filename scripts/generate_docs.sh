#!/bin/bash
# Generate public and Admin HTML from pinned inputs and the installed locked renderer.
set -euo pipefail
node scripts/generate-api-docs.js
