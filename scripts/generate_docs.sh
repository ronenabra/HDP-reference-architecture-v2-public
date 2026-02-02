#!/bin/bash
# Generate static API documentation using Redoc
# This script bundles openapi.yaml into a standalone HTML file.

if ! command -v npx &> /dev/null; then
    echo "Error: npx is not installed. Please install Node.js."
    exit 1
fi

echo "Generating API documentation..."
npx -y @redocly/cli build-docs docs/openapi.yaml -o docs/api-docs.html

if [ $? -eq 0 ]; then
    echo "Success! Documentation generated at docs/api-docs.html"
else
    echo "Error generating documentation."
    exit 1
fi
